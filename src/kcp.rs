//! 使用 Rust 独占缓冲区和显式参数配置包装固定版本的 C KCP 实现。 / Wraps the pinned C KCP implementation with owned Rust buffers and explicit profiles.

#[cfg(test)]
mod buffer_tests;
mod buffers;

use crate::buffer_budget::BufferBudget;
use buffers::{CacheReservation, OutputQueue, SESSION_BUFFER_LIMIT};
use std::ffi::{c_char, c_int, c_long, c_void};
use std::ptr::NonNull;
use std::sync::Arc;

use anyhow::{Result, bail};
use bytes::Bytes;

#[repr(C)]
struct IKcpcb {
    _private: [u8; 0],
}

type OutputCallback = unsafe extern "C" fn(
    buffer: *const c_char,
    length: c_int,
    kcp: *mut IKcpcb,
    user: *mut c_void,
) -> c_int;

unsafe extern "C" {
    fn ikcp_create(conv: u32, user: *mut c_void) -> *mut IKcpcb;
    fn ikcp_release(kcp: *mut IKcpcb);
    fn ikcp_setoutput(kcp: *mut IKcpcb, output: Option<OutputCallback>);
    fn ikcp_recv(kcp: *mut IKcpcb, buffer: *mut c_char, length: c_int) -> c_int;
    fn ikcp_send(kcp: *mut IKcpcb, buffer: *const c_char, length: c_int) -> c_int;
    fn ikcp_update(kcp: *mut IKcpcb, current: u32);
    fn ikcp_check(kcp: *const IKcpcb, current: u32) -> u32;
    fn ikcp_input(kcp: *mut IKcpcb, data: *const c_char, size: c_long) -> c_int;
    fn ikcp_peeksize(kcp: *const IKcpcb) -> c_int;
    fn ikcp_setmtu(kcp: *mut IKcpcb, mtu: c_int) -> c_int;
    fn ikcp_wndsize(kcp: *mut IKcpcb, send_window: c_int, receive_window: c_int) -> c_int;
    fn ikcp_nodelay(
        kcp: *mut IKcpcb,
        nodelay: c_int,
        interval: c_int,
        resend: c_int,
        disable_congestion_control: c_int,
    ) -> c_int;
    fn ets_kcp_set_min_rto(kcp: *mut IKcpcb, min_rto: u32);
    fn ets_kcp_initial_buffer_bound(mtu: u32) -> u64;
    fn ets_kcp_buffer_bound(kcp: *const IKcpcb) -> u64;
    fn ets_kcp_send_buffer_bound(kcp: *const IKcpcb, length: u32) -> u64;
    fn ets_kcp_input_buffer_bound(kcp: *const IKcpcb, pushes: u32) -> u64;
    #[cfg(test)]
    fn ets_kcp_get_min_rto(kcp: *const IKcpcb) -> u32;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KcpProfile {
    Inner,
    Outer,
}

#[derive(Clone, Copy, Debug)]
pub struct KcpConfig {
    pub(crate) mtu: u16,
    pub(crate) send_window: u16,
    pub(crate) receive_window: u16,
    pub(crate) nodelay: bool,
    pub(crate) interval_ms: u16,
    pub(crate) fast_resend: u16,
    pub(crate) disable_congestion_control: bool,
    pub(crate) min_rto_ms: u16,
}

impl KcpConfig {
    pub fn for_profile(profile: KcpProfile) -> Self {
        let (mtu, send_window, receive_window) = match profile {
            KcpProfile::Inner => (1400, 1024, 1024),
            KcpProfile::Outer => (470, 256, 256),
        };
        Self {
            mtu,
            send_window,
            receive_window,
            nodelay: true,
            interval_ms: 10,
            fast_resend: 2,
            disable_congestion_control: true,
            min_rto_ms: 30,
        }
    }
}

pub struct KcpSession {
    kcp: NonNull<IKcpcb>,
    output: Box<OutputQueue>,
    cache: CacheReservation,
    mss: usize,
}

// KCP state has exclusive ownership and its C callback only touches the boxed
// output queue synchronously. Moving a session between runtime worker threads
// is safe; sharing one concurrently is not.
unsafe impl Send for KcpSession {}

impl KcpSession {
    pub fn new(conv: u32, config: KcpConfig) -> Result<Self> {
        Self::new_with_budget(conv, config, BufferBudget::new(SESSION_BUFFER_LIMIT))
    }

    /// 会话仍受独立 4 MiB 限额，并共享调用方的进程额度。 / Retains a 4 MiB per-session limit while sharing the caller's process budget.
    pub fn new_with_budget(
        conv: u32,
        config: KcpConfig,
        process: Arc<BufferBudget>,
    ) -> Result<Self> {
        Self::new_with_limits(conv, config, process, SESSION_BUFFER_LIMIT)
    }

    fn new_with_limits(
        conv: u32,
        config: KcpConfig,
        process: Arc<BufferBudget>,
        session_limit: usize,
    ) -> Result<Self> {
        validate_config(config)?;
        let mut output = Box::new(OutputQueue::new(process, session_limit));
        let initial =
            usize::try_from(unsafe { ets_kcp_initial_buffer_bound(u32::from(config.mtu)) })?;
        let cache = CacheReservation::new(&output.session, &output.process, initial)?;
        let user = (&mut *output) as *mut OutputQueue as *mut c_void;
        let kcp = NonNull::new(unsafe { ikcp_create(conv, user) })
            .ok_or_else(|| anyhow::anyhow!("ikcp_create failed"))?;

        let mut session = Self {
            kcp,
            output,
            cache,
            mss: usize::from(config.mtu) - 24,
        };
        unsafe {
            ikcp_setoutput(session.kcp.as_ptr(), Some(kcp_output));
        }
        session.apply_config(config)?;
        session.reconcile_cache();
        Ok(session)
    }

    pub fn send(&mut self, payload: &[u8]) -> Result<()> {
        self.output.check()?;
        let length = c_int::try_from(payload.len())?;
        let bound = unsafe { ets_kcp_send_buffer_bound(self.kcp.as_ptr(), length as u32) };
        if bound == 0 {
            bail!("KCP message exceeds the pinned implementation's fragment limit");
        }
        self.cache.resize(usize::try_from(bound)?)?;
        let result =
            unsafe { ikcp_send(self.kcp.as_ptr(), payload.as_ptr().cast::<c_char>(), length) };
        self.reconcile_cache();
        if result < 0 {
            bail!("ikcp_send failed with code {result}");
        }
        Ok(())
    }

    pub fn input(&mut self, datagram: &[u8]) -> Result<()> {
        self.output.check()?;
        let length = c_long::try_from(datagram.len())?;
        let pushes = input_push_count(datagram, self.mss)?;
        let bound = unsafe { ets_kcp_input_buffer_bound(self.kcp.as_ptr(), pushes) };
        self.cache.resize(usize::try_from(bound)?)?;
        let result = unsafe {
            ikcp_input(
                self.kcp.as_ptr(),
                datagram.as_ptr().cast::<c_char>(),
                length,
            )
        };
        self.reconcile_cache();
        if result < 0 {
            bail!("ikcp_input rejected datagram with code {result}");
        }
        Ok(())
    }

    /// 输出回调拒绝须显式终结 Session，不允许静默丢掉可靠报文。 / Output callback rejection terminates the session explicitly instead of silently losing reliable data.
    pub fn update(&mut self, now_ms: u32) -> Result<()> {
        self.output.check()?;
        unsafe { ikcp_update(self.kcp.as_ptr(), now_ms) };
        self.output.check()
    }

    pub fn next_update_ms(&self, now_ms: u32) -> u32 {
        unsafe { ikcp_check(self.kcp.as_ptr(), now_ms) }
    }

    pub fn receive(&mut self) -> Result<Option<Vec<u8>>> {
        self.output.check()?;
        let length = unsafe { ikcp_peeksize(self.kcp.as_ptr()) };
        if length < 0 {
            return Ok(None);
        }
        let mut payload = vec![0_u8; usize::try_from(length)?];
        let received = unsafe {
            ikcp_recv(
                self.kcp.as_ptr(),
                payload.as_mut_ptr().cast::<c_char>(),
                length,
            )
        };
        self.reconcile_cache();
        if received < 0 {
            bail!("ikcp_recv failed with code {received}");
        }
        payload.truncate(usize::try_from(received)?);
        Ok(Some(payload))
    }

    /// 返回的字节（含克隆/切片）保留额度至最后引用释放。 / Returned bytes, clones and slices retain their quota until the final reference drops.
    pub fn take_output(&mut self) -> Option<Bytes> {
        self.output.datagrams.pop_front()
    }

    fn reconcile_cache(&mut self) {
        let bound = unsafe { ets_kcp_buffer_bound(self.kcp.as_ptr()) };
        self.cache
            .shrink_to(usize::try_from(bound).expect("admitted KCP cache fits usize"));
    }

    fn apply_config(&mut self, config: KcpConfig) -> Result<()> {
        let mtu_result = unsafe { ikcp_setmtu(self.kcp.as_ptr(), c_int::from(config.mtu)) };
        if mtu_result < 0 {
            bail!("ikcp_setmtu failed with code {mtu_result}");
        }
        let window_result = unsafe {
            ikcp_wndsize(
                self.kcp.as_ptr(),
                c_int::from(config.send_window),
                c_int::from(config.receive_window),
            )
        };
        if window_result < 0 {
            bail!("ikcp_wndsize failed with code {window_result}");
        }
        let nodelay_result = unsafe {
            ikcp_nodelay(
                self.kcp.as_ptr(),
                c_int::from(config.nodelay),
                c_int::from(config.interval_ms),
                c_int::from(config.fast_resend),
                c_int::from(config.disable_congestion_control),
            )
        };
        if nodelay_result < 0 {
            bail!("ikcp_nodelay failed with code {nodelay_result}");
        }
        unsafe {
            ets_kcp_set_min_rto(self.kcp.as_ptr(), u32::from(config.min_rto_ms));
        }
        Ok(())
    }

    #[cfg(test)]
    fn min_rto_ms(&self) -> u32 {
        unsafe { ets_kcp_get_min_rto(self.kcp.as_ptr()) }
    }
}

impl Drop for KcpSession {
    fn drop(&mut self) {
        unsafe { ikcp_release(self.kcp.as_ptr()) };
    }
}

fn validate_config(config: KcpConfig) -> Result<()> {
    if !(50..=1500).contains(&config.mtu) {
        bail!("KCP MTU must be between 50 and 1500");
    }
    if config.send_window == 0 || config.receive_window == 0 {
        bail!("KCP send and receive windows must not be zero");
    }
    if !(10..=5_000).contains(&config.interval_ms) {
        bail!("KCP interval must be between 10 and 5000 milliseconds");
    }
    if config.min_rto_ms == 0 {
        bail!("KCP min RTO must not be zero");
    }
    Ok(())
}

unsafe extern "C" fn kcp_output(
    buffer: *const c_char,
    length: c_int,
    _kcp: *mut IKcpcb,
    user: *mut c_void,
) -> c_int {
    if user.is_null() {
        return -1;
    }
    let output = unsafe { &mut *user.cast::<OutputQueue>() };
    if buffer.is_null() || length < 0 {
        output.failure = Some("invalid C output buffer".into());
        return -1;
    }
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let bytes = unsafe { std::slice::from_raw_parts(buffer.cast::<u8>(), length as usize) };
        output.push(bytes)
    }));
    match result {
        Ok(Ok(())) => 0,
        Ok(Err(error)) => {
            if output.failure.is_none() {
                output.failure = Some(error.to_string());
            }
            -1
        }
        Err(_) => {
            output.failure = Some("output callback panicked".into());
            -1
        }
    }
}

// Validate before C allocation: every PUSH segment must fit the configured MSS used by the bound.
fn input_push_count(mut datagram: &[u8], mss: usize) -> Result<u32> {
    if datagram.len() < 24 {
        bail!("KCP datagram is shorter than a segment header");
    }
    let mut pushes = 0_u32;
    while datagram.len() >= 24 {
        let length = u32::from_le_bytes(datagram[20..24].try_into().unwrap()) as usize;
        if length > datagram.len() - 24 {
            bail!("KCP segment payload is truncated");
        }
        match datagram[4] {
            81 => {
                if length > mss {
                    bail!("KCP segment exceeds configured MSS");
                }
                pushes = pushes
                    .checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("too many KCP segments"))?;
            }
            82..=84 => {}
            _ => bail!("invalid KCP segment command"),
        }
        datagram = &datagram[24 + length..];
    }
    Ok(pushes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_kcp_sessions_exchange_message_boundaries() {
        let config = KcpConfig::for_profile(KcpProfile::Outer);
        let mut left = KcpSession::new(42, config).unwrap();
        let mut right = KcpSession::new(42, config).unwrap();
        left.send(b"first").unwrap();
        left.send(&vec![7_u8; 4096]).unwrap();

        let mut received = Vec::new();
        for now_ms in (0..2_000).step_by(10) {
            left.update(now_ms).unwrap();
            right.update(now_ms).unwrap();
            transfer_output(&mut left, &mut right);
            transfer_output(&mut right, &mut left);
            while let Some(message) = right.receive().unwrap() {
                received.push(message);
            }
            if received.len() == 2 {
                break;
            }
        }

        assert_eq!(received[0], b"first");
        assert_eq!(received[1], vec![7_u8; 4096]);
        assert!(left.next_update_ms(2_000) >= 2_000);
    }

    #[test]
    fn official_kcp_retransmits_a_dropped_datagram() {
        let config = KcpConfig::for_profile(KcpProfile::Outer);
        let mut left = KcpSession::new(7, config).unwrap();
        let mut right = KcpSession::new(7, config).unwrap();
        let expected = vec![0x5a_u8; 32 * 1024];
        left.send(&expected).unwrap();
        let mut dropped_first_datagram = false;
        let mut actual = None;

        for now_ms in (0..10_000).step_by(10) {
            left.update(now_ms).unwrap();
            right.update(now_ms).unwrap();
            while let Some(datagram) = left.take_output() {
                if !dropped_first_datagram {
                    dropped_first_datagram = true;
                    continue;
                }
                right.input(&datagram).unwrap();
            }
            transfer_output(&mut right, &mut left);
            if let Some(message) = right.receive().unwrap() {
                actual = Some(message);
                break;
            }
        }

        assert!(dropped_first_datagram);
        assert_eq!(actual.as_deref(), Some(expected.as_slice()));
    }

    #[test]
    fn et_profiles_apply_inner_and_outer_limits() {
        let inner = KcpConfig::for_profile(KcpProfile::Inner);
        assert_eq!(
            (inner.mtu, inner.send_window, inner.receive_window),
            (1400, 1024, 1024)
        );
        let outer = KcpConfig::for_profile(KcpProfile::Outer);
        assert_eq!(
            (outer.mtu, outer.send_window, outer.receive_window),
            (470, 256, 256)
        );
        assert_eq!(outer.min_rto_ms, 30);

        let mut session = KcpSession::new(11, outer).unwrap();
        assert_eq!(session.min_rto_ms(), 30);
        session.send(&vec![1_u8; 4096]).unwrap();
        session.update(0).unwrap();
        while let Some(datagram) = session.take_output() {
            assert!(datagram.len() <= 470);
        }
    }

    fn transfer_output(source: &mut KcpSession, target: &mut KcpSession) {
        while let Some(datagram) = source.take_output() {
            target.input(&datagram).unwrap();
        }
    }
}
