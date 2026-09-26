//! 控制节点跨 Native/V8/TS 保留数量名额，开始执行或丢弃后确认归还。 / Retains count slots across Native/V8/TS until controls start or are discarded.

use std::collections::VecDeque;
use std::sync::{
    Arc,
    atomic::{AtomicU64, AtomicUsize, Ordering},
};

use anyhow::{Result, bail};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, TryAcquireError};

use super::ProcessIngressTrySendError;

const CAPACITY: usize = 65_536;

#[derive(Debug)]
pub(crate) struct ControlAdmission {
    semaphore: Arc<Semaphore>,
    capacity: usize,
    reserved: AtomicUsize,
    peak: AtomicUsize,
    rejections: AtomicU64,
    waits: AtomicU64,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct ControlAdmissionSnapshot {
    pub(crate) reserved: u64,
    pub(crate) capacity: u64,
    pub(crate) peak: u64,
    pub(crate) rejections: u64,
    pub(crate) waits: u64,
}

#[derive(Debug)]
pub(crate) struct ControlReservation {
    owner: Arc<ControlAdmission>,
    _permit: OwnedSemaphorePermit,
}

impl ControlAdmission {
    pub(crate) fn new() -> Arc<Self> {
        Self::with_capacity(CAPACITY)
    }

    pub(super) fn with_capacity(capacity: usize) -> Arc<Self> {
        assert!(capacity > 0 && capacity <= CAPACITY);
        Arc::new(Self {
            semaphore: Arc::new(Semaphore::new(capacity)),
            capacity,
            reserved: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
            rejections: AtomicU64::new(0),
            waits: AtomicU64::new(0),
        })
    }

    /// RPC 即时拒绝，已关闭与满额分开报告，不创建排队任务。 / Rejects RPC immediately, distinguishing closed admission from full capacity without spawning waiters.
    pub(super) fn try_reserve(
        self: &Arc<Self>,
    ) -> Result<ControlReservation, ProcessIngressTrySendError> {
        match Arc::clone(&self.semaphore).try_acquire_owned() {
            Ok(permit) => Ok(self.hold(permit)),
            Err(TryAcquireError::Closed) => Err(ProcessIngressTrySendError::Stopped),
            Err(TryAcquireError::NoPermits) => {
                self.rejections.fetch_add(1, Ordering::Relaxed);
                Err(ProcessIngressTrySendError::Overloaded)
            }
        }
    }

    /// 断线等待留在原清理任务；取消、原期限或接收端退出均不遗留名额。 / Keeps disconnect admission in its original cleanup task, respecting cancellation, the original deadline and receiver shutdown.
    pub(super) async fn reserve_disconnect(
        self: &Arc<Self>,
        deadline: Option<tokio::time::Instant>,
    ) -> Result<ControlReservation, String> {
        match Arc::clone(&self.semaphore).try_acquire_owned() {
            Ok(permit) => return Ok(self.hold(permit)),
            Err(TryAcquireError::Closed) => {
                return Err("process control ingress is stopped".to_owned());
            }
            Err(TryAcquireError::NoPermits) => {}
        }
        self.waits.fetch_add(1, Ordering::Relaxed);
        let wait = Arc::clone(&self.semaphore).acquire_owned();
        let permit = match deadline {
            Some(deadline) => tokio::time::timeout_at(deadline, wait)
                .await
                .map_err(|_| "process control ingress deadline expired".to_owned())?,
            None => wait.await,
        }
        .map_err(|_| "process control ingress is stopped".to_owned())?;
        Ok(self.hold(permit))
    }

    fn hold(self: &Arc<Self>, permit: OwnedSemaphorePermit) -> ControlReservation {
        let used = self.reserved.fetch_add(1, Ordering::Relaxed) + 1;
        self.peak.fetch_max(used, Ordering::Relaxed);
        ControlReservation {
            owner: Arc::clone(self),
            _permit: permit,
        }
    }

    /// 停止新准入并唤醒已有等待；已接受名额仍由原守卫释放。 / Stops new admission and wakes waiters while existing guards retain their ownership.
    pub(crate) fn close(&self) {
        self.semaphore.close();
    }

    pub(crate) fn snapshot(&self) -> ControlAdmissionSnapshot {
        ControlAdmissionSnapshot {
            reserved: self.reserved.load(Ordering::Relaxed) as u64,
            capacity: self.capacity as u64,
            peak: self.peak.load(Ordering::Relaxed) as u64,
            rejections: self.rejections.load(Ordering::Relaxed),
            waits: self.waits.load(Ordering::Relaxed),
        }
    }
}

impl Drop for ControlReservation {
    /// 先减统计再交还 semaphore，避免竞争准入暂时把峰值计到容量以上。 / Decrements accounting before returning the permit so racing admission cannot exceed the reported capacity.
    fn drop(&mut self) {
        self.owner.reserved.fetch_sub(1, Ordering::Relaxed);
    }
}

/// 只由活动 isolate 的 OpState 持有；budget 不反向拥有守卫。 / Owned only by the active isolate's OpState; the budget never owns guards back.
pub(crate) struct PublishedControls {
    owner: Arc<ControlAdmission>,
    reservations: VecDeque<ControlReservation>,
}

impl PublishedControls {
    pub(crate) fn new(owner: Arc<ControlAdmission>) -> Self {
        Self {
            owner,
            reservations: VecDeque::new(),
        }
    }

    pub(crate) fn publish(&mut self, reservations: Vec<ControlReservation>) {
        debug_assert!(
            reservations
                .iter()
                .all(|item| Arc::ptr_eq(&item.owner, &self.owner))
        );
        self.reservations.extend(reservations);
    }

    /// 确认先整体验证，非法计数不释放任何已发布名额。 / Validates acknowledgements atomically before releasing any published slots.
    pub(crate) fn release(&mut self, count: f64) -> Result<()> {
        if !count.is_finite()
            || count < 0.0
            || count.fract() != 0.0
            || count > self.reservations.len() as f64
        {
            bail!(
                "invalid control ingress acknowledgement: {count}, published {}",
                self.reservations.len()
            );
        }
        drop(self.reservations.drain(..count as usize));
        Ok(())
    }
}

impl Drop for PublishedControls {
    fn drop(&mut self) {
        self.owner.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn control_ingress_wait_cancel_deadline_close_and_recovery_keep_original_owner() {
        let admission = ControlAdmission::with_capacity(1);
        let first = admission.try_reserve().unwrap();
        assert!(matches!(
            admission.try_reserve(),
            Err(ProcessIngressTrySendError::Overloaded)
        ));
        let mut waiting = Box::pin(admission.reserve_disconnect(None));
        assert!(futures_util::poll!(&mut waiting).is_pending());
        drop(waiting);
        assert!(
            admission
                .reserve_disconnect(Some(tokio::time::Instant::now()))
                .await
                .is_err()
        );
        assert_eq!(admission.snapshot().reserved, 1);
        drop(first);
        let recovered = admission.reserve_disconnect(None).await.unwrap();
        let mut waiting = Box::pin(admission.reserve_disconnect(None));
        assert!(futures_util::poll!(&mut waiting).is_pending());
        admission.close();
        assert!(waiting.await.unwrap_err().contains("stopped"));
        assert!(matches!(
            admission.try_reserve(),
            Err(ProcessIngressTrySendError::Stopped)
        ));
        drop(recovered);
        assert_eq!(admission.snapshot().reserved, 0);
        assert_eq!(admission.snapshot().peak, 1);
        assert_eq!(admission.snapshot().rejections, 1);
        assert_eq!(admission.snapshot().waits, 3);
    }

    #[test]
    fn control_ingress_published_ack_is_atomic_and_drop_closes_the_owner() {
        let admission = ControlAdmission::with_capacity(2);
        let mut published = PublishedControls::new(Arc::clone(&admission));
        published.publish(vec![
            admission.try_reserve().unwrap(),
            admission.try_reserve().unwrap(),
        ]);
        for count in [-1.0, 0.5, 3.0, f64::NAN, f64::INFINITY, 4294967296.0] {
            assert!(published.release(count).is_err());
            assert_eq!(admission.snapshot().reserved, 2);
        }
        published.release(1.0).unwrap();
        assert_eq!(admission.snapshot().reserved, 1);
        let replacement = admission.try_reserve().unwrap();
        published.release(0.0).unwrap();
        drop(published);
        assert_eq!(admission.snapshot().reserved, 1);
        assert!(matches!(
            admission.try_reserve(),
            Err(ProcessIngressTrySendError::Stopped)
        ));
        drop(replacement);
        assert_eq!(admission.snapshot().reserved, 0);
    }

    #[test]
    fn control_ingress_default_capacity_is_shared_and_finite() {
        let admission = ControlAdmission::new();
        let guards = (0..CAPACITY)
            .map(|_| admission.try_reserve().unwrap())
            .collect::<Vec<_>>();
        assert!(admission.try_reserve().is_err());
        assert_eq!(admission.snapshot().reserved, CAPACITY as u64);
        drop(guards);
        assert_eq!(admission.snapshot().reserved, 0);
    }
}
