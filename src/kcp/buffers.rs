//! KCP 缓存的两级预留与输出所有权。 / Two-level reservations and output ownership for KCP buffers.

use std::collections::VecDeque;
use std::sync::Arc;

use anyhow::{Result, bail};
use bytes::Bytes;

use crate::buffer_budget::{BufferBudget, BufferReservation};

pub(super) const SESSION_BUFFER_LIMIT: usize = 4 * 1024 * 1024;

pub(super) struct CacheReservation {
    session: BufferReservation,
    process: BufferReservation,
    bytes: usize,
}

impl CacheReservation {
    pub(super) fn new(
        session: &Arc<BufferBudget>,
        process: &Arc<BufferBudget>,
        bytes: usize,
    ) -> Result<Self> {
        let session = session
            .try_reserve(bytes)
            .ok_or_else(|| anyhow::anyhow!("KCP session byte limit is full"))?;
        let process = process
            .try_reserve(bytes)
            .ok_or_else(|| anyhow::anyhow!("KCP process byte limit is full"))?;
        Ok(Self {
            session,
            process,
            bytes,
        })
    }

    pub(super) fn resize(&mut self, bytes: usize) -> Result<()> {
        if !self.session.try_resize(bytes) {
            bail!("KCP session byte limit is full");
        }
        if !self.process.try_resize(bytes) {
            // Failed process growth must return the already acquired session delta.
            assert!(self.session.try_resize(self.bytes));
            bail!("KCP process byte limit is full");
        }
        self.bytes = bytes;
        Ok(())
    }

    pub(super) fn shrink_to(&mut self, bytes: usize) {
        assert!(
            bytes <= self.bytes,
            "KCP allocation exceeded its preflight bound"
        );
        self.resize(bytes)
            .expect("shrinking a reservation cannot fail");
    }
}

struct OutputBytes {
    bytes: Vec<u8>,
    _reservation: CacheReservation,
}

impl AsRef<[u8]> for OutputBytes {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}

pub(super) struct OutputQueue {
    pub(super) datagrams: VecDeque<Bytes>,
    pub(super) session: Arc<BufferBudget>,
    pub(super) process: Arc<BufferBudget>,
    pub(super) failure: Option<String>,
}

impl OutputQueue {
    pub(super) fn new(process: Arc<BufferBudget>, session_limit: usize) -> Self {
        Self {
            datagrams: VecDeque::new(),
            session: BufferBudget::new(session_limit),
            process,
            failure: None,
        }
    }

    pub(super) fn push(&mut self, bytes: &[u8]) -> Result<()> {
        self.check()?;
        let reservation = CacheReservation::new(&self.session, &self.process, bytes.len())?;
        self.datagrams.push_back(Bytes::from_owner(OutputBytes {
            bytes: bytes.to_vec(),
            _reservation: reservation,
        }));
        Ok(())
    }

    pub(super) fn check(&self) -> Result<()> {
        if let Some(failure) = &self.failure {
            bail!("KCP output failed; session must close: {failure}");
        }
        Ok(())
    }
}
