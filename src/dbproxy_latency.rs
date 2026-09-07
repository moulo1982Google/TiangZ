//! 固定桶的 DBProxy 阶段耗时；热路径不分配、不加锁、不生成请求标签。
//! Fixed-bucket DBProxy stage timing, without allocation, locks or request labels on the hot path.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use crate::health::LatencyObservabilitySnapshot;

const BOUNDS_MICROS: [u64; 12] = [
    100, 500, 1_000, 5_000, 10_000, 50_000, 100_000, 500_000, 1_000_000, 2_000_000, 5_000_000,
    15_000_000,
];

pub(super) struct Histogram {
    buckets: [AtomicU64; 13],
    sum_micros: AtomicU64,
}

impl Default for Histogram {
    fn default() -> Self {
        Self {
            buckets: std::array::from_fn(|_| AtomicU64::new(0)),
            sum_micros: AtomicU64::new(0),
        }
    }
}

impl Histogram {
    /// 每次只递增一个互斥桶；超出上限的样本仍进入无穷桶。
    /// Increments one disjoint bucket per sample, retaining overflow in the infinity bucket.
    pub(super) fn record(&self, elapsed: Duration) {
        let micros = elapsed.as_micros().min(u128::from(u64::MAX)) as u64;
        let bucket = BOUNDS_MICROS.partition_point(|bound| *bound < micros);
        self.buckets[bucket].fetch_add(1, Ordering::Relaxed);
        self.sum_micros.fetch_add(micros, Ordering::Relaxed);
    }

    /// 采集阶段才分配；计数从同一组桶快照求和，保证累计桶不超过总数。
    /// Allocates only on scrape; derives count from the same bucket snapshot for consistent bounds.
    pub(super) fn snapshot(&self, stage: &str) -> LatencyObservabilitySnapshot {
        let buckets = self
            .buckets
            .each_ref()
            .map(|value| value.load(Ordering::Relaxed));
        LatencyObservabilitySnapshot {
            name: stage.to_owned(),
            msgcode: None,
            count: buckets.iter().sum(),
            sum_ms: self.sum_micros.load(Ordering::Relaxed) as f64 / 1_000.0,
            bounds_ms: BOUNDS_MICROS
                .iter()
                .map(|bound| *bound as f64 / 1_000.0)
                .collect(),
            bucket_counts: buckets[..BOUNDS_MICROS.len()].to_vec(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn histogram_preserves_zero_exact_boundaries_and_overflow() {
        let histogram = Histogram::default();
        for micros in [0, 100, 101, 15_000_000, 15_000_001] {
            histogram.record(Duration::from_micros(micros));
        }
        let snapshot = histogram.snapshot("connection_queue");
        assert_eq!(snapshot.count, 5);
        assert_eq!(snapshot.bucket_counts[0], 2);
        assert_eq!(snapshot.bucket_counts[1], 1);
        assert_eq!(snapshot.bucket_counts[11], 1);
        assert_eq!(snapshot.bucket_counts.iter().sum::<u64>(), 4);
        assert_eq!(snapshot.sum_ms, 30_000.202);
    }

    #[test]
    fn concurrent_observations_do_not_lose_samples() {
        let histogram = Histogram::default();
        std::thread::scope(|scope| {
            for _ in 0..4 {
                scope.spawn(|| {
                    for _ in 0..1_000 {
                        histogram.record(Duration::from_millis(5));
                    }
                });
            }
        });
        let snapshot = histogram.snapshot("connection_exchange");
        assert_eq!(snapshot.count, 4_000);
        assert_eq!(snapshot.bucket_counts[3], 4_000);
        assert_eq!(snapshot.sum_ms, 20_000.0);
    }
}
