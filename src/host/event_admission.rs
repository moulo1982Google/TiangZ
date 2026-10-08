//! 在执行前为最终 Host backing store 预留，完成交付不再次竞争额度。 / Reserves final Host backing stores before execution so completion delivery needs no further admission.

use std::{fmt, sync::Arc};

use tiangz_transport::buffer_budget::{BufferBudget, BufferBudgetSnapshot, BufferReservation};

use crate::process::{
    ProcessIngressTrySendError,
    control_ingress::{ControlAdmission, ControlAdmissionSnapshot, ControlReservation},
};

pub(crate) const EVENT_OVERHEAD: usize = 128;
const DATA_CAPACITY: usize = 512 * 1024 * 1024;

pub(crate) struct EventAdmission {
    data: Arc<BufferBudget>,
    disconnects: Arc<ControlAdmission>,
}

pub(crate) enum EventReservation {
    Data {
        held: BufferReservation,
        bytes: usize,
    },
    Disconnect {
        _held: ControlReservation,
    },
}

impl fmt::Debug for EventReservation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Data { bytes, .. } => f.debug_tuple("EventBytes").field(bytes).finish(),
            Self::Disconnect { .. } => f.write_str("DisconnectBytes"),
        }
    }
}

impl EventAdmission {
    pub(crate) fn new() -> Arc<Self> {
        Self::with_capacity(DATA_CAPACITY)
    }

    pub(crate) fn with_capacity(capacity: usize) -> Arc<Self> {
        Arc::new(Self {
            data: BufferBudget::new(capacity),
            disconnects: ControlAdmission::new(),
        })
    }

    /// 只拒绝尚未执行的新工作；回复使用发起调用前已取得的守卫。 / Rejects only new unexecuted work; replies use the guard obtained before dispatch.
    pub(crate) fn try_reserve(&self, payload: usize) -> Option<EventReservation> {
        let bytes = payload.checked_add(EVENT_OVERHEAD)?;
        Some(EventReservation::Data {
            held: self.data.try_reserve(bytes)?,
            bytes,
        })
    }

    pub(crate) fn try_disconnect(&self) -> Result<EventReservation, ProcessIngressTrySendError> {
        Ok(EventReservation::Disconnect {
            _held: self.disconnects.try_reserve()?,
        })
    }

    /// 沿用原连接清理任务与期限，不为容量不足增设后台队列。 / Uses the original connection cleanup task and deadline without spawning a capacity wait queue.
    pub(crate) async fn reserve_disconnect(
        &self,
        deadline: Option<tokio::time::Instant>,
    ) -> Result<EventReservation, String> {
        Ok(EventReservation::Disconnect {
            _held: self.disconnects.reserve_disconnect(deadline).await?,
        })
    }

    pub(crate) fn close(&self) {
        self.disconnects.close();
    }

    pub(crate) fn snapshot(&self) -> BufferBudgetSnapshot {
        self.data.snapshot()
    }

    pub(crate) fn disconnect_snapshot(&self) -> ControlAdmissionSnapshot {
        self.disconnects.snapshot()
    }
}

impl EventReservation {
    /// 确认实际回复后只缩减；不得在业务已执行后尝试追加额度。 / Only shrinks after the actual reply is known; never acquires extra capacity after execution.
    pub(crate) fn shrink(&mut self, payload: usize) {
        let Self::Data { held, bytes } = self else {
            panic!("disconnect reservation cannot own a reply");
        };
        let cost = payload.checked_add(EVENT_OVERHEAD).unwrap();
        assert!(
            cost <= *bytes,
            "reply exceeds its pre-execution reservation"
        );
        assert!(held.try_resize(cost));
        *bytes = cost;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn disconnect_capacity_preserves_deadline_cancel_and_receiver_close() {
        let admission = EventAdmission::with_capacity(EVENT_OVERHEAD);
        let data = admission.try_reserve(0).unwrap();
        let mut held = (0..65_536)
            .map(|_| admission.try_disconnect().unwrap())
            .collect::<Vec<_>>();
        assert!(matches!(
            admission.try_disconnect(),
            Err(ProcessIngressTrySendError::Overloaded)
        ));
        let mut wait = Box::pin(admission.reserve_disconnect(None));
        assert!(futures_util::poll!(&mut wait).is_pending());
        drop(wait);
        assert!(
            admission
                .reserve_disconnect(Some(tokio::time::Instant::now()))
                .await
                .unwrap_err()
                .contains("deadline")
        );
        let mut wait = Box::pin(admission.reserve_disconnect(None));
        assert!(futures_util::poll!(&mut wait).is_pending());
        held.pop();
        let recovered = wait.await.unwrap();
        assert_eq!(admission.disconnect_snapshot().reserved, 65_536);
        let mut wait = Box::pin(admission.reserve_disconnect(None));
        assert!(futures_util::poll!(&mut wait).is_pending());
        admission.close();
        assert!(wait.await.unwrap_err().contains("stopped"));
        drop(held);
        drop(recovered);
        assert_eq!(admission.disconnect_snapshot().reserved, 0);
        assert_eq!(admission.snapshot().used_bytes, EVENT_OVERHEAD as u64);
        drop(data);
        assert_eq!(admission.snapshot().used_bytes, 0);
    }
}
