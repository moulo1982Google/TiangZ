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
use tokio::time::{Duration, Instant, timeout_at};
use tokio_tungstenite::{accept_async, tungstenite::Message};

use super::{
    CONNECTION_OUTBOUND_FRAME_CAPACITY, ConnectionKind, ConnectionWriteBatch, ConnectionWriter,
    EndpointContext, IoBackend, MAX_FRAME_LEN, MAX_INNER_TOKEN_LEN, try_queue_connection_frame,
    validate_frame_access,
};
use crate::config::EndpointProtocol;
use crate::process::{ProcessEvent, ProcessIngressTrySendError};
use crate::transport::{
    INNER_HANDSHAKE_MAGIC, build_target_ingress_overload, inner_frame_rpc_id, inner_token,
};

pub(crate) struct EpollIoBackend;

// 关闭握手和剩余写入共用预算，不让不响应的客户端保留连接任务。 / Bound the handshake and pending writes with one shared budget.
const WEBSOCKET_CLOSE_TIMEOUT: Duration = Duration::from_secs(3);

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
    let (write_tx, mut write_rx) =
        mpsc::channel::<ConnectionWriteBatch>(CONNECTION_OUTBOUND_FRAME_CAPACITY);
    let queued_bytes = Arc::new(AtomicUsize::new(0));
    let writer_queued_bytes = Arc::clone(&queued_bytes);
    let queued_frames = Arc::new(AtomicUsize::new(0));
    let writer_queued_frames = Arc::clone(&queued_frames);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let connection_writer = ConnectionWriter {
        sender: write_tx,
        queued_bytes,
        queued_frames,
        shutdown_tx: shutdown_tx.clone(),
    };
    writers
        .lock()
        .expect("connection writer map poisoned")
        .insert(connection_id, connection_writer.clone());

    let mut writer_shutdown = shutdown_rx.clone();
    let writer_shutdown_tx = shutdown_tx.clone();
    let writer_stats = Arc::clone(&stats);
    let writer_task = tokio::spawn(async move {
        loop {
            let batch = tokio::select! {
                changed = writer_shutdown.changed() => {
                    if changed.is_err() || *writer_shutdown.borrow() {
                        // 关闭请求不能抢在已入队的通知之前；这里排空快照后再释放Socket。
                        // A close request must not overtake queued notices; drain
                        // the queue before releasing the socket.
                        while let Ok(batch) = write_rx.try_recv() {
                            let frame_count = batch.frames.len();
                            let packet_bytes = batch.frame_bytes + frame_count * 4;
                            write_raw_frames_vectored(&mut writer, &batch.frames).await?;
                            writer_queued_bytes.fetch_sub(batch.frame_bytes, Ordering::Relaxed);
                            writer_queued_frames.fetch_sub(frame_count, Ordering::Relaxed);
                            writer_stats.transport_write_completed(frame_count, packet_bytes);
                        }
                        break;
                    }
                    continue;
                }
                batch = write_rx.recv() => {
                    let Some(batch) = batch else { break; };
                    batch
                }
            };
            let frame_count = batch.frames.len();
            let packet_bytes = batch.frame_bytes + frame_count * 4;
            // 已经取出的批次必须完整写出；关闭信号只影响下一批，避免丢失最后一条业务通知。
            // Once a batch is taken, write it completely; shutdown only affects
            // the next batch so the final business notice cannot be dropped.
            let result = write_raw_frames_vectored(&mut writer, &batch.frames).await;
            writer_queued_bytes.fetch_sub(batch.frame_bytes, Ordering::Relaxed);
            writer_queued_frames.fetch_sub(frame_count, Ordering::Relaxed);
            if let Err(error) = result {
                let _ = writer_shutdown_tx.send(true);
                return Err(error);
            }
            writer_stats.transport_write_completed(frame_count, packet_bytes);
        }
        Result::<()>::Ok(())
    });

    let mut reader_shutdown = shutdown_rx;
    let read_result: Result<()> = async {
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
            let rpc_id = (connection_kind == ConnectionKind::Internal)
                .then(|| inner_frame_rpc_id(&frame))
                .flatten();
            let event = ProcessEvent::Frame {
                internal: connection_kind == ConnectionKind::Internal,
                scene_index,
                connection_id,
                frame: frame.into(),
            };
            if let Some(rpc_id) = rpc_id {
                match event_tx.try_send_control(event) {
                    Ok(()) => continue,
                    Err(ProcessIngressTrySendError::Overloaded) => {
                        try_queue_connection_frame(
                            &connection_writer,
                            build_target_ingress_overload(rpc_id),
                        )
                        .map_err(anyhow::Error::msg)?;
                        tracing::warn!(
                            target: "tiangz::transport",
                            connection_id,
                            rpc_id,
                            "rejected inner RPC because target control ingress queue is full"
                        );
                        continue;
                    }
                    Err(ProcessIngressTrySendError::Stopped) => {
                        return Err(anyhow::anyhow!("process event queue is stopped"));
                    }
                }
            }
            event_tx
                .send(event, None)
                .await
                .map_err(anyhow::Error::msg)?;
        }
        Ok(())
    }
    .await;

    // 错误也必须移除writer并通知断线；恶意/损坏连接不再等待发送排空。
    // Errors must remove the writer and notify disconnect; corrupt peers skip outbound draining.
    if read_result.is_err() {
        writer_task.abort();
    }
    let finish_result = finish_connection(
        scene_index,
        connection_id,
        &event_tx,
        &writers,
        &shutdown_tx,
    )
    .await;
    if finish_result.is_err() {
        writer_task.abort();
    }
    let writer_result = writer_task.await;
    read_result?;
    finish_result?;
    writer_result??;
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
    let (write_tx, mut write_rx) =
        mpsc::channel::<ConnectionWriteBatch>(CONNECTION_OUTBOUND_FRAME_CAPACITY);
    let queued_bytes = Arc::new(AtomicUsize::new(0));
    let writer_queued_bytes = Arc::clone(&queued_bytes);
    let queued_frames = Arc::new(AtomicUsize::new(0));
    let writer_queued_frames = Arc::clone(&queued_frames);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    writers
        .lock()
        .expect("connection writer map poisoned")
        .insert(
            connection_id,
            ConnectionWriter {
                sender: write_tx,
                queued_bytes,
                queued_frames,
                shutdown_tx: shutdown_tx.clone(),
            },
        );

    let mut writer_shutdown = shutdown_rx.clone();
    let writer_shutdown_tx = shutdown_tx.clone();
    let writer_stats = Arc::clone(&stats);
    let mut writer_task: tokio::task::JoinHandle<Result<()>> = tokio::spawn(async move {
        let drained: Result<()> = async {
        loop {
            let batch = tokio::select! {
                changed = writer_shutdown.changed() => {
                    if changed.is_err() || *writer_shutdown.borrow() {
                        // 先排空应用帧，再发送关闭帧；对端失联或超时仍可能丢失。
                        // Drain application frames before the close frame; peer failure or timeout can still lose data.
                        while let Ok(batch) = write_rx.try_recv() {
                            let frame_count = batch.frames.len();
                            for frame in &batch.frames {
                                writer.feed(Message::Binary(frame.clone())).await?;
                            }
                            writer.flush().await?;
                            writer_queued_bytes.fetch_sub(batch.frame_bytes, Ordering::Relaxed);
                            writer_queued_frames.fetch_sub(frame_count, Ordering::Relaxed);
                            writer_stats.transport_write_completed(frame_count, batch.frame_bytes);
                        }
                        break;
                    }
                    continue;
                }
                batch = write_rx.recv() => {
                    let Some(batch) = batch else { break; };
                    batch
                }
            };
            let frame_count = batch.frames.len();
            // 已经取出的批次必须完整写出；关闭信号只影响下一批。
            // Once taken, the batch is written completely; shutdown only
            // affects the next batch.
            let result = async {
                for frame in &batch.frames {
                    writer.feed(Message::Binary(frame.clone())).await?;
                }
                writer.flush().await
            }
            .await;
            writer_queued_bytes.fetch_sub(batch.frame_bytes, Ordering::Relaxed);
            writer_queued_frames.fetch_sub(frame_count, Ordering::Relaxed);
            if let Err(error) = result {
                let _ = writer_shutdown_tx.send(true);
                return Err(error.into());
            }
            writer_stats.transport_write_completed(frame_count, batch.frame_bytes);
        }
        Ok(())
        }.await;
        if let Err(error) = drained {
            // 对端已经 Close 时不能再写应用帧，但仍须 flush 自动排队的关闭确认。
            // A peer Close forbids application writes, but its queued acknowledgement still needs flushing.
            if !matches!(
                error.downcast_ref::<tokio_tungstenite::tungstenite::Error>(),
                Some(tokio_tungstenite::tungstenite::Error::Protocol(
                    tokio_tungstenite::tungstenite::error::ProtocolError::SendAfterClosing
                ))
            ) {
                return Err(error);
            }
        }
        // 排空之后发 WebSocket Close，而不是直接丢掉 TCP Socket。 / Send Close after draining rather than dropping TCP immediately.
        match writer.close().await {
            Ok(())
            | Err(tokio_tungstenite::tungstenite::Error::ConnectionClosed)
            | Err(tokio_tungstenite::tungstenite::Error::AlreadyClosed) => Ok(()),
            Err(error) => Err(error.into()),
        }
    });

    let mut reader_shutdown = shutdown_rx;
    let mut close_deadline = None;
    let read_result: Result<()> = async {
        loop {
            let message = tokio::select! {
                biased;
                changed = reader_shutdown.changed() => {
                    if changed.is_err() || *reader_shutdown.borrow() {
                        let deadline = Instant::now() + WEBSOCKET_CLOSE_TIMEOUT;
                        close_deadline = Some(deadline);
                        // 继续读到关闭确认，丢弃迟到输入；带未读数据直接 drop 会触发 TCP RST。
                        // Read through the close acknowledgement, discarding late input; dropping unread TCP data can reset the peer.
                        let _ = timeout_at(deadline, async {
                            while let Some(Ok(message)) = reader.next().await {
                                if matches!(message, Message::Close(_)) { break; }
                            }
                        }).await;
                        break;
                    }
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
                                internal: false,
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
        Ok(())
    }
    .await;

    // 协议校验和读取失败同样走统一清理，防止孤儿发送任务留住Socket。
    // Protocol/read failures also run cleanup so orphaned writers cannot retain sockets.
    if read_result.is_err() {
        writer_task.abort();
    }
    let finish_result = finish_connection(
        scene_index,
        connection_id,
        &event_tx,
        &writers,
        &shutdown_tx,
    )
    .await;
    if finish_result.is_err() {
        writer_task.abort();
    }
    // 读侧与写侧共享截止时间；超时必须 abort 并回收，不能留下分离任务。 / Share the close deadline and join aborted writers instead of detaching them.
    let deadline = close_deadline.unwrap_or_else(|| Instant::now() + WEBSOCKET_CLOSE_TIMEOUT);
    let writer_result = match timeout_at(deadline, &mut writer_task).await {
        Ok(result) => result,
        Err(_) => {
            writer_task.abort();
            let _ = writer_task.await;
            bail!("websocket close timed out");
        }
    };
    read_result?;
    finish_result?;
    writer_result??;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::time::timeout;

    type Client = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;
    struct Fixture {
        client: Client,
        writer: super::super::ConnectionWriter,
        writers: super::super::ConnectionWriters,
        server: tokio::task::JoinHandle<Result<()>>,
        events: std::sync::mpsc::Receiver<ProcessEvent>,
    }

    /// 随机端口的真实 WebSocket 对，不依赖游戏配置或 V8。 / A real WebSocket pair on an ephemeral port, independent of game config and V8.
    async fn fixture() -> Fixture {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (event_tx, events) = crate::process::ProcessEventSender::test_channel();
        let writers = super::super::ConnectionWriters::default();
        let server_writers = Arc::clone(&writers);
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            handle_websocket_connection(
                0,
                1,
                stream,
                event_tx,
                server_writers,
                Arc::new(crate::process::ProcessQueueStats::default()),
            )
            .await
        });
        let (client, _) = tokio_tungstenite::connect_async(format!("ws://{address}"))
            .await
            .unwrap();
        let writer = loop {
            if let Some(writer) = writers.lock().unwrap().get(&1).cloned() {
                break writer;
            }
            tokio::task::yield_now().await;
        };

        Fixture {
            client,
            writer,
            writers,
            server,
            events,
        }
    }

    /// 顶号通知后仍有旧输入时，通知及关闭帧都必须有序送达。 / Deliver the notice then the close frame even with late client input.
    #[tokio::test]
    async fn websocket_server_close_drains_then_handshakes_with_late_input() {
        timeout(Duration::from_secs(5), async {
            let Fixture {
                mut client,
                writer,
                writers,
                server,
                events,
            } = fixture().await;
            let notice = Bytes::from_static(&[0x27, 0x11, 1]);
            try_queue_connection_frame(&writer, notice.clone()).unwrap();
            writer.shutdown_tx.send(true).unwrap();
            client
                .send(Message::Binary(Bytes::from_static(&[0x27, 0x12, 2])))
                .await
                .unwrap();
            assert_eq!(
                client.next().await.unwrap().unwrap(),
                Message::Binary(notice)
            );
            assert!(matches!(
                client.next().await.unwrap().unwrap(),
                Message::Close(_)
            ));
            client.flush().await.unwrap();
            server.await.unwrap().unwrap();
            assert!(writers.lock().unwrap().is_empty());
            assert!(events.try_iter().any(|event| matches!(
                event,
                ProcessEvent::Disconnect {
                    connection_id: 1,
                    ..
                }
            )));
        })
        .await
        .expect("WebSocket close must be bounded");
    }
    /// 不回复关闭握手的客户端也必须按固定预算释放。 / Release a peer that never acknowledges Close within the fixed budget.
    #[tokio::test]
    async fn websocket_close_nonresponsive_peer_is_bounded() {
        timeout(Duration::from_secs(5), async {
            let Fixture {
                mut client,
                writer,
                writers,
                server,
                events: _events,
                ..
            } = fixture().await;
            writer.shutdown_tx.send(true).unwrap();
            assert!(matches!(
                client.next().await.unwrap().unwrap(),
                Message::Close(_)
            ));
            // 不再 poll/flush 客户端，故意不发送自动排队的关闭确认。 / Do not poll/flush the automatically queued acknowledgement.
            server.await.unwrap().unwrap();
            assert!(writers.lock().unwrap().is_empty());
            assert!(writer.sender.is_closed());
        })
        .await
        .expect("unresponsive peer must not retain transport tasks");
    }

    /// 对端主动关闭仍得到关闭确认且只产生一次断连。 / A peer-initiated close is acknowledged with one disconnect event.
    #[tokio::test]
    async fn websocket_peer_close_is_acknowledged() {
        timeout(Duration::from_secs(5), async {
            let Fixture {
                mut client,
                writers,
                server,
                events,
                ..
            } = fixture().await;
            client.close(None).await.unwrap();
            assert!(matches!(
                client.next().await.unwrap().unwrap(),
                Message::Close(_)
            ));
            server.await.unwrap().unwrap();
            assert!(writers.lock().unwrap().is_empty());
            assert_eq!(
                events
                    .try_iter()
                    .filter(|e| matches!(e, ProcessEvent::Disconnect { .. }))
                    .count(),
                1
            );
        })
        .await
        .unwrap();
    }

    /// 多批通知必须全部先于关闭帧，不能只保证最后一个批次。 / Every queued batch must precede Close, not just the final batch.
    #[tokio::test]
    async fn websocket_close_drains_multiple_batches() {
        timeout(Duration::from_secs(5), async {
            let Fixture {
                mut client,
                writer,
                server,
                events: _events,
                ..
            } = fixture().await;
            for i in 0..32 {
                try_queue_connection_frame(&writer, Bytes::from(vec![42; 1024 + i])).unwrap();
            }
            writer.shutdown_tx.send(true).unwrap();
            for i in 0..32 {
                assert_eq!(
                    client.next().await.unwrap().unwrap(),
                    Message::Binary(Bytes::from(vec![42; 1024 + i]))
                );
            }
            assert!(matches!(
                client.next().await.unwrap().unwrap(),
                Message::Close(_)
            ));
            client.flush().await.unwrap();
            server.await.unwrap().unwrap();
            assert_eq!(writer.queued_frames.load(Ordering::Relaxed), 0);
            assert_eq!(writer.queued_bytes.load(Ordering::Relaxed), 0);
        })
        .await
        .unwrap();
    }

    /// 对端先关闭时，积压应用帧不能阻止关闭确认。 / Pending application frames must not prevent acknowledgement of a peer close.
    #[tokio::test]
    async fn websocket_peer_close_with_pending_output_is_acknowledged() {
        timeout(Duration::from_secs(5), async {
            let Fixture {
                mut client,
                writer,
                server,
                events: _events,
                ..
            } = fixture().await;
            client.close(None).await.unwrap();
            for _ in 0..32 {
                try_queue_connection_frame(&writer, Bytes::from(vec![42; 32768])).unwrap();
            }
            loop {
                if matches!(client.next().await.unwrap().unwrap(), Message::Close(_)) {
                    break;
                }
            }
            server.await.unwrap().unwrap();
            assert!(writer.sender.is_closed());
        })
        .await
        .unwrap();
    }

    /// 不支持的文本帧仍按协议错误中止并回收写任务。 / Unsupported text still aborts as a protocol error and releases the writer.
    #[tokio::test]
    async fn websocket_invalid_input_cleans_up_writer() {
        timeout(Duration::from_secs(5), async {
            let Fixture {
                mut client,
                writer,
                writers,
                server,
                events: _events,
                ..
            } = fixture().await;
            client.send(Message::Text("invalid".into())).await.unwrap();
            let error = server.await.unwrap().unwrap_err();
            assert!(error.to_string().contains("text frames are not supported"));
            assert!(writers.lock().unwrap().is_empty());
            assert!(writer.sender.is_closed());
        })
        .await
        .unwrap();
    }
}
