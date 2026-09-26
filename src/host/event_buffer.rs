//! 将原 Host 字节所有者交给 V8，并观测最后引用释放前的整块存储。 / Transfers original Host byte ownership to V8 and measures whole stores until their final reference drops.

use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

use deno_core::{ToV8, convert::Uint8Array, v8};
use deno_error::JsErrorBox;

use super::event_admission::EventReservation;
use crate::process::control_ingress::ControlReservation;

#[derive(Default)]
pub(crate) struct HostBackingStoreStats {
    bytes: AtomicU64,
    max_bytes: AtomicU64,
    buffers: AtomicU64,
    created_total: AtomicU64,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct HostBackingStoreSnapshot {
    pub(crate) bytes: u64,
    pub(crate) max_bytes: u64,
    pub(crate) buffers: u64,
    pub(crate) created_total: u64,
}

impl HostBackingStoreStats {
    /// 分别读取原子值；GC 可并发释放，不承诺跨字段事务快照。 / Reads atomic counters independently; concurrent GC can release stores between fields.
    pub(crate) fn snapshot(&self) -> HostBackingStoreSnapshot {
        HostBackingStoreSnapshot {
            bytes: self.bytes.load(Ordering::Relaxed),
            max_bytes: self.max_bytes.load(Ordering::Relaxed),
            buffers: self.buffers.load(Ordering::Relaxed),
            created_total: self.created_total.load(Ordering::Relaxed),
        }
    }
}

/// 编码字节、原 Process 账本及控制名额一起跨过 take-batch。 / Carries encoded bytes, their original Process ledger and control reservations through take-batch.
#[derive(Default)]
pub(crate) struct HostEventPayload {
    pub(crate) backing_reservations: Vec<EventReservation>,
    pub(crate) bytes: Vec<u8>,
    pub(crate) reservations: Vec<ControlReservation>,
    pub(crate) backing_stats: Arc<HostBackingStoreStats>,
}

pub(super) struct HostEventBuffer {
    pub(super) reservations: Vec<EventReservation>,
    pub(super) bytes: Vec<u8>,
    pub(super) stats: Arc<HostBackingStoreStats>,
}

struct OwnedEventBytes {
    _reservations: Vec<EventReservation>,
    bytes: Box<[u8]>,
    stats: Arc<HostBackingStoreStats>,
}

impl AsMut<[u8]> for OwnedEventBytes {
    fn as_mut(&mut self) -> &mut [u8] {
        &mut self.bytes
    }
}

impl Drop for OwnedEventBytes {
    /// 最后 Native/V8 引用触发，无 TS 回调、异步等待或对当前 Runtime 的查找。 / Runs at the last Native/V8 reference without JS callbacks, waiting or current-runtime lookup.
    fn drop(&mut self) {
        self.stats
            .bytes
            .fetch_sub(self.bytes.len() as u64, Ordering::Relaxed);
        self.stats.buffers.fetch_sub(1, Ordering::Relaxed);
    }
}

impl<'a> ToV8<'a> for HostEventBuffer {
    type Error = JsErrorBox;

    /// 沿用 Box slice 转交，不逐帧复制；空 take 不创建受观测的存储。 / Preserves boxed-slice transfer without per-frame copies; empty takes create no measured store.
    fn to_v8<'i>(
        self,
        scope: &mut v8::PinScope<'a, 'i>,
    ) -> Result<v8::Local<'a, v8::Value>, Self::Error> {
        if self.bytes.is_empty() {
            return Uint8Array::from(self.bytes).to_v8(scope);
        }
        let bytes = self.bytes.into_boxed_slice();
        let len = bytes.len();
        let used = self.stats.bytes.fetch_add(len as u64, Ordering::Relaxed) + len as u64;
        self.stats.max_bytes.fetch_max(used, Ordering::Relaxed);
        self.stats.buffers.fetch_add(1, Ordering::Relaxed);
        self.stats.created_total.fetch_add(1, Ordering::Relaxed);
        let backing = v8::ArrayBuffer::new_backing_store_from_bytes(Box::new(OwnedEventBytes {
            _reservations: self.reservations,
            bytes,
            stats: self.stats,
        }))
        .make_shared();
        let buffer = v8::ArrayBuffer::with_backing_store(scope, &backing);
        v8::Uint8Array::new(scope, buffer, 0, len)
            .ok_or_else(|| JsErrorBox::type_error("Failed to create Host event array"))
            .map(|value| value.into())
    }
}
