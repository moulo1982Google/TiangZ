//! 把调用方的预算与取消传到 Rust Host 任务；后台任务不脱离发起者。 / Keeps a Rust host request inside its caller's budget and cancellation lifetime.

use std::future::Future;
use std::sync::OnceLock;
use std::time::Duration;

use tiangz_dbproxy_client::ClientError;
use tokio::{
    runtime::Handle,
    task::JoinHandle,
    time::{Instant, timeout_at},
};

struct OwnedRequest(JoinHandle<()>);

static CLOCK_ORIGIN: OnceLock<std::time::Instant> = OnceLock::new();

/// 只暴露无凭据的进程单调时钟，供 TS 范围与 Host 共用期限。 / Exposes a credential-free monotonic clock shared by TS scopes and host deadlines.
pub(super) fn monotonic_now_ms() -> f64 {
    CLOCK_ORIGIN
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_secs_f64()
        * 1000.0
}

/// 宿主配置是上限；TS 绝对期限覆盖序列化/解析耗时，不能重置为一个新超时。 / Host configuration is a ceiling; an absolute TS deadline includes conversion time and never resets the timeout.
pub(super) fn deadline(
    duration: Duration,
    requested_ms: Option<f64>,
) -> Result<Instant, ClientError> {
    if duration.is_zero() {
        return Err(ClientError::InvalidConfig(
            "host request timeout must be positive",
        ));
    }
    let now = Instant::now();
    let ceiling = now.checked_add(duration).ok_or(ClientError::InvalidConfig(
        "host request timeout is too large",
    ))?;
    let Some(requested_ms) = requested_ms else {
        return Ok(ceiling);
    };
    if !requested_ms.is_finite() || requested_ms <= 0.0 {
        return Err(ClientError::InvalidConfig(
            "host request deadline must be finite and positive",
        ));
    }
    let origin = *CLOCK_ORIGIN.get_or_init(std::time::Instant::now);
    let elapsed = Duration::try_from_secs_f64(requested_ms / 1000.0)
        .map_err(|_| ClientError::InvalidConfig("host request deadline is too large"))?;
    let requested = origin
        .checked_add(elapsed)
        .ok_or(ClientError::InvalidConfig(
            "host request deadline is too large",
        ))?;
    Ok(ceiling.min(Instant::from_std(requested)))
}

impl Drop for OwnedRequest {
    /// 调用方取消或期限结束时请求中止，已提交的业务副作用不因此回滚。 / Aborts work on caller cancellation or expiry without claiming committed effects were rolled back.
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// 从提交 Host 任务前开始计时，并把同一期限交给连接池与操作；超时保守报告结果未知。 / Starts timing before host submission and shares one deadline with pool acquisition and execution; expiry conservatively reports an unknown outcome.
pub(super) async fn execute<T, F, Fut>(
    runtime: &Handle,
    deadline: Instant,
    operation: F,
) -> Result<T, ClientError>
where
    T: Send + 'static,
    F: FnOnce(Instant) -> Fut + Send + 'static,
    Fut: Future<Output = Result<T, ClientError>> + Send + 'static,
{
    check_deadline(deadline)?;
    // Host 任务先把结果放进 oneshot，再叫醒 Process 主循环；V8 侧等 oneshot，保证主循环醒来时结果一定可取。
    // 任务 panic 或被中止时发送端被丢弃，仍报告宿主任务终止；调用方取消时 `_request` 析构中止任务，语义不变。
    // The host task stores the result in a oneshot before waking the Process loop; V8 awaits the oneshot so the
    // result is always observable when the loop wakes. A panicking/aborted task drops the sender and still reports
    // termination; caller cancellation drops `_request` and aborts the task as before.
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let _request = OwnedRequest(runtime.spawn(async move {
        // 析构逆序：发送端先于通知析构，panic 时也先让 V8 侧看到终止再叫醒。
        // Reverse drop order: the sender drops before the notifier, so even a panic is observable before the wake.
        let _wake = crate::host_wake::NotifyOnDrop;
        let sender = sender;
        let result = async {
            check_deadline(deadline)?;
            timeout_at(deadline, operation(deadline))
                .await
                .map_err(|_| ClientError::RequestTimeout)?
        }
        .await;
        let _ = sender.send(result);
    }));
    timeout_at(deadline, receiver)
        .await
        .map_err(|_| ClientError::RequestTimeout)?
        .map_err(|_| ClientError::UnexpectedResponse("DBProxy host task terminated"))?
}

/// 阶段切换前确认剩余预算，避免已过期的 ready 操作继续发起 I/O。 / Checks the budget before a ready next stage can start more I/O.
pub(super) fn check_deadline(deadline: Instant) -> Result<(), ClientError> {
    if Instant::now() >= deadline {
        Err(ClientError::RequestTimeout)
    } else {
        Ok(())
    }
}

#[cfg(test)]
#[path = "dbproxy_request_tests.rs"]
mod tests;
