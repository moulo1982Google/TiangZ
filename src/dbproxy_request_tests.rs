use super::*;
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    task::Poll,
};
use tokio::sync::oneshot;

struct Completion(Option<oneshot::Sender<()>>);
impl Drop for Completion {
    fn drop(&mut self) {
        if let Some(done) = self.0.take() {
            let _ = done.send(());
        }
    }
}

#[tokio::test]
async fn host_queue_time_counts_and_expired_work_never_starts() {
    let called = Arc::new(AtomicUsize::new(0));
    let operation_called = called.clone();
    let runtime = Handle::current();
    let mut request = Box::pin(execute(
        &runtime,
        Duration::from_millis(20),
        move |_| async move {
            operation_called.fetch_add(1, Ordering::SeqCst);
            Ok(7)
        },
    ));
    std::future::poll_fn(|cx| {
        assert!(request.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    // 当前线程未让出执行权，后台任务仍在队列；只在隔离测试中阻塞时钟区间。
    // Keep the host task queued on this current-thread fixture while the wall-clock budget expires.
    std::thread::sleep(Duration::from_millis(40));
    assert!(matches!(request.await, Err(ClientError::RequestTimeout)));
    tokio::task::yield_now().await;
    assert_eq!(called.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn deadline_drops_an_in_flight_host_operation() {
    let (dropped, completed) = oneshot::channel();
    let result = execute(
        &Handle::current(),
        Duration::from_millis(30),
        move |_| async move {
            let _completion = Completion(Some(dropped));
            std::future::pending::<Result<(), ClientError>>().await
        },
    )
    .await;
    assert!(matches!(result, Err(ClientError::RequestTimeout)));
    tokio::time::timeout(Duration::from_secs(1), completed)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn caller_cancellation_drops_the_owned_host_operation() {
    let (started, arrived) = oneshot::channel();
    let (dropped, completed) = oneshot::channel();
    let caller = tokio::spawn(async move {
        execute(
            &Handle::current(),
            Duration::from_secs(3),
            move |_| async move {
                let _completion = Completion(Some(dropped));
                started.send(()).unwrap();
                std::future::pending::<Result<(), ClientError>>().await
            },
        )
        .await
    });
    arrived.await.unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    tokio::time::timeout(Duration::from_secs(1), completed)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn success_and_business_error_are_returned_once() {
    assert_eq!(
        execute(&Handle::current(), Duration::from_secs(1), |_| async {
            Ok(42)
        })
        .await
        .unwrap(),
        42
    );
    let result = execute(&Handle::current(), Duration::from_secs(1), |_| async {
        Err::<(), _>(ClientError::InvalidConfig("original error"))
    })
    .await;
    assert!(matches!(
        result,
        Err(ClientError::InvalidConfig("original error"))
    ));
}
