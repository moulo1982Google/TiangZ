//! 识别流协议并完成连接握手，之后把原生 TCP 半流或 WebSocket 交还连接所有者。 / Negotiates stream protocols before handing native TCP halves or a WebSocket to the connection owner.

use std::io::Cursor;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use tokio::io::{AsyncRead, AsyncReadExt, Chain, Join, join};
use tokio::net::TcpStream;
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::time::{Instant, timeout_at};
use tokio_tungstenite::{
    WebSocketStream, accept_async_with_config, tungstenite::protocol::WebSocketConfig,
};

use super::{ConnectionKind, MAX_FRAME_LEN, MAX_INNER_TOKEN_LEN, validate_connection_audience};
use crate::config::{EndpointAudience, EndpointProtocol};
use crate::transport::{INNER_HANDSHAKE_MAGIC, inner_token};

// 所有流协议的前导、HTTP 或内部认证共享一次预算，不因分片或协议选择重置。
// All stream preambles, HTTP and inner authentication share one budget without resetting on fragments/protocol choice.
pub(super) const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) type AcceptedWebSocket =
    WebSocketStream<Join<Chain<Cursor<[u8; 3]>, OwnedReadHalf>, OwnedWriteHalf>>;

pub(super) struct AcceptedTcp {
    pub(super) reader: OwnedReadHalf,
    pub(super) writer: OwnedWriteHalf,
    pub(super) kind: ConnectionKind,
    pub(super) first_frame_len: Option<usize>,
}

pub(super) enum AcceptedConnection {
    Tcp(AcceptedTcp),
    WebSocket(Box<AcceptedWebSocket>),
}

/// 完成连接协议握手；关闭的对端不会注册到 writer 表。 / Negotiates the connection before a closed peer can enter the writer map.
pub(super) async fn accept_connection(
    stream: TcpStream,
    protocol: EndpointProtocol,
    audience: EndpointAudience,
) -> Result<Option<AcceptedConnection>> {
    accept_until(
        stream,
        protocol,
        audience,
        Instant::now() + HANDSHAKE_TIMEOUT,
    )
    .await
}

/// 全部流握手阶段消耗同一单调期限，超时后丢弃流。 / Shares one monotonic deadline across all stream handshake stages and drops the stream on timeout.
async fn accept_until(
    stream: TcpStream,
    protocol: EndpointProtocol,
    audience: EndpointAudience,
    deadline: Instant,
) -> Result<Option<AcceptedConnection>> {
    timeout_at(deadline, negotiate_connection(stream, protocol, audience))
        .await
        .context("connection handshake timed out")?
}

/// 消费探测前缀后原样重放；等待分片时不重复 peek 已经可读的数据。 / Replays the consumed prefix and never polls an already-readable partial peek in a loop.
async fn negotiate_connection(
    mut stream: TcpStream,
    protocol: EndpointProtocol,
    audience: EndpointAudience,
) -> Result<Option<AcceptedConnection>> {
    let mut prefix = Cursor::new([0_u8; 3]);
    prefix.set_position(3);
    let is_websocket = match protocol {
        EndpointProtocol::Tcp => false,
        EndpointProtocol::WebSocket => true,
        EndpointProtocol::Auto => {
            match stream.read_exact(prefix.get_mut()).await {
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
                Err(error) => return Err(error.into()),
            }
            prefix.set_position(0);
            prefix.get_ref() == b"GET"
        }
        EndpointProtocol::Kcp => bail!("KCP requires a UDP listener"),
    };
    let (mut reader, writer) = stream.into_split();
    if is_websocket {
        validate_connection_audience(audience, ConnectionKind::External)?;
        let stream = join(prefix.chain(reader), writer);
        // 在载荷分配和分片重组阶段应用同一逻辑帧上限，而非接收完成后才拒绝。
        // Apply the logical frame bound during allocation/reassembly, before a full receive.
        let config = WebSocketConfig::default()
            .max_frame_size(Some(MAX_FRAME_LEN))
            .max_message_size(Some(MAX_FRAME_LEN));
        return Ok(Some(AcceptedConnection::WebSocket(Box::new(
            accept_async_with_config(stream, Some(config)).await?,
        ))));
    }
    let Some((kind, first_frame_len)) = read_raw_preamble(&mut prefix.chain(&mut reader)).await?
    else {
        return Ok(None);
    };
    validate_connection_audience(audience, kind)?;
    Ok(Some(AcceptedConnection::Tcp(AcceptedTcp {
        reader,
        writer,
        kind,
        first_frame_len,
    })))
}

/// 验证内部 TCP 凭据，或保留外部连接的第一帧长度。 / Validates inner TCP credentials or retains the first external frame length.
async fn read_raw_preamble(
    reader: &mut (impl AsyncRead + Unpin),
) -> Result<Option<(ConnectionKind, Option<usize>)>> {
    let prefix = match reader.read_u32().await {
        Ok(prefix) => prefix,
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if prefix != INNER_HANDSHAKE_MAGIC {
        return Ok(Some((ConnectionKind::External, Some(prefix as usize))));
    }
    let token_len = reader.read_u16().await? as usize;
    if token_len == 0 || token_len > MAX_INNER_TOKEN_LEN {
        bail!("invalid inner handshake token length: {token_len}");
    }
    let mut token = vec![0_u8; token_len];
    reader.read_exact(&mut token).await?;
    if token != inner_token().as_bytes() {
        bail!("invalid inner handshake token");
    }
    Ok(Some((ConnectionKind::Internal, None)))
}

#[cfg(test)]
#[path = "handshake_tests.rs"]
mod tests;
