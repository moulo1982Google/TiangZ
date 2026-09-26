//! 在复制前约束单个 Rust→V8 批次，满批保留原事件所有权。 / Bounds each Rust-to-V8 batch before copying, retaining original events when full.

use super::control_ingress::{ControlReservation, HostEventPayload};
use super::{ProcessEvent, ProcessEventKind, ProcessQueueStats};
use anyhow::{Context, Result, bail};
use std::sync::atomic::Ordering;

pub(super) const HOST_EVENT_BATCH_MAX_BYTES: usize = 64 * 1024 * 1024;
const BATCH_HEADER_BYTES: usize = 4;
const EVENT_HEADER_BYTES: usize = 13;

pub(super) struct HostEventBatch {
    bytes: Vec<u8>,
    count: u32,
    byte_limit: usize,
    reservations: Vec<ControlReservation>,
}

impl HostEventBatch {
    /// 普通运行与停机共用同一硬上限；不是 V8 存活内存的总额度。 / Uses one hard cap for running and shutdown, not a quota for all live V8 memory.
    pub(super) fn new() -> Self {
        Self::with_limit(HOST_EVENT_BATCH_MAX_BYTES)
    }

    pub(super) fn with_limit(byte_limit: usize) -> Self {
        assert!(byte_limit >= BATCH_HEADER_BYTES + EVENT_HEADER_BYTES);
        Self {
            bytes: vec![0; BATCH_HEADER_BYTES],
            count: 0,
            byte_limit,
            reservations: Vec::new(),
        }
    }

    pub(super) fn len(&self) -> u32 {
        self.count
    }

    /// 容量不足原样返回，不复制、不计为业务拒绝；非法单事件在任何修改前失败。 / Returns a full-batch event untouched; invalid single events fail before mutation.
    pub(super) fn try_push(
        &mut self,
        mut event: ProcessEvent,
        stats: &ProcessQueueStats,
    ) -> Result<Option<ProcessEvent>> {
        let (event_type, connection_id, scene_index, payload): (u8, u64, u32, &[u8]) = match &event
        {
            ProcessEvent::Frame {
                scene_index,
                connection_id,
                internal,
                frame,
                ..
            } => (
                if *internal && crate::transport::inner_frame_rpc_id(frame).is_some() {
                    5
                } else {
                    1
                },
                *connection_id,
                *scene_index,
                frame,
            ),
            ProcessEvent::Disconnect {
                scene_index,
                connection_id,
                ..
            } => (2, *connection_id, *scene_index, &[]),
            ProcessEvent::HostSceneCompletion(completion) => match &completion.result {
                Ok(frame) => (3, completion.operation_id as u64, 0, frame),
                Err(error) => (4, completion.operation_id as u64, 0, error.as_bytes()),
            },
            ProcessEvent::Shutdown => bail!("shutdown event cannot enter a host event batch"),
        };
        let connection_id = u32::try_from(connection_id).context("connection id exceeds uint32")?;
        let payload_len =
            u32::try_from(payload.len()).context("host event payload exceeds uint32")?;
        let event_bytes = EVENT_HEADER_BYTES
            .checked_add(payload.len())
            .context("host event length overflow")?;
        if event_bytes > self.byte_limit - BATCH_HEADER_BYTES {
            bail!(
                "host event of {event_bytes} bytes cannot fit empty batch limit {}",
                self.byte_limit
            );
        }
        if event_bytes > self.byte_limit - self.bytes.len() {
            stats
                .host_event_batch_splits
                .fetch_add(1, Ordering::Relaxed);
            return Ok(Some(event));
        }
        let count = self
            .count
            .checked_add(1)
            .context("host event count exceeds uint32")?;
        let required = self.bytes.len() + event_bytes;
        if required > self.bytes.capacity() {
            // 几何增长请求也封顶；分配器开销和扩容瞬时双份内存不算逻辑批次字节。
            // Cap geometric growth requests too; allocator overhead and realloc peaks are separate.
            let capacity = required
                .max(self.bytes.capacity().saturating_mul(2))
                .min(self.byte_limit);
            self.bytes
                .try_reserve_exact(capacity - self.bytes.len())
                .context("failed to allocate host event batch")?;
        }
        self.bytes.push(event_type);
        self.bytes.extend_from_slice(&connection_id.to_le_bytes());
        self.bytes.extend_from_slice(&scene_index.to_le_bytes());
        self.bytes.extend_from_slice(&payload_len.to_le_bytes());
        self.bytes.extend_from_slice(payload);
        self.count = count;
        match event.kind() {
            ProcessEventKind::Frame => &stats.inbound_frames,
            ProcessEventKind::Completion => &stats.host_completions,
            ProcessEventKind::Disconnect => &stats.disconnects,
            ProcessEventKind::Shutdown => unreachable!(),
        }
        .fetch_add(1, Ordering::Relaxed);
        if let Some(reservation) = event.control_reservation_mut().and_then(Option::take) {
            self.reservations.push(reservation);
        }
        Ok(None)
    }

    /// 转移本批所有权给 V8，记录实际逻辑大小，不保留历史峰值缓冲。 / Transfers this batch to V8, recording logical size without retaining a high-water buffer.
    pub(super) fn into_payload(mut self, stats: &ProcessQueueStats) -> HostEventPayload {
        self.bytes[..BATCH_HEADER_BYTES].copy_from_slice(&self.count.to_le_bytes());
        stats
            .max_host_event_batch_bytes
            .fetch_max(self.bytes.len(), Ordering::Relaxed);
        HostEventPayload {
            bytes: self.bytes,
            reservations: self.reservations,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::HostSceneCompletion;

    #[test]
    fn host_batch_invalid_events_never_mutate_bytes_counts_or_success_metrics() {
        let stats = ProcessQueueStats::default();
        let mut batch = HostEventBatch::with_limit(32);
        batch
            .try_push(
                ProcessEvent::Disconnect {
                    control_reservation: None,
                    scene_index: 0,
                    connection_id: 1,
                },
                &stats,
            )
            .unwrap();
        let before = batch.bytes.clone();
        let pointer = batch.bytes.as_ptr();
        for event in [
            ProcessEvent::Disconnect {
                control_reservation: None,
                scene_index: 0,
                connection_id: u64::MAX,
            },
            ProcessEvent::HostSceneCompletion(HostSceneCompletion {
                operation_id: 7,
                result: Ok(vec![1; 16]),
            }),
            ProcessEvent::HostSceneCompletion(HostSceneCompletion {
                operation_id: 7,
                result: Err("异常".repeat(3)),
            }),
            ProcessEvent::Shutdown,
        ] {
            assert!(batch.try_push(event, &stats).is_err());
            assert_eq!(batch.bytes, before);
            assert_eq!(batch.bytes.as_ptr(), pointer);
            assert_eq!(batch.len(), 1);
        }
        assert_eq!(stats.disconnects.load(Ordering::Relaxed), 1);
        assert_eq!(stats.host_completions.load(Ordering::Relaxed), 0);
        assert_eq!(stats.host_event_batch_splits.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn host_batch_allocation_and_diagnostic_payload_respect_the_exact_byte_limit() {
        let stats = ProcessQueueStats::default();
        let mut batch = HostEventBatch::with_limit(49);
        for id in 1..=2 {
            assert!(
                batch
                    .try_push(
                        ProcessEvent::Disconnect {
                            control_reservation: None,
                            scene_index: 7,
                            connection_id: id
                        },
                        &stats
                    )
                    .unwrap()
                    .is_none()
            );
        }
        assert!(
            batch
                .try_push(
                    ProcessEvent::HostSceneCompletion(HostSceneCompletion {
                        operation_id: 9,
                        result: Err("异常".to_owned()),
                    }),
                    &stats
                )
                .unwrap()
                .is_none()
        );
        assert_eq!(batch.bytes.len(), 49);
        assert!(
            batch.bytes.capacity() <= 49,
            "geometric growth must not request 60 bytes"
        );
        let before = batch.bytes.clone();
        let pointer = batch.bytes.as_ptr();
        let event = batch
            .try_push(
                ProcessEvent::HostSceneCompletion(HostSceneCompletion {
                    operation_id: 10,
                    result: Ok(vec![]),
                }),
                &stats,
            )
            .unwrap()
            .unwrap();
        assert_eq!(batch.bytes.as_ptr(), pointer);
        assert_eq!(batch.bytes, before);
        assert_eq!(batch.bytes[30], 4);
        assert_eq!(&batch.bytes[43..], "异常".as_bytes());
        assert!(
            matches!(event, ProcessEvent::HostSceneCompletion(HostSceneCompletion { operation_id: 10, result: Ok(payload) }) if payload.is_empty())
        );
    }
}
