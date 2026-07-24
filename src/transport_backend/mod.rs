//! Separates endpoint protocol semantics from the selected operating-system I/O backend.

mod epoll;
#[cfg(feature = "kcp")]
mod kcp;
#[cfg(all(target_os = "linux", feature = "io-uring"))]
mod uring;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize};
use std::sync::{Arc, Mutex};

use anyhow::{Result, bail};
use bytes::Bytes;
#[cfg(any(test, all(target_os = "linux", feature = "io-uring")))]
use bytes::{Buf, BytesMut};
use tokio::sync::{mpsc, watch};

use crate::config::{IoBackendKind, ProcessNetworkConfig, SceneConfig};
use crate::process::{ProcessEventSender, ProcessQueueStats};

pub(crate) const MAX_FRAME_LEN: usize = 1024 * 1024;
pub(crate) const CONNECTION_OUTBOUND_FRAME_CAPACITY: usize = 4096;
pub(crate) const CONNECTION_OUTBOUND_BYTE_CAPACITY: usize = 4 * 1024 * 1024;
pub(crate) const WRITE_BATCH_FRAME_CAPACITY: usize = 64;
pub(crate) const WRITE_BATCH_BYTE_CAPACITY: usize = 256 * 1024;
pub(crate) const INNER_MSGCODE_START: u16 = 20_000;
pub(crate) const INNER_MSGCODE_END_EXCLUSIVE: u16 = 30_000;
pub(crate) const MAX_INNER_TOKEN_LEN: usize = 1024;

#[derive(Clone)]
pub(crate) struct ConnectionWriter {
    pub(crate) sender: mpsc::Sender<Bytes>,
    pub(crate) queued_bytes: Arc<AtomicUsize>,
    pub(crate) shutdown_tx: watch::Sender<bool>,
}

pub(crate) type ConnectionWriters = Arc<Mutex<HashMap<u64, ConnectionWriter>>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ConnectionKind {
    External,
    Internal,
}

#[cfg(any(test, all(target_os = "linux", feature = "io-uring")))]
pub(crate) struct RawFrameDecoder {
    buffered: BytesMut,
    next_frame_len: Option<usize>,
}

#[cfg(any(test, all(target_os = "linux", feature = "io-uring")))]
impl RawFrameDecoder {
    pub(crate) fn new(capacity: usize, first_frame_len: Option<usize>) -> Result<Self> {
        if let Some(length) = first_frame_len {
            validate_frame_length(length)?;
        }
        Ok(Self {
            buffered: BytesMut::with_capacity(capacity),
            next_frame_len: first_frame_len,
        })
    }

    pub(crate) fn push(&mut self, bytes: &[u8]) {
        self.buffered.extend_from_slice(bytes);
    }

    pub(crate) fn next_frame(&mut self) -> Result<Option<Bytes>> {
        let length = match self.next_frame_len {
            Some(length) => length,
            None => {
                if self.buffered.len() < 4 {
                    return Ok(None);
                }
                let length = u32::from_be_bytes(self.buffered[..4].try_into().unwrap()) as usize;
                validate_frame_length(length)?;
                self.buffered.advance(4);
                self.next_frame_len = Some(length);
                length
            }
        };
        if self.buffered.len() < length {
            return Ok(None);
        }
        self.next_frame_len = None;
        Ok(Some(self.buffered.split_to(length).freeze()))
    }
}

pub(crate) struct EndpointContext {
    pub(crate) scene_index: u32,
    pub(crate) scene: SceneConfig,
    pub(crate) event_tx: ProcessEventSender,
    pub(crate) writers: ConnectionWriters,
    pub(crate) next_connection_id: Arc<AtomicU64>,
    pub(crate) stats: Arc<ProcessQueueStats>,
}

/// Selects the operating-system I/O mechanism. The endpoint protocol remains
/// an independent choice in `SceneConfig::protocol`.
pub(crate) trait IoBackend: Send + Sync {
    fn name(&self) -> &'static str;
    fn start_endpoint(&self, context: EndpointContext) -> Result<()>;
}

pub(crate) fn create_io_backend(config: &ProcessNetworkConfig) -> Result<Arc<dyn IoBackend>> {
    match config.io_backend {
        IoBackendKind::Epoll => Ok(Arc::new(epoll::EpollIoBackend)),
        IoBackendKind::IoUring => create_uring_backend(config),
    }
}

#[cfg(all(target_os = "linux", feature = "io-uring"))]
fn create_uring_backend(config: &ProcessNetworkConfig) -> Result<Arc<dyn IoBackend>> {
    Ok(Arc::new(uring::UringIoBackend::new(
        config.uring_entries,
        config.uring_read_buffer_bytes,
    )))
}

#[cfg(not(all(target_os = "linux", feature = "io-uring")))]
fn create_uring_backend(_config: &ProcessNetworkConfig) -> Result<Arc<dyn IoBackend>> {
    bail!("network.ioBackend=io-uring requires Linux and a binary built with --features io-uring")
}

pub(crate) fn validate_frame_access(kind: ConnectionKind, frame: &[u8]) -> Result<()> {
    if frame.len() < 2 {
        bail!("frame is shorter than msgcode");
    }
    let msgcode = u16::from_be_bytes([frame[0], frame[1]]);
    let is_inner = (INNER_MSGCODE_START..INNER_MSGCODE_END_EXCLUSIVE).contains(&msgcode);
    match (kind, is_inner) {
        (ConnectionKind::External, true) => {
            bail!("external connection cannot send inner msgcode {msgcode}")
        }
        (ConnectionKind::Internal, false) => {
            bail!("internal connection cannot send client msgcode {msgcode}")
        }
        _ => Ok(()),
    }
}

#[cfg(any(test, all(target_os = "linux", feature = "io-uring")))]
pub(crate) fn validate_frame_length(length: usize) -> Result<()> {
    if (2..=MAX_FRAME_LEN).contains(&length) {
        Ok(())
    } else {
        bail!("invalid frame length: {length}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoder_extracts_multiple_frames_and_keeps_partial_tail() {
        let mut decoder = RawFrameDecoder::new(64, None).unwrap();
        let mut input = Vec::new();
        input.extend_from_slice(&2_u32.to_be_bytes());
        input.extend_from_slice(&[1, 2]);
        input.extend_from_slice(&3_u32.to_be_bytes());
        input.extend_from_slice(&[3]);
        decoder.push(&input);

        assert_eq!(decoder.next_frame().unwrap().unwrap().as_ref(), &[1, 2]);
        assert!(decoder.next_frame().unwrap().is_none());
        decoder.push(&[4, 5]);
        assert_eq!(decoder.next_frame().unwrap().unwrap().as_ref(), &[3, 4, 5]);
        assert!(decoder.next_frame().unwrap().is_none());
    }

    #[test]
    fn decoder_accepts_first_length_from_external_preamble() {
        let mut decoder = RawFrameDecoder::new(16, Some(2)).unwrap();
        decoder.push(&[9, 8]);
        assert_eq!(decoder.next_frame().unwrap().unwrap().as_ref(), &[9, 8]);
    }
}
