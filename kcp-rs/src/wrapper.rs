use std::os::raw::{c_int, c_void};
use std::ptr;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::KcpError;
use crate::ffi;

/// 线程安全的 KCP 封装
pub struct Kcp {
    kcp_ptr: *mut ffi::ikcpcb,
}

impl Kcp {
    /// 创建新 KCP 实例
    pub fn new(conv: u32, user_data: *mut c_void) -> Result<Self, KcpError> {
        unsafe {
            let kcp_ptr = ffi::ikcp_create(conv, user_data);
            if kcp_ptr.is_null() {
                Err(KcpError::Unknown(-1))
            } else {
                Ok(Self { kcp_ptr })
            }
        }
    }

    /// 发送数据
    pub fn send(&mut self, buf: &[u8]) -> Result<(), KcpError> {
        let ret = unsafe {
            ffi::ikcp_send(
                self.kcp_ptr,
                buf.as_ptr() as *const i8,
                buf.len() as c_int,
            )
        };
        if ret < 0 {
            Err(ret.into())
        } else {
            Ok(())
        }
    }

    /// 接收数据
    pub fn recv(&mut self, buf: &mut [u8]) -> Result<usize, KcpError> {
        let ret = unsafe {
            ffi::ikcp_recv(
                self.kcp_ptr,
                buf.as_mut_ptr() as *mut i8,
                buf.len() as c_int,
            )
        };
        if ret < 0 {
            Err(ret.into())
        } else {
            Ok(ret as usize)
        }
    }

    /// 更新 KCP 状态
    pub fn update(&mut self, current: u32) {
        unsafe {
            ffi::ikcp_update(self.kcp_ptr, current);
        }
    }

    /// 设置快速模式参数
    pub fn set_nodelay(&mut self, nodelay: i32, interval: i32, resend: i32, nc: i32) {
        unsafe {
            ffi::ikcp_nodelay(self.kcp_ptr, nodelay, interval, resend, nc);
        }
    }

    /// 设置窗口大小
    pub fn set_wndsize(&mut self, sndwnd: i32, rcvwnd: i32) {
        unsafe {
            ffi::ikcp_wndsize(self.kcp_ptr, sndwnd, rcvwnd);
        }
    }
}

impl Drop for Kcp {
    fn drop(&mut self) {
        unsafe {
            ffi::ikcp_release(self.kcp_ptr);
        }
    }
}

/// 获取当前时间戳（毫秒）
pub fn current_time_ms() -> u32 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u32
}