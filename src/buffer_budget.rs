//! 由资源所有者持有的共享字节预算，无等待队列。 / Owner-held shared byte reservations with no waiting queue.

use bytes::Bytes;
use std::sync::{
    Arc,
    atomic::{AtomicU64, AtomicUsize, Ordering},
};

pub struct BufferBudget {
    limit: usize,
    used: AtomicUsize,
    rejections: AtomicU64,
}

#[derive(Clone, Debug, Default)]
pub struct BufferBudgetSnapshot {
    pub used_bytes: u64,
    pub limit_bytes: u64,
    pub rejections: u64,
}

pub struct BufferReservation {
    budget: Arc<BufferBudget>,
    bytes: usize,
}

struct ReservedBytes {
    bytes: Vec<u8>,
    _reservation: BufferReservation,
}

impl AsRef<[u8]> for ReservedBytes {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}

impl BufferBudget {
    /// 预留成功才复制；切片与克隆共享最后所有者的预算。 / Copies only after admission; slices and clones retain the reservation until the final owner drops.
    pub fn try_copy_bytes(self: &Arc<Self>, bytes: &[u8]) -> Option<Bytes> {
        let reservation = self.try_reserve(bytes.len())?;
        Some(Bytes::from_owner(ReservedBytes {
            bytes: bytes.to_vec(),
            _reservation: reservation,
        }))
    }

    /// 创建共享所有者，限制由调用方配置校验。 / Creates a shared owner; callers validate configuration limits.
    pub fn new(limit: usize) -> Arc<Self> {
        Arc::new(Self {
            limit,
            used: AtomicUsize::new(0),
            rejections: AtomicU64::new(0),
        })
    }

    /// 在实际接收入队前原子预留；容量不足立即拒绝，不等待。 / Atomically reserves before admission and rejects immediately at capacity.
    pub fn try_reserve(self: &Arc<Self>, bytes: usize) -> Option<BufferReservation> {
        if self
            .used
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |used| {
                used.checked_add(bytes).filter(|total| *total <= self.limit)
            })
            .is_err()
        {
            self.rejections.fetch_add(1, Ordering::Relaxed);
            return None;
        }
        Some(BufferReservation {
            budget: self.clone(),
            bytes,
        })
    }

    /// 各计数为采样时近似同时的观察，所有实际准入始终受原子上限保护。 / Snapshots are approximate across counters; admission always enforces the atomic limit.
    pub fn snapshot(&self) -> BufferBudgetSnapshot {
        BufferBudgetSnapshot {
            used_bytes: self.used.load(Ordering::Relaxed) as u64,
            limit_bytes: self.limit as u64,
            rejections: self.rejections.load(Ordering::Relaxed),
        }
    }
}

impl Drop for BufferReservation {
    /// 只在资源的最后一个所有者销毁时归还，取消与 panic 也适用。 / Returns bytes when the owner is dropped, including cancellation and panic.
    fn drop(&mut self) {
        self.budget.used.fetch_sub(self.bytes, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;

    #[test]
    fn copied_bytes_retain_the_whole_reservation_until_the_last_slice_drops() {
        let budget = BufferBudget::new(8);
        let bytes = budget.try_copy_bytes(&[1; 8]).unwrap();
        let clone = bytes.clone();
        let slice = bytes.slice(3..5);
        assert!(budget.try_copy_bytes(&[0]).is_none());
        drop(bytes);
        drop(clone);
        assert_eq!(budget.snapshot().used_bytes, 8);
        assert_eq!(&slice[..], &[1, 1]);
        drop(slice);
        assert_eq!(budget.snapshot().used_bytes, 0);
        assert!(budget.try_copy_bytes(&[2; 8]).is_some());
    }

    #[test]
    fn shared_reservations_reject_overflow_and_return_on_drop() {
        let budget = BufferBudget::new(10);
        let first = budget.try_reserve(6).unwrap();
        assert!(budget.try_reserve(5).is_none());
        assert!(budget.try_reserve(usize::MAX).is_none());
        let second = budget.try_reserve(4).unwrap();
        assert_eq!(budget.snapshot().used_bytes, 10);
        assert_eq!(budget.snapshot().rejections, 2);
        drop(first);
        assert_eq!(budget.snapshot().used_bytes, 4);
        drop(second);
        assert_eq!(budget.snapshot().used_bytes, 0);
    }

    #[test]
    fn concurrent_owners_never_overcommit_or_leak_after_unwind() {
        let budget = BufferBudget::new(48);
        let acquired = Barrier::new(9);
        let release = Barrier::new(9);
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    let reservation = budget.try_reserve(16);
                    acquired.wait();
                    release.wait();
                    drop(reservation);
                });
            }
            acquired.wait();
            let snapshot = budget.snapshot();
            release.wait();
            assert_eq!(snapshot.used_bytes, 48);
            assert_eq!(snapshot.rejections, 5);
        });
        assert_eq!(budget.snapshot().used_bytes, 0);
        let failed = std::panic::catch_unwind(|| {
            let _reservation = budget.try_reserve(48).unwrap();
            panic!("controlled buffer owner failure");
        });
        assert!(failed.is_err());
        assert_eq!(budget.snapshot().used_bytes, 0);
    }
}
