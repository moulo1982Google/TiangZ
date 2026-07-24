//! 提供冒烟测试与非浏览器 SDK 验证使用的 Native KCP 客户端。 / Provides the native KCP client used by smoke tests and non-browser SDK validation.

use std::net::SocketAddr;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Result, bail};
use tokio::net::UdpSocket;

use crate::kcp::{KcpConfig, KcpProfile, KcpSession};
use crate::kcp_wire::{
    ACCEPT, ACCEPT_BYTES, CHALLENGE, CHALLENGE_BYTES, CLOSE, CLOSE_BYTES, CONNECT, DATA,
    DATA_HEADER_BYTES, HELLO, HELLO_BYTES, PROTOCOL_VERSION, read_u32, read_u64, write_u32,
    write_u64,
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const CONNECT_RETRY: Duration = Duration::from_millis(300);

pub struct KcpClient {
    socket: UdpSocket,
    local_conn: u32,
    remote_conn: u32,
    kcp: KcpSession,
    started_at: Instant,
}

impl KcpClient {
    pub async fn connect(remote: SocketAddr) -> Result<Self> {
        let bind_addr = if remote.is_ipv6() {
            "[::]:0"
        } else {
            "0.0.0.0:0"
        };
        let socket = UdpSocket::bind(bind_addr).await?;
        socket.connect(remote).await?;
        let seed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let local_conn = ((seed as u32) | 100).max(100);
        let nonce = (seed as u64) ^ ((std::process::id() as u64) << 32);
        let remote_conn = handshake(&socket, local_conn, nonce).await?;
        let kcp = KcpSession::new(remote_conn, KcpConfig::for_profile(KcpProfile::Outer))?;
        Ok(Self {
            socket,
            local_conn,
            remote_conn,
            kcp,
            started_at: Instant::now(),
        })
    }

    pub async fn request(&mut self, frame: &[u8], timeout: Duration) -> Result<Vec<u8>> {
        self.kcp.send(frame)?;
        let deadline = Instant::now() + timeout;
        let mut packet = vec![0_u8; 2048];
        let mut tick = tokio::time::interval(Duration::from_millis(10));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            if Instant::now() >= deadline {
                bail!("KCP request timed out after {}ms", timeout.as_millis());
            }
            tokio::select! {
                received = self.socket.recv(&mut packet) => {
                    let length = received?;
                    self.handle_packet(&packet[..length])?;
                }
                _ = tick.tick() => {}
            }
            self.kcp.update(self.elapsed_ms());
            self.flush_output().await?;
            if let Some(frame) = self.kcp.receive()? {
                return Ok(frame);
            }
        }
    }

    pub async fn close(self) -> Result<()> {
        let mut packet = [0_u8; CLOSE_BYTES];
        packet[0] = CLOSE;
        packet[1] = PROTOCOL_VERSION;
        write_u32(&mut packet, 2, self.local_conn);
        write_u32(&mut packet, 6, self.remote_conn);
        self.socket.send(&packet).await?;
        Ok(())
    }

    fn handle_packet(&mut self, packet: &[u8]) -> Result<()> {
        if packet.len() < DATA_HEADER_BYTES + 24
            || packet[0] != DATA
            || packet[1] != PROTOCOL_VERSION
        {
            return Ok(());
        }
        let sender_conn = read_u32(packet, 2);
        let receiver_conn = read_u32(packet, 6);
        if sender_conn != self.remote_conn || receiver_conn != self.local_conn {
            return Ok(());
        }
        self.kcp.input(&packet[DATA_HEADER_BYTES..])?;
        Ok(())
    }

    async fn flush_output(&mut self) -> Result<()> {
        while let Some(datagram) = self.kcp.take_output() {
            let mut packet = Vec::with_capacity(DATA_HEADER_BYTES + datagram.len());
            packet.push(DATA);
            packet.push(PROTOCOL_VERSION);
            packet.extend_from_slice(&self.local_conn.to_le_bytes());
            packet.extend_from_slice(&self.remote_conn.to_le_bytes());
            packet.extend_from_slice(&datagram);
            self.socket.send(&packet).await?;
        }
        Ok(())
    }

    fn elapsed_ms(&self) -> u32 {
        self.started_at.elapsed().as_millis() as u32
    }
}

async fn handshake(socket: &UdpSocket, local_conn: u32, nonce: u64) -> Result<u32> {
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    let mut hello = [0_u8; HELLO_BYTES];
    hello[0] = HELLO;
    hello[1] = PROTOCOL_VERSION;
    write_u32(&mut hello, 2, local_conn);
    write_u64(&mut hello, 6, nonce);
    let mut packet = [0_u8; 2048];

    loop {
        socket.send(&hello).await?;
        let received = tokio::time::timeout(CONNECT_RETRY, socket.recv(&mut packet)).await;
        let Ok(Ok(length)) = received else {
            if Instant::now() >= deadline {
                bail!("KCP handshake timed out waiting for challenge");
            }
            continue;
        };
        if length != CHALLENGE_BYTES
            || packet[0] != CHALLENGE
            || packet[1] != PROTOCOL_VERSION
            || read_u32(&packet, 2) != local_conn
            || read_u64(&packet, 6) != nonce
        {
            continue;
        }
        let challenge = packet[..CHALLENGE_BYTES].to_vec();
        let mut connect = challenge;
        connect[0] = CONNECT;
        loop {
            socket.send(&connect).await?;
            let received = tokio::time::timeout(CONNECT_RETRY, socket.recv(&mut packet)).await;
            let Ok(Ok(length)) = received else {
                if Instant::now() >= deadline {
                    bail!("KCP handshake timed out waiting for accept");
                }
                continue;
            };
            if length == ACCEPT_BYTES
                && packet[0] == ACCEPT
                && packet[1] == PROTOCOL_VERSION
                && read_u32(&packet, 6) == local_conn
            {
                return Ok(read_u32(&packet, 2));
            }
        }
    }
}
