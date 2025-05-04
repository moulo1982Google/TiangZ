use std::collections::HashMap;
use std::sync::{LazyLock, Arc, atomic::{AtomicUsize, Ordering}};
use std::io;
use std::future::pending;
use std::any::Any;
use std::thread;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, broadcast};
use tokio::signal;
use bytes::{BytesMut, Buf};
use dashmap::DashMap;
use tokio::time::{sleep, Duration};
use async_trait::async_trait;
use tracing::{trace, error, info, warn, debug};
use tokio_kcp::KcpStream;

use gen_macro::{IActorLocationRpcHandler, IActorLocationRpcRequest, IActorLocationRpcResponse, 
    IActorLocationMessageRequest, IActorLocationMessageHandler, Singleton};


use crate::errors::my_errors::RetResult;
use crate::errors::my_errors::MyError;

#[derive(Debug)]
pub struct ProtocolParser {
    buffer: BytesMut,
    max_frame_size: usize,
    pending_consume: usize, // 新增：跟踪待消费的字节数
}

impl ProtocolParser {
    pub fn new() -> Self {
        Self {
            buffer: BytesMut::with_capacity(32 * 1024),
            max_frame_size: 2 * 1024,
            pending_consume: 0,
        }
    }

    pub fn with_max_frame_size(mut self, size: usize) -> Self {
        self.max_frame_size = size;
        self.buffer.reserve(size * 128);
        self
    }

    /// 内部方法：消费待处理的数据
    fn consume_pending(&mut self) {
        if self.pending_consume > 0 {
            self.buffer.advance(self.pending_consume);
            self.pending_consume = 0;
        }
    }

    /// 解析帧数据，返回帧的长度
    fn parse_frame_length(&self) -> io::Result<Option<usize>> {
        // 检查长度头是否完整
        if self.buffer.len() < 2 {
            return Ok(None);
        }

        // 读取长度头
        let len = {
            let len_bytes = &self.buffer[..2];
            i16::from_be_bytes([len_bytes[0], len_bytes[1]]) as usize
        };

        // 验证帧长度
        if len > self.max_frame_size {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("Frame size {} exceeds limit {}", len, self.max_frame_size),
            ));
        }

        // 检查帧数据是否完整
        if self.buffer.len() < 2 + len {
            return Ok(None);
        }

        Ok(Some(len))
    }

    /// 异步读取完整帧
    pub async fn read_frame<R: AsyncReadExt + Unpin>(
        &mut self,
        reader: &mut R,
    ) -> io::Result<Option<&[u8]>> {
        self.consume_pending(); // 先消费之前的数据

        loop {
            match self.parse_frame_length()? {
                Some(len) => {
                    // 获取帧数据引用
                    let frame = &self.buffer[2..2 + len];
                    // 记录待消费的字节数（2字节头 + 数据长度）
                    self.pending_consume = 2 + len;
                    return Ok(Some(frame));
                }
                None => {
                    // 需要更多数据
                    if reader.read_buf(&mut self.buffer).await? == 0 {
                        return Ok(None);
                    }
                }
            }
        }
    }

    pub async fn read_frame_from_kcp<R: AsyncReadExt + Unpin>(
        &mut self,
        reader: &mut R,
    ) -> io::Result<Option<&[u8]>> {
        self.consume_pending(); // 先消费之前的数据

        loop {
            match self.parse_frame_length()? {
                Some(len) => {
                    // 获取帧数据引用
                    let frame = &self.buffer[2..2 + len];
                    // 记录待消费的字节数（2字节头 + 数据长度）
                    self.pending_consume = 2 + len;
                    return Ok(Some(frame));
                }
                None => {
                    let mut temp_buff = [0u8; 128];
                    tokio::select! {
                        ret = reader.read(&mut temp_buff) => {
                            let n = ret?;
                            if n == 0 {
                                return Ok(None);
                            } else {
                                // 需要更多数据
                                self.buffer.extend_from_slice(&temp_buff[..n]);
                                continue;
                            }
                        }   
                    }
                }
            }
        }
    }

    /// 获取当前缓冲区状态
    pub fn buffer_stats(&self) -> (usize, usize) {
        (self.buffer.len(), self.buffer.capacity())
    }
}