//! 持有端点、连接登记与子任务，确保取消能释放实际资源。 / Owns endpoints, connection registrations and child tasks so cancellation releases resources.

use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use anyhow::{Context as _, Result};
use futures_util::{StreamExt, stream::FuturesUnordered};
use tokio::sync::{mpsc, watch};
use tokio::task::{JoinError, JoinHandle};

use super::{ConnectionWriteBatch, ConnectionWriter, ConnectionWriters};

pub(super) struct OwnedTask<T>(JoinHandle<T>);

impl<T> OwnedTask<T> {
    /// 接管已有任务，所有者被取消时同步发起 abort。 / Takes ownership and requests abort if the owner is cancelled.
    pub(super) fn new(task: JoinHandle<T>) -> Self {
        Self(task)
    }

    /// 取消正在等待 I/O 的子任务。 / Cancels a child waiting on I/O.
    pub(super) fn abort(&self) {
        self.0.abort();
    }

    /// 让单线程 Session 循环仅收割已完成任务，不等待活跃 writer。 / Lets the session loop reap completed tasks without waiting for a live writer.
    #[cfg(feature = "kcp")]
    pub(super) fn is_finished(&self) -> bool {
        self.0.is_finished()
    }
}

impl<T> Future for OwnedTask<T> {
    type Output = std::result::Result<T, JoinError>;

    /// 交付真实任务结果，保持 panic/取消信息。 / Delivers the actual task result, including panic/cancellation.
    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.0).poll(context)
    }
}

impl<T> Drop for OwnedTask<T> {
    /// Drop 不得分离仍在运行的 writer。 / Never detaches a live writer on drop.
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub(crate) struct EndpointTask {
    scene_name: String,
    shutdown: watch::Sender<bool>,
    task: OwnedTask<Result<()>>,
}

impl EndpointTask {
    /// 将后端任务及其协作停止信号交给 Process。 / Hands the backend task and its cooperative stop signal to the process.
    pub(super) fn new(
        scene_name: String,
        shutdown: watch::Sender<bool>,
        task: JoinHandle<Result<()>>,
    ) -> Self {
        Self {
            scene_name,
            shutdown,
            task: OwnedTask::new(task),
        }
    }

    /// 先停止准入，再由各连接完成有界排空。 / Stops admission before connections finish their bounded drain.
    pub(crate) fn request_stop(&self) {
        let _ = self.shutdown.send(true);
    }
}

impl Future for EndpointTask {
    type Output = Result<()>;

    /// 把端点失败及任务 panic 带着端点身份交回 Process。 / Returns endpoint errors and panics with their endpoint identity.
    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        match Pin::new(&mut self.task).poll(context) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(result) => Poll::Ready(
                result
                    .with_context(|| format!("endpoint {} task failed", self.scene_name))
                    .and_then(|result| {
                        result.with_context(|| format!("endpoint {} failed", self.scene_name))
                    }),
            ),
        }
    }
}

impl Drop for EndpointTask {
    /// 回滚启动或取消 Process 时同时通知协作停止；任务字段随后 abort。 / Signals cooperative stop during startup rollback/cancellation before the task field aborts.
    fn drop(&mut self) {
        self.request_stop();
    }
}

/// 覆盖已发生的停止通知，避免订阅较晚的连接漏掉关闭。 / Includes already-published stop notifications for late subscribers.
pub(super) async fn stopped(shutdown: &mut watch::Receiver<bool>) {
    while !*shutdown.borrow_and_update() {
        if shutdown.changed().await.is_err() {
            break;
        }
    }
}

/// 关闭先停止新批次准入，再按原顺序读完已接受队列。 / Stops new batch admission on close and drains the accepted queue in order.
pub(super) async fn next_write_batch(
    receiver: &mut mpsc::Receiver<ConnectionWriteBatch>,
    shutdown: &mut watch::Receiver<bool>,
) -> Option<ConnectionWriteBatch> {
    tokio::select! {
        biased;
        _ = stopped(shutdown) => {
            receiver.close();
            receiver.recv().await
        }
        batch = receiver.recv() => batch,
    }
}

struct WriterStopped(watch::Sender<bool>);

impl Drop for WriterStopped {
    /// writer 正常完成、失败、panic 或取消都唤醒 reader 完成连接清理。 / Wakes the reader on writer completion, error, panic or cancellation.
    fn drop(&mut self) {
        let _ = self.0.send(true);
    }
}

/// 正常关闭从首次通知起只有一次总排空预算；不把超时误当已完整发送。 / Applies one drain budget from the first close notification; timeout never means fully sent.
pub(super) async fn drain_writer(
    work: impl Future<Output = Result<()>>,
    shutdown: watch::Sender<bool>,
    close_budget: Duration,
) -> Result<()> {
    let mut shutdown_rx = shutdown.subscribe();
    let _stopped = WriterStopped(shutdown);
    tokio::pin!(work);
    tokio::select! {
        biased;
        _ = stopped(&mut shutdown_rx) => {
            tokio::time::timeout(close_budget, work).await.context("connection writer exceeded close budget; queued data may remain unsent")?
        }
        result = &mut work => result,
    }
}

/// 所有端点共用一次排空预算；期限后取消并等待异步清理。 / Shares one drain budget across endpoints, then cancels and reaps asynchronous cleanup.
pub(crate) async fn stop_endpoints(
    endpoints: &mut FuturesUnordered<EndpointTask>,
    budget: Duration,
) -> Result<()> {
    for endpoint in endpoints.iter() {
        endpoint.request_stop();
    }
    let mut first_error = None;
    let drained = tokio::time::timeout(budget, async {
        while let Some(result) = endpoints.next().await {
            if let Err(error) = result {
                first_error.get_or_insert(error);
            }
        }
    })
    .await;
    if drained.is_err() {
        for endpoint in endpoints.iter() {
            endpoint.task.abort();
        }
        while endpoints.next().await.is_some() {}
        anyhow::bail!("network endpoints exceeded process stop budget ({budget:?})");
    }
    first_error.map_or(Ok(()), Err)
}

pub(super) struct ConnectionRegistration {
    writers: ConnectionWriters,
    connection_id: u64,
    shutdown: watch::Sender<bool>,
}

impl ConnectionRegistration {
    /// 将登记与连接任务绑定，异常取消也会移除登记。 / Binds registration to the connection task, including exceptional cancellation.
    pub(super) fn new(
        writers: ConnectionWriters,
        connection_id: u64,
        writer: ConnectionWriter,
    ) -> Self {
        let shutdown = writer.shutdown_tx.clone();
        writers
            .lock()
            .expect("connection writer map poisoned")
            .insert(connection_id, writer);
        Self {
            writers,
            connection_id,
            shutdown,
        }
    }
}

impl Drop for ConnectionRegistration {
    /// 正常路径已清理时移除为空；取消路径负责收回登记并停止 writer。 / Removal is idempotent after normal cleanup; cancellation also stops the writer.
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
        self.writers
            .lock()
            .expect("connection writer map poisoned")
            .remove(&self.connection_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    struct Dropped(Arc<AtomicBool>);

    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn endpoint_errors_and_panics_reach_supervisor() {
        for panic in [false, true] {
            let (shutdown, _shutdown_rx) = watch::channel(false);
            let endpoint = EndpointTask::new(
                "failed-scene".into(),
                shutdown,
                tokio::spawn(async move {
                    assert!(!panic, "injected endpoint panic");
                    anyhow::bail!("injected accept failure");
                }),
            );
            let error = format!("{:#}", endpoint.await.unwrap_err());
            assert!(error.contains("failed-scene"));
            assert!(error.contains(if panic {
                "injected endpoint panic"
            } else {
                "injected accept failure"
            }));
        }
    }

    #[tokio::test]
    async fn stop_budget_cancels_and_reaps_all_uncooperative_async_endpoints() {
        let mut endpoints = FuturesUnordered::new();
        let mut dropped = Vec::new();
        for index in 0..3 {
            let flag = Arc::new(AtomicBool::new(false));
            dropped.push(flag.clone());
            let (started, waiting) = tokio::sync::oneshot::channel();
            let (shutdown, _shutdown_rx) = watch::channel(false);
            endpoints.push(EndpointTask::new(
                format!("stalled-{index}"),
                shutdown,
                tokio::spawn(async move {
                    let _guard = Dropped(flag);
                    let _ = started.send(());
                    std::future::pending::<Result<()>>().await
                }),
            ));
            waiting.await.unwrap();
        }
        let error = stop_endpoints(&mut endpoints, Duration::from_millis(20))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("stop budget"));
        assert!(endpoints.is_empty());
        assert!(dropped.iter().all(|flag| flag.load(Ordering::SeqCst)));
    }
}
