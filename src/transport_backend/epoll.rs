//! 实现可移植的 Tokio/epoll 或 IOCP 流后端，并支持批量写入。 / Implements the portable Tokio/epoll-or-IOCP stream backend with batched writes.

use std::io::IoSlice;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use anyhow::{Context, Result, bail};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::{accept_async, tungstenite::Message};

use super::{
    CONNECTION_OUTBOUND_FRAME_CAPACITY, ConnectionKind, ConnectionWriter, EndpointContext,
    IoBackend, MAX_FRAME_LEN, MAX_INNER_TOKEN_LEN, WRITE_BATCH_BYTE_CAPACITY,
    WRITE_BATCH_FRAME_CAPACITY, validate_frame_access,
};
use crate::config::EndpointProtocol;
use crate::process::ProcessEvent;
use crate::transport::{INNER_HANDSHAKE_MAGIC, inner_token};

pub(crate) struct EpollIoBackend;

impl IoBackend for EpollIoBackend {
    fn name(&self) -> &'static str {
        "epoll"
    }

    fn start_endpoint(&self, context: EndpointContext) -> Result<()> {
        if context.scene.protocol == EndpointProtocol::Kcp {
            #[cfg(feature = "kcp")]
            return super::kcp::start_kcp_endpoint(context);
            #[cfg(not(feature = "kcp"))]
            bail!("KCP endpoint requires a binary built with --features kcp");
        }
        let bind_addr = format!("{}:{}", context.scene.bind_ip(), context.scene.port);
        let listener = std::net::TcpListener::bind(&bind_addr)
            .with_context(|| format!("scene {} failed to bind {bind_addr}", context.scene.name))?;
        listener.set_nonblocking(true)?;
        let listener = TcpListener::from_std(listener)?;
        tracing::info!(target: "tiangz::transport",
            "scene {} ({}) listening on {} protocol={:?} audience={:?} io_backend={}",
            context.scene.name,
            context.scene.scene_type,
            bind_addr,
            context.scene.protocol,
            context.scene.audience,
            self.name()
        );
        tokio::spawn(async move {
            if let Err(error) = run_scene_listener(listener, context).await {
                tracing::error!(target: "tiangz::transport", error = ?error, "scene listener stopped");
            }
        });
        Ok(())
    }
}

async fn run_scene_listener(listener: TcpListener, context: EndpointContext) -> Result<()> {
    loop {
        let (stream, peer) = listener.accept().await?;
        let connection_id = context.next_connection_id.fetch_add(1, Ordering::Relaxed);
        tracing::debug!(target: "tiangz::transport",
            "{} accepted {} as conn {} backend=epoll",
            context.scene.name, peer, connection_id
        );

        let event_tx = context.event_tx.clone();
        let writers = Arc::clone(&context.writers);
        let stats = Arc::clone(&context.stats);
        let protocol = context.scene.protocol;
        let scene_index = context.scene_index;
        tokio::spawn(async move {
            if let Err(error) = handle_connection(
                scene_index,
                connection_id,
                protocol,
                stream,
                event_tx,
                writers,
                stats,
            )
            .await
            {
                tracing::warn!(target: "tiangz::transport", connection_id, error = ?error, "connection closed with error");
            }
        });
    }
}

async fn handle_connection(
    scene_index: u32,
    connection_id: u64,
    protocol: EndpointProtocol,
    stream: TcpStream,
    event_tx: crate::process::ProcessEventSender,
    writers: super::ConnectionWriters,
    stats: Arc<crate::process::ProcessQueueStats>,
) -> Result<()> {
    stream
        .set_nodelay(true)
        .context("failed to enable TCP_NODELAY")?;
    let is_websocket = match protocol {
        EndpointProtocol::Tcp => false,
        EndpointProtocol::WebSocket => true,
        EndpointProtocol::Auto => {
            let mut probe = [0_u8; 3];
            stream.peek(&mut probe).await? >= 3 && probe == *b"GET"
        }
        EndpointProtocol::Kcp => bail!("KCP requires a UDP listener and is not implemented yet"),
    };
    if is_websocket {
        handle_websocket_connection(scene_index, connection_id, stream, event_tx, writers, stats)
            .await
    } else {
        handle_raw_tcp_connection(scene_index, connection_id, stream, event_tx, writers, stats)
            .await
    }
}

async fn handle_raw_tcp_connection(
    scene_index: u32,
    connection_id: u64,
    stream: TcpStream,
    event_tx: crate::process::ProcessEventSender,
    writers: super::ConnectionWriters,
    stats: Arc<crate::process::ProcessQueueStats>,
) -> Result<()> {
    let (mut reader, mut writer) = stream.into_split();
    let Some((connection_kind, mut first_frame_len)) = read_raw_preamble(&mut reader).await? else {
        return Ok(());
    };
    let (write_tx, mut write_rx) = mpsc::channel::<Bytes>(CONNECTION_OUTBOUND_FRAME_CAPACITY);
    let queued_bytes = Arc::new(AtomicUsize::new(0));
    let writer_queued_bytes = Arc::clone(&queued_bytes);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    writers
        .lock()
        .expect("connection writer map poisoned")
        .insert(
            connection_id,
            ConnectionWriter {
                sender: write_tx,
                queued_bytes,
                shutdown_tx: shutdown_tx.clone(),
            },
        );

    let mut writer_shutdown = shutdown_rx.clone();
    let writer_shutdown_tx = shutdown_tx.clone();
    let writer_stats = Arc::clone(&stats);
    let writer_task = tokio::spawn(async move {
        let mut frames = Vec::<Bytes>::with_capacity(WRITE_BATCH_FRAME_CAPACITY);
        loop {
            let frame = tokio::select! {
                changed = writer_shutdown.changed() => {
                    if changed.is_err() || *writer_shutdown.borrow() { break; }
                    continue;
                }
                frame = write_rx.recv() => {
                    let Some(frame) = frame else { break; };
                    frame
                }
            };
            frames.clear();
            let mut queued_frame_bytes = frame.len();
            let mut packet_bytes = 4 + frame.len();
            frames.push(frame);
            while frames.len() < WRITE_BATCH_FRAME_CAPACITY
                && packet_bytes < WRITE_BATCH_BYTE_CAPACITY
            {
                let Ok(frame) = write_rx.try_recv() else {
                    break;
                };
                queued_frame_bytes += frame.len();
                packet_bytes += 4 + frame.len();
                frames.push(frame);
            }
            let result = tokio::select! {
                changed = writer_shutdown.changed() => {
                    if changed.is_err() || *writer_shutdown.borrow() { break; }
                    continue;
                }
                result = write_raw_frames_vectored(&mut writer, &frames) => result,
            };
            writer_queued_bytes.fetch_sub(queued_frame_bytes, Ordering::Relaxed);
            if let Err(error) = result {
                let _ = writer_shutdown_tx.send(true);
                return Err(error);
            }
            writer_stats.transport_write_completed(frames.len(), packet_bytes);
        }
        Result::<()>::Ok(())
    });

    let mut reader_shutdown = shutdown_rx;
    loop {
        let frame = tokio::select! {
            changed = reader_shutdown.changed() => {
                if changed.is_err() || *reader_shutdown.borrow() { break; }
                continue;
            }
            frame = read_raw_frame(&mut reader, &mut first_frame_len) => frame?,
        };
        let Some(frame) = frame else {
            break;
        };
        validate_frame_access(connection_kind, &frame)?;
        stats.transport_read_completed(1, frame.len() + 4);
        event_tx
            .send(
                ProcessEvent::Frame {
                    scene_index,
                    connection_id,
                    frame: frame.into(),
                },
                None,
            )
            .await
            .map_err(anyhow::Error::msg)?;
    }

    finish_connection(
        scene_index,
        connection_id,
        &event_tx,
        &writers,
        &shutdown_tx,
    )
    .await?;
    writer_task.await??;
    Ok(())
}

async fn handle_websocket_connection(
    scene_index: u32,
    connection_id: u64,
    stream: TcpStream,
    event_tx: crate::process::ProcessEventSender,
    writers: super::ConnectionWriters,
    stats: Arc<crate::process::ProcessQueueStats>,
) -> Result<()> {
    let websocket = accept_async(stream).await?;
    let (mut writer, mut reader) = websocket.split();
    let (write_tx, mut write_rx) = mpsc::channel::<Bytes>(CONNECTION_OUTBOUND_FRAME_CAPACITY);
    let queued_bytes = Arc::new(AtomicUsize::new(0));
    let writer_queued_bytes = Arc::clone(&queued_bytes);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    writers
        .lock()
        .expect("connection writer map poisoned")
        .insert(
            connection_id,
            ConnectionWriter {
                sender: write_tx,
                queued_bytes,
                shutdown_tx: shutdown_tx.clone(),
            },
        );

    let mut writer_shutdown = shutdown_rx.clone();
    let writer_shutdown_tx = shutdown_tx.clone();
    let writer_stats = Arc::clone(&stats);
    let writer_task = tokio::spawn(async move {
        let mut frames = Vec::<Bytes>::with_capacity(WRITE_BATCH_FRAME_CAPACITY);
        loop {
            let frame = tokio::select! {
                changed = writer_shutdown.changed() => {
                    if changed.is_err() || *writer_shutdown.borrow() { break; }
                    continue;
                }
                frame = write_rx.recv() => {
                    let Some(frame) = frame else { break; };
                    frame
                }
            };
            frames.clear();
            let mut frame_bytes = frame.len();
            frames.push(frame);
            while frames.len() < WRITE_BATCH_FRAME_CAPACITY
                && frame_bytes < WRITE_BATCH_BYTE_CAPACITY
            {
                let Ok(frame) = write_rx.try_recv() else {
                    break;
                };
                frame_bytes += frame.len();
                frames.push(frame);
            }
            let result = tokio::select! {
                changed = writer_shutdown.changed() => {
                    if changed.is_err() || *writer_shutdown.borrow() { break; }
                    continue;
                }
                result = async {
                    for frame in &frames {
                        writer.feed(Message::Binary(frame.clone())).await?;
                    }
                    writer.flush().await
                } => result,
            };
            writer_queued_bytes.fetch_sub(frame_bytes, Ordering::Relaxed);
            if let Err(error) = result {
                let _ = writer_shutdown_tx.send(true);
                return Err(error.into());
            }
            writer_stats.transport_write_completed(frames.len(), frame_bytes);
        }
        Result::<()>::Ok(())
    });

    let mut reader_shutdown = shutdown_rx;
    loop {
        let message = tokio::select! {
            changed = reader_shutdown.changed() => {
                if changed.is_err() || *reader_shutdown.borrow() { break; }
                continue;
            }
            message = reader.next() => message,
        };
        let Some(message) = message else {
            break;
        };
        match message? {
            Message::Binary(frame) => {
                if !(2..=MAX_FRAME_LEN).contains(&frame.len()) {
                    bail!("invalid websocket frame length: {}", frame.len());
                }
                validate_frame_access(ConnectionKind::External, &frame)?;
                stats.transport_read_completed(1, frame.len());
                event_tx
                    .send(
                        ProcessEvent::Frame {
                            scene_index,
                            connection_id,
                            frame,
                        },
                        None,
                    )
                    .await
                    .map_err(anyhow::Error::msg)?;
            }
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) => {}
            Message::Text(_) => bail!("websocket text frames are not supported"),
            Message::Frame(_) => {}
        }
    }

    finish_connection(
        scene_index,
        connection_id,
        &event_tx,
        &writers,
        &shutdown_tx,
    )
    .await?;
    writer_task.await??;
    Ok(())
}

async fn finish_connection(
    scene_index: u32,
    connection_id: u64,
    event_tx: &crate::process::ProcessEventSender,
    writers: &super::ConnectionWriters,
    shutdown_tx: &watch::Sender<bool>,
) -> Result<()> {
    let _ = shutdown_tx.send(true);
    writers
        .lock()
        .expect("connection writer map poisoned")
        .remove(&connection_id);
    event_tx
        .send(
            ProcessEvent::Disconnect {
                scene_index,
                connection_id,
            },
            None,
        )
        .await
        .map_err(anyhow::Error::msg)
}

async fn write_raw_frames_vectored(
    writer: &mut tokio::net::tcp::OwnedWriteHalf,
    frames: &[Bytes],
) -> Result<()> {
    let prefixes: Vec<[u8; 4]> = frames
        .iter()
        .map(|frame| (frame.len() as u32).to_be_bytes())
        .collect();
    let mut slices = Vec::with_capacity(frames.len() * 2);
    for (prefix, frame) in prefixes.iter().zip(frames) {
        slices.push(IoSlice::new(prefix));
        slices.push(IoSlice::new(frame));
    }
    let mut remaining = slices.as_mut_slice();
    while !remaining.is_empty() {
        let written = writer.write_vectored(remaining).await?;
        if written == 0 {
            bail!("client socket closed during vectored write");
        }
        IoSlice::advance_slices(&mut remaining, written);
    }
    Ok(())
}

async fn read_raw_frame(
    reader: &mut tokio::net::tcp::OwnedReadHalf,
    first_frame_len: &mut Option<usize>,
) -> Result<Option<Vec<u8>>> {
    let len = match first_frame_len.take() {
        Some(len) => len,
        None => match reader.read_u32().await {
            Ok(len) => len as usize,
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(error) => return Err(error.into()),
        },
    };
    if !(2..=MAX_FRAME_LEN).contains(&len) {
        bail!("invalid frame length: {len}");
    }
    let mut frame = vec![0_u8; len];
    reader.read_exact(&mut frame).await?;
    Ok(Some(frame))
}

async fn read_raw_preamble(
    reader: &mut tokio::net::tcp::OwnedReadHalf,
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
