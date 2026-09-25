//! 所有业务 listener 共用的入站准入名额，不排队等待名额。 / Shared admission slots for all business listeners, with no waiting queue.

use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub(crate) struct ConnectionAdmission {
    connections: Arc<Semaphore>,
    handshakes: Arc<Semaphore>,
    connection_limit: usize,
    handshake_limit: usize,
    connection_rejections: AtomicU64,
    handshake_rejections: AtomicU64,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct AdmissionSnapshot {
    pub(crate) connections: u64,
    pub(crate) handshakes: u64,
    pub(crate) connection_limit: u64,
    pub(crate) handshake_limit: u64,
    pub(crate) connection_rejections: u64,
    pub(crate) handshake_rejections: u64,
}

pub(super) struct ConnectionPermit {
    _connection: OwnedSemaphorePermit,
    handshake: Option<OwnedSemaphorePermit>,
}

impl ConnectionPermit {
    /// 握手完成只释放握手名额，连接名额保留到任务/Session 真正销毁。 / Releases only the handshake slot; the connection slot lasts until its task/session is dropped.
    pub(super) fn complete_handshake(&mut self) {
        self.handshake.take();
    }
}

impl ConnectionAdmission {
    /// 从已校验的进程配置建立共享名额，后端克隆同一所有者。 / Creates slots from validated process settings; backends share this owner.
    pub(crate) fn new(connection_limit: usize, handshake_limit: usize) -> Self {
        Self {
            connections: Arc::new(Semaphore::new(connection_limit)),
            handshakes: Arc::new(Semaphore::new(handshake_limit)),
            connection_limit,
            handshake_limit,
            connection_rejections: AtomicU64::new(0),
            handshake_rejections: AtomicU64::new(0),
        }
    }

    /// 流连接在创建任务前取得两个名额，握手名额不足时自动退回连接名额。 / Acquires both slots before spawning; a rejected handshake returns the connection slot automatically.
    pub(super) fn accept_stream(&self) -> Option<ConnectionPermit> {
        let mut permit = self.accept_connection()?;
        match self.handshakes.clone().try_acquire_owned() {
            Ok(handshake) => {
                permit.handshake = Some(handshake);
                Some(permit)
            }
            Err(_) => {
                self.handshake_rejections.fetch_add(1, Ordering::Relaxed);
                None
            }
        }
    }

    /// KCP 在验证无状态 cookie 后才创建 Session，不占用流握手名额。 / KCP admits sessions only after stateless cookie verification, without a stream-handshake slot.
    #[cfg(feature = "kcp")]
    pub(super) fn accept_session(&self) -> Option<ConnectionPermit> {
        self.accept_connection()
    }

    /// 同步拒绝超限，不创建 waiter、额外响应或无界日志。 / Rejects immediately without allocating a waiter, response or unbounded log entry.
    fn accept_connection(&self) -> Option<ConnectionPermit> {
        match self.connections.clone().try_acquire_owned() {
            Ok(connection) => Some(ConnectionPermit {
                _connection: connection,
                handshake: None,
            }),
            Err(_) => {
                self.connection_rejections.fetch_add(1, Ordering::Relaxed);
                None
            }
        }
    }

    /// 读取有限计数；并发准入/释放时各 gauge 为近似同时的观察。 / Reads bounded counters; concurrent admission/release makes gauges approximately contemporaneous.
    pub(crate) fn snapshot(&self) -> AdmissionSnapshot {
        AdmissionSnapshot {
            connections: (self.connection_limit - self.connections.available_permits()) as u64,
            handshakes: (self.handshake_limit - self.handshakes.available_permits()) as u64,
            connection_limit: self.connection_limit as u64,
            handshake_limit: self.handshake_limit as u64,
            connection_rejections: self.connection_rejections.load(Ordering::Relaxed),
            handshake_rejections: self.handshake_rejections.load(Ordering::Relaxed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn task_panic_and_cancellation_return_both_admission_slots() {
        let admission = Arc::new(ConnectionAdmission::new(1, 1));
        let permit = admission.accept_stream().unwrap();
        let failed = tokio::spawn(async move {
            let _permit = permit;
            panic!("controlled connection failure");
        });
        assert!(failed.await.unwrap_err().is_panic());
        assert_eq!(admission.snapshot().connections, 0);
        assert_eq!(admission.snapshot().handshakes, 0);

        let mut permit = admission.accept_stream().unwrap();
        permit.complete_handshake();
        let (started, ready) = tokio::sync::oneshot::channel();
        let blocked = tokio::spawn(async move {
            let _permit = permit;
            started.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        ready.await.unwrap();
        assert_eq!(admission.snapshot().connections, 1);
        assert_eq!(admission.snapshot().handshakes, 0);
        blocked.abort();
        assert!(blocked.await.unwrap_err().is_cancelled());
        assert_eq!(admission.snapshot().connections, 0);
        assert!(admission.accept_stream().is_some());
    }
}
