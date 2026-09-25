//! 把调用方的预算与取消传到 Rust Host 任务；后台任务不脱离发起者。 / Keeps a Rust host request inside its caller's budget and cancellation lifetime.

use std::future::Future;
use std::time::Duration;

use tiangz_dbproxy_client::ClientError;
use tokio::{
    runtime::Handle,
    task::JoinHandle,
    time::{Instant, timeout_at},
};

struct OwnedRequest<T>(JoinHandle<Result<T, ClientError>>);

impl<T> Drop for OwnedRequest<T> {
    /// 调用方取消或期限结束时请求中止，已提交的业务副作用不因此回滚。 / Aborts work on caller cancellation or expiry without claiming committed effects were rolled back.
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// 从提交 Host 任务前开始计时，并把同一期限交给连接池与操作；超时保守报告结果未知。 / Starts timing before host submission and shares one deadline with pool acquisition and execution; expiry conservatively reports an unknown outcome.
pub(super) async fn execute<T, F, Fut>(
    runtime: &Handle,
    duration: Duration,
    operation: F,
) -> Result<T, ClientError>
where
    T: Send + 'static,
    F: FnOnce(Instant) -> Fut + Send + 'static,
    Fut: Future<Output = Result<T, ClientError>> + Send + 'static,
{
    if duration.is_zero() {
        return Err(ClientError::InvalidConfig(
            "host request timeout must be positive",
        ));
    }
    let deadline = Instant::now()
        .checked_add(duration)
        .ok_or(ClientError::InvalidConfig(
            "host request timeout is too large",
        ))?;
    let mut request = OwnedRequest(runtime.spawn(async move {
        check_deadline(deadline)?;
        timeout_at(deadline, operation(deadline))
            .await
            .map_err(|_| ClientError::RequestTimeout)?
    }));
    timeout_at(deadline, &mut request.0)
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
