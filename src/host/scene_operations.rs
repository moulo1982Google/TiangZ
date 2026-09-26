//! 统一远程批次的绝对期限、有限执行槽和未开始项到期处理。 / Owns absolute batch deadlines, bounded execution slots and expiry of unstarted operations.

use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::future::Future;
use std::sync::OnceLock;
use std::time::Duration;

use deno_error::JsErrorBox;
use futures_util::{StreamExt, stream::FuturesUnordered};
use tokio::time::{Instant, sleep_until, timeout_at};

use super::{HostSceneCompletion, HostSceneCompletionSink, HostSceneOperation};
use crate::transport::{call_remote_scene, record_host_scene_timeout, send_remote_scene};

const MAX_RUNNING: usize = 256;
static CLOCK_ORIGIN: OnceLock<std::time::Instant> = OnceLock::new();

/// 返回共享起点以来向下取整的单调毫秒，不能持久化为墙钟。 / Returns floored monotonic milliseconds from a shared origin, never a persistable wall clock.
pub(super) fn now_ms() -> f64 {
    CLOCK_ORIGIN
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_millis() as f64
}

/// 还原打包前采样的绝对时刻，将复制和解码耗时留在预算内。 / Restores the pre-pack sample as an absolute instant, retaining copy and decode time in the budget.
pub(super) fn submitted_at(sampled_ms: f64) -> Result<Instant, JsErrorBox> {
    let now = now_ms();
    if !sampled_ms.is_finite()
        || sampled_ms.fract() != 0.0
        || sampled_ms < 0.0
        || sampled_ms > now
        || sampled_ms > 9_007_199_254_740_991.0
    {
        return Err(JsErrorBox::generic("invalid host scene submission clock"));
    }
    CLOCK_ORIGIN
        .get()
        .unwrap()
        .checked_add(Duration::from_millis(sampled_ms as u64))
        .map(Instant::from_std)
        .ok_or_else(|| JsErrorBox::generic("host scene submission clock overflow"))
}

pub(super) struct ScheduledOperation {
    pub(super) operation: HostSceneOperation,
    pub(super) deadline: Instant,
}

/// 每批最多 256 个网络操作，sleep 与排队过期不竞争这些槽。 / Limits each batch to 256 network operations while sleeps and queued expiry use independent timing.
pub(super) async fn run(
    operations: Vec<HostSceneOperation>,
    sink: HostSceneCompletionSink,
    submitted: Instant,
) {
    run_with_executor(operations, sink, submitted, execute).await;
}

/// 以原批次槽保存未执行工作；调度或到期只转移一次所有权。 / Retains unstarted work in its original bounded slots and transfers ownership once on launch or expiry.
pub(super) async fn run_with_executor<F, Fut>(
    operations: Vec<HostSceneOperation>,
    sink: HostSceneCompletionSink,
    submitted: Instant,
    mut execute: F,
) where
    F: FnMut(ScheduledOperation) -> Fut,
    Fut: Future<Output = Option<HostSceneCompletion>>,
{
    let mut expirations = BinaryHeap::with_capacity(operations.len());
    let mut slots: Vec<_> = operations
        .into_iter()
        .enumerate()
        .map(|(index, operation)| {
            let ms = if operation.kind == 3 {
                operation.timeout_ms
            } else {
                operation.timeout_ms.max(1)
            };
            let deadline = submitted + Duration::from_millis(u64::from(ms));
            expirations.push(Reverse((deadline, index)));
            Some(ScheduledOperation {
                operation,
                deadline,
            })
        })
        .collect();
    let mut queued = slots.len();
    let mut next_launch = 0;
    let mut running = FuturesUnordered::new();
    while queued > 0 || !running.is_empty() {
        while let Some(Reverse((deadline, index))) = expirations.peek().copied() {
            if slots[index].is_none() {
                expirations.pop();
                continue;
            }
            if deadline > Instant::now() {
                break;
            }
            expirations.pop();
            let job = slots[index].take().unwrap();
            queued -= 1;
            if let Some(completion) = expire(job) {
                deliver(&sink, completion).await;
            }
        }
        while running.len() < MAX_RUNNING && next_launch < slots.len() {
            let index = next_launch;
            next_launch += 1;
            if slots[index]
                .as_ref()
                .is_none_or(|job| job.operation.kind == 3)
            {
                continue;
            }
            let job = slots[index].take().unwrap();
            queued -= 1;
            if job.deadline <= Instant::now() {
                if let Some(completion) = expire(job) {
                    deliver(&sink, completion).await;
                }
            } else {
                running.push(execute(job));
            }
        }
        if queued == 0 && running.is_empty() {
            break;
        }
        let next_deadline = expirations.peek().map(|entry| entry.0.0);
        tokio::select! {
            _ = sleep_until(next_deadline.unwrap_or_else(Instant::now)), if next_deadline.is_some() => {},
            completion = running.next(), if !running.is_empty() => {
                if let Some(Some(completion)) = completion { deliver(&sink, completion).await; }
            },
        }
    }
}

/// 完成通知保留现有控制背压；不以无界队列或丢失回复绕过。 / Preserves completion-channel backpressure without unbounded buffering or dropped replies.
async fn deliver(sink: &HostSceneCompletionSink, mut completion: HostSceneCompletion) {
    loop {
        match sink(completion) {
            Ok(()) => return,
            Err(returned) => {
                completion = returned;
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        }
    }
}

/// 已过期工作不再进入传输，正常 sleep 到期不记为失败。 / Prevents expired work from entering transport and treats normal sleep expiry as success.
fn expire(job: ScheduledOperation) -> Option<HostSceneCompletion> {
    let operation = job.operation;
    if operation.kind != 3 {
        if let Some(route) = &operation.route {
            record_host_scene_timeout(
                &route.source_name,
                &route.target_name,
                &operation.frame,
                operation.kind == 2,
                "host_queue",
            );
        }
        if operation.kind == 2 {
            return None;
        }
    }
    Some(HostSceneCompletion {
        operation_id: operation.operation_id,
        result: if operation.kind == 3 {
            Ok(Vec::new())
        } else {
            Err("host scene operation timed out before dispatch".into())
        },
    })
}

/// 活动操作继续使用原截止时间；超时停止等待，但不假装撤回对端已收到的帧。 / Active operations retain their original deadline; timeout stops waiting without recalling peer-received frames.
async fn execute(job: ScheduledOperation) -> Option<HostSceneCompletion> {
    if job.deadline <= Instant::now() {
        return expire(job);
    }
    let ScheduledOperation {
        operation,
        deadline,
    } = job;
    match (operation.kind, operation.route) {
        (1, Some(route)) => {
            let result = timeout_at(
                deadline,
                call_remote_scene(
                    route.source_name,
                    route.target_name,
                    route.target_ip,
                    route.target_port,
                    operation.frame,
                    deadline,
                ),
            )
            .await
            .unwrap_or_else(|_| Err("host scene call timed out awaiting transport".into()));
            Some(HostSceneCompletion {
                operation_id: operation.operation_id,
                result,
            })
        }
        (2, Some(route)) => {
            let source = route.source_name.clone();
            let target = route.target_name.clone();
            let frame = operation.frame.clone();
            let result = timeout_at(
                deadline,
                send_remote_scene(
                    route.source_name,
                    route.target_name,
                    route.target_ip,
                    route.target_port,
                    operation.frame,
                    deadline,
                ),
            )
            .await;
            match result {
                Err(_) => record_host_scene_timeout(&source, &target, &frame, true, "host_wait"),
                Ok(Err(error)) if !error.starts_with("[scene-overloaded]") => {
                    tracing::error!(target: "tiangz::scene", source = %source, target_scene = %target, error = %error, "one-way scene send failed");
                }
                _ => {}
            }
            None
        }
        _ => Some(HostSceneCompletion {
            operation_id: operation.operation_id,
            result: Err("invalid host scene operation route".into()),
        }),
    }
}
