//! 连接写队列暂满时的有界出站暂存。 / Bounded outbound spill for connections whose write queue is momentarily full.
//!
//! 一轮 Update 可能为同一连接产生远超单连接写队列的帧（例如数万个挂起 RPC 同时完成）。原实现在队列满时
//! 立即把连接当作慢连接关闭，健康对端也会被断开。这里按原顺序暂存剩余帧并计入进程出站预算，之后每轮补交；
//! 只有长时间没有进展、超过单连接暂存上限或进程预算耗尽时才关闭。
//! One Update can produce far more frames for a connection than its write queue holds (for example tens of
//! thousands of held RPCs completing together). The old code closed such a connection as slow at once, dropping
//! healthy peers. Remaining frames are now kept in order, charged to the process outbound budget and re-offered
//! every loop; the connection is closed only after no progress for the deadline, past the per-connection cap or
//! when the process budget is exhausted.

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use bytes::Bytes;
use tiangz_transport::buffer_budget::BufferReservation;

use crate::transport_backend::{
    ConnectionQueueError, ConnectionWriteBatch, ConnectionWriter, WRITE_BATCH_BYTE_CAPACITY,
    WRITE_BATCH_FRAME_CAPACITY, try_queue_connection_batch,
};

/// 单连接暂存上限；超过即按慢连接关闭，避免一个对端独占进程出站预算。
/// Per-connection spill cap; beyond it the peer is closed as slow so one peer cannot own the process budget.
pub(crate) const CONNECTION_SPILL_BYTE_CAPACITY: usize = 16 * 1024 * 1024;

struct ConnectionSpill {
    frames: VecDeque<Bytes>,
    bytes: usize,
    reservation: BufferReservation,
    /// 最近一次有进展（开始暂存或成功补交）的时间。 / Last progress: spill start or a successful re-offer.
    progress_at: Instant,
    /// TS 已请求关闭：暂存交付完再关闭。 / TS asked to close: close once the spill is delivered.
    close_after_drain: bool,
}

/// 每连接暂存状态，由进程主循环独占。 / Per-connection spill state owned by the process loop.
pub(crate) struct OutboundSpills {
    by_connection: HashMap<u64, ConnectionSpill>,
    deadline: Duration,
}

/// 一轮补交的结果：需要关闭的连接及原因、暂存已交付且请求过关闭的连接。
/// Result of re-offering: connections to close with their reason, and drained connections that asked to close.
#[derive(Default)]
pub(crate) struct SpillRetry {
    pub(crate) failed: Vec<(u64, ConnectionQueueError)>,
    pub(crate) drained_closes: Vec<u64>,
}

impl OutboundSpills {
    pub(crate) fn new(deadline: Duration) -> Self {
        Self {
            by_connection: HashMap::new(),
            deadline,
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.by_connection.is_empty()
    }

    pub(crate) fn contains(&self, connection_id: u64) -> bool {
        self.by_connection.contains_key(&connection_id)
    }

    pub(crate) fn spilled_bytes(&self) -> usize {
        self.by_connection.values().map(|spill| spill.bytes).sum()
    }

    /// 连接被关闭或移除时丢弃其暂存并归还预算。 / Drops a closed or removed connection's spill and its budget.
    pub(crate) fn remove(&mut self, connection_id: u64) {
        self.by_connection.remove(&connection_id);
    }

    /// TS 请求关闭：有暂存时延后到交付完成，返回 true 表示已延后。
    /// A TS close request: deferred until the spill is delivered; true when deferred.
    pub(crate) fn defer_close(&mut self, connection_id: u64) -> bool {
        match self.by_connection.get_mut(&connection_id) {
            Some(spill) => {
                spill.close_after_drain = true;
                true
            }
            None => false,
        }
    }

    /// 追加帧并计入进程预算；返回 true 表示这是该连接的新暂存。容量失败时调用方关闭连接。
    /// Appends frames and charges the process budget; true when this starts a new spill. On failure the caller
    /// closes the connection.
    pub(crate) fn push(
        &mut self,
        connection_id: u64,
        writer: &ConnectionWriter,
        frames: impl IntoIterator<Item = Bytes>,
    ) -> Result<bool, ConnectionQueueError> {
        let frames: Vec<Bytes> = frames.into_iter().collect();
        let added: usize = frames.iter().map(Bytes::len).sum();
        if let Some(spill) = self.by_connection.get_mut(&connection_id) {
            let total = spill.bytes.saturating_add(added);
            if total > CONNECTION_SPILL_BYTE_CAPACITY {
                return Err(ConnectionQueueError::ByteLimit);
            }
            if !spill.reservation.try_resize(total) {
                return Err(ConnectionQueueError::ProcessByteLimit);
            }
            spill.bytes = total;
            spill.frames.extend(frames);
            return Ok(false);
        }
        if added > CONNECTION_SPILL_BYTE_CAPACITY {
            return Err(ConnectionQueueError::ByteLimit);
        }
        let reservation = writer
            .process_buffer_budget
            .try_reserve(added)
            .ok_or(ConnectionQueueError::ProcessByteLimit)?;
        self.by_connection.insert(
            connection_id,
            ConnectionSpill {
                frames: frames.into(),
                bytes: added,
                reservation,
                progress_at: Instant::now(),
                close_after_drain: false,
            },
        );
        Ok(true)
    }

    /// 按原顺序把暂存帧补交到写队列，直到队列再次满。 / Re-offers spilled frames in order until the write queue fills.
    pub(crate) fn retry(&mut self, writers: &HashMap<u64, ConnectionWriter>) -> SpillRetry {
        let mut result = SpillRetry::default();
        let mut finished = Vec::new();
        for (&connection_id, spill) in &mut self.by_connection {
            let Some(writer) = writers.get(&connection_id) else {
                finished.push(connection_id);
                continue;
            };
            match drain_spill(spill, writer) {
                Ok(()) => {}
                Err(error) => {
                    result.failed.push((connection_id, error));
                    finished.push(connection_id);
                    continue;
                }
            }
            if spill.frames.is_empty() {
                finished.push(connection_id);
                if spill.close_after_drain {
                    result.drained_closes.push(connection_id);
                }
            } else if spill.progress_at.elapsed() >= self.deadline {
                result
                    .failed
                    .push((connection_id, ConnectionQueueError::Stalled));
                finished.push(connection_id);
            }
        }
        for connection_id in finished {
            self.by_connection.remove(&connection_id);
        }
        result
            .failed
            .sort_unstable_by_key(|(connection_id, _)| *connection_id);
        result.drained_closes.sort_unstable();
        result
    }
}

/// 单连接补交；容量满时保留剩余帧并恢复预留。 / Re-offers one connection, keeping the rest and its reservation when full.
fn drain_spill(
    spill: &mut ConnectionSpill,
    writer: &ConnectionWriter,
) -> Result<(), ConnectionQueueError> {
    while !spill.frames.is_empty() {
        let mut frames = Vec::with_capacity(WRITE_BATCH_FRAME_CAPACITY);
        let mut bytes = 0_usize;
        while let Some(frame) = spill.frames.front() {
            if !frames.is_empty()
                && (frames.len() >= WRITE_BATCH_FRAME_CAPACITY
                    || bytes + frame.len() > WRITE_BATCH_BYTE_CAPACITY)
            {
                break;
            }
            bytes += frame.len();
            frames.push(spill.frames.pop_front().unwrap());
        }
        // 先归还本批预留，再由写队列重新预留，避免同一批字节被重复计账。
        // Release this batch first so the write queue can reserve it again without double-charging the bytes.
        spill.bytes -= bytes;
        spill.reservation.try_resize(spill.bytes);
        match try_queue_connection_batch(writer, ConnectionWriteBatch::from_frames(frames.clone()))
        {
            Ok(()) => spill.progress_at = Instant::now(),
            Err(ConnectionQueueError::Closed) => return Err(ConnectionQueueError::Closed),
            Err(_) => {
                for frame in frames.into_iter().rev() {
                    spill.frames.push_front(frame);
                }
                spill.bytes += bytes;
                if !spill.reservation.try_resize(spill.bytes) {
                    return Err(ConnectionQueueError::ProcessByteLimit);
                }
                return Ok(());
            }
        }
    }
    Ok(())
}
