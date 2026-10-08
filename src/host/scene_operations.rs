//! 统一远程批次的绝对期限、有限执行槽和未开始项到期处理。 / Owns absolute batch deadlines, bounded execution slots and expiry of unstarted operations.

use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::future::Future;
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicU64, AtomicUsize, Ordering},
};
use std::time::Duration;

use deno_error::JsErrorBox;
use futures_util::{StreamExt, stream::FuturesUnordered};
use tokio::time::{Instant, sleep_until, timeout_at};

use super::{HostSceneCompletion, HostSceneCompletionSink, HostSceneOperation};
use crate::transport::{call_remote_scene, record_host_scene_timeout, send_remote_scene};

const MAX_RUNNING: usize = 256;
static CLOCK_ORIGIN: OnceLock<std::time::Instant> = OnceLock::new();

pub(crate) struct BatchAdmission {
    capacity: usize,
    reserved: AtomicUsize,
    peak: AtomicUsize,
    rejections: AtomicU64,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct BatchAdmissionSnapshot {
    pub(crate) reserved_slots: u64,
    pub(crate) max_reserved_slots: u64,
    pub(crate) capacity: u64,
    pub(crate) rejections: u64,
}

pub(super) struct BatchReservation {
    owner: Arc<BatchAdmission>,
    slots: usize,
}

impl BatchAdmission {
    /// 所有批次共享现有单批上限，不创建等待准入队列。 / Shares the existing batch limit across all retained batches without an admission wait queue.
    pub(crate) fn new() -> Arc<Self> {
        Self::with_capacity(super::HOST_SCENE_MAX_OPERATIONS)
    }

    fn with_capacity(capacity: usize) -> Arc<Self> {
        Arc::new(Self {
            capacity,
            reserved: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
            rejections: AtomicU64::new(0),
        })
    }

    /// 原子预留整个批次容器，失败只拒绝本批；峰值按成功准入的真实计数记录。 / Atomically reserves whole-batch containers, rejecting only this batch and recording the actual admitted peak.
    pub(super) fn try_reserve(self: &Arc<Self>, slots: usize) -> Option<BatchReservation> {
        let admitted = self
            .reserved
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |used| {
                used.checked_add(slots)
                    .filter(|next| *next <= self.capacity && slots > 0)
            });
        match admitted {
            Ok(previous) => {
                self.peak.fetch_max(previous + slots, Ordering::Relaxed);
                Some(BatchReservation {
                    owner: Arc::clone(self),
                    slots,
                })
            }
            Err(_) => {
                self.rejections.fetch_add(1, Ordering::Relaxed);
                None
            }
        }
    }

    /// 各字段近似同时采样；保留槽不是活跃 RPC 或堆内存计数。 / Samples fields approximately together; reserved slots are neither active RPCs nor heap bytes.
    pub(crate) fn snapshot(&self) -> BatchAdmissionSnapshot {
        BatchAdmissionSnapshot {
            reserved_slots: self.reserved.load(Ordering::Relaxed) as u64,
            max_reserved_slots: self.peak.load(Ordering::Relaxed) as u64,
            capacity: self.capacity as u64,
            rejections: self.rejections.load(Ordering::Relaxed),
        }
    }
}

impl Drop for BatchReservation {
    /// 整批 Future/容器真实销毁时归还原 Process，取消和 panic 同样适用。 / Returns slots to the original Process when the batch future and containers are destroyed, including cancellation and panic.
    fn drop(&mut self) {
        self.owner.reserved.fetch_sub(self.slots, Ordering::Relaxed);
    }
}

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
            let mut job = slots[index].take().unwrap();
            queued -= 1;
            if job.deadline <= Instant::now() {
                if let Some(completion) = expire(job) {
                    deliver(&sink, completion).await;
                }
            } else {
                let reservation = job.operation.backing_reservation.take();
                let work = execute(job);
                running.push(async move {
                    let mut completion = work.await;
                    if let Some(completion) = &mut completion {
                        completion.backing_reservation = reservation;
                    }
                    completion
                });
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
    // 错误是诊断文本，不允许挤占成功回复已预留的空间。 / Errors are diagnostic text and cannot exceed the reserved reply space.
    if let Err(error) = &mut completion.result {
        const LIMIT: usize = 4096;
        const SUFFIX: &str = " [truncated]";
        if error.len() > LIMIT {
            let mut end = LIMIT - SUFFIX.len();
            while !error.is_char_boundary(end) {
                end -= 1;
            }
            // truncate 会保留原大容量；替换所有者后才能缩减驻留预留。 / Truncate retains the old capacity; replace its owner before shrinking the reservation.
            let mut bounded = String::with_capacity(LIMIT);
            bounded.push_str(&error[..end]);
            bounded.push_str(SUFFIX);
            *error = bounded;
        }
    }
    if let Some(reservation) = &mut completion.backing_reservation {
        let size = match &completion.result {
            Ok(bytes) => bytes.len(),
            Err(error) => error.len(),
        };
        reservation.shrink(size);
    }
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
        backing_reservation: operation.backing_reservation,
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
                backing_reservation: None,
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
            backing_reservation: None,
            operation_id: operation.operation_id,
            result: Err("invalid host scene operation route".into()),
        }),
    }
}

#[cfg(test)]
mod admission_tests {
    use super::*;

    #[test]
    fn batches_compete_atomically_and_rejections_preserve_original_reservations() {
        let owner = BatchAdmission::with_capacity(4);
        let first = owner.try_reserve(3).unwrap();
        assert!(owner.try_reserve(2).is_none());
        assert!(owner.try_reserve(usize::MAX).is_none());
        assert_eq!(owner.snapshot().reserved_slots, 3);
        assert_eq!(owner.snapshot().rejections, 2);
        let second = owner.try_reserve(1).unwrap();
        assert_eq!(owner.snapshot().reserved_slots, 4);
        drop(first);
        let third = owner.try_reserve(3).unwrap();
        assert_eq!(owner.snapshot().max_reserved_slots, 4);
        drop(second);
        drop(third);
        assert_eq!(owner.snapshot().reserved_slots, 0);
    }

    #[test]
    fn concurrent_batches_cannot_exceed_the_shared_slot_capacity() {
        let owner = BatchAdmission::with_capacity(24);
        let barrier = Arc::new(std::sync::Barrier::new(8));
        std::thread::scope(|threads| {
            for _ in 0..8 {
                let owner = Arc::clone(&owner);
                let barrier = Arc::clone(&barrier);
                threads.spawn(move || {
                    barrier.wait();
                    for _ in 0..100 {
                        if let Some(held) = owner.try_reserve(7) {
                            assert!(owner.snapshot().reserved_slots <= 24);
                            std::thread::yield_now();
                            drop(held);
                        }
                    }
                });
            }
        });
        assert_eq!(owner.snapshot().reserved_slots, 0);
        assert!(owner.snapshot().max_reserved_slots <= 24);
    }

    #[tokio::test]
    async fn cancelled_or_panicked_batches_return_slots_to_their_original_owner() {
        let old = BatchAdmission::with_capacity(4);
        let new = BatchAdmission::with_capacity(4);
        let new_held = new.try_reserve(1).unwrap();
        let held = old.try_reserve(4).unwrap();
        let started = Arc::new(tokio::sync::Notify::new());
        let ready = Arc::clone(&started);
        let sink: HostSceneCompletionSink = Arc::new(move |completion| {
            ready.notify_one();
            Err(completion)
        });
        let task = tokio::spawn(async move {
            let _held = held;
            let operations = (1..=4)
                .map(|id| super::super::HostSceneOperation {
                    backing_reservation: None,
                    operation_id: id,
                    route: None,
                    kind: 3,
                    timeout_ms: 0,
                    frame: bytes::Bytes::new(),
                })
                .collect();
            run(operations, sink, Instant::now()).await;
        });
        tokio::time::timeout(Duration::from_secs(2), started.notified())
            .await
            .unwrap();
        assert!(old.try_reserve(1).is_none());
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(old.snapshot().reserved_slots, 0);
        assert_eq!(new.snapshot().reserved_slots, 1);
        let held = old.try_reserve(4).unwrap();
        assert!(
            tokio::spawn(async move {
                let _held = held;
                panic!("controlled batch failure");
            })
            .await
            .unwrap_err()
            .is_panic()
        );
        assert_eq!(old.snapshot().reserved_slots, 0);
        drop(new_held);
        assert_eq!(new.snapshot().reserved_slots, 0);
    }
}
