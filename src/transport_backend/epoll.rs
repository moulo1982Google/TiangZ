//! 实现可移植的 Tokio/epoll 或 IOCP 流后端，并支持批量写入。 / Implements the portable Tokio/epoll-or-IOCP stream backend with batched writes.

use std::io::IoSlice;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;

use anyhow::{Context, Result, bail};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinSet;
use tokio_tungstenite::tungstenite::Message;

use super::admission::{ConnectionPermit, allocate_connection_id};
use super::handshake::{AcceptedConnection, AcceptedTcp, AcceptedWebSocket, accept_connection};
use super::lifecycle::{
    ConnectionRegistration, OwnedTask, drain_writer, next_write_batch, stopped,
};

use super::{
    CONNECTION_OUTBOUND_FRAME_CAPACITY, ConnectionKind, ConnectionWriteBatch, ConnectionWriter,
    EndpointContext, EndpointTask, IoBackend, MAX_FRAME_LEN, try_queue_connection_frame,
    validate_frame_access,
};
use crate::config::EndpointProtocol;
use crate::process::{ProcessEvent, ProcessIngressTrySendError};
use crate::transport::{build_target_ingress_overload, inner_frame_rpc_id};

pub(crate) struct EpollIoBackend;

impl IoBackend for EpollIoBackend {
    fn name(&self) -> &'static str {
        "epoll"
    }

    /// 绑定端点后返回其所有权，启动失败由 Process 回滚。 / Returns endpoint ownership after binding so the process can roll back startup.
    fn start_endpoint(&self, context: EndpointContext) -> Result<EndpointTask> {
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
        let (shutdown, shutdown_rx) = watch::channel(false);
        let scene_name = context.scene.name.clone();
        let task = tokio::spawn(run_scene_listener(listener, context, shutdown_rx));
        Ok(EndpointTask::new(scene_name, shutdown, task))
    }
}

/// 端点持有所有连接任务；停止准入后等待连接排空，异常退出则取消子任务。 / Owns all connections, drains after stopping admission and cancels children on failure.
async fn run_scene_listener(
    listener: TcpListener,
    context: EndpointContext,
    mut shutdown: watch::Receiver<bool>,
) -> Result<()> {
    let context = Arc::new(context);
    let mut connections = JoinSet::new();
    loop {
        let (stream, peer) = tokio::select! {
            biased;
            _ = stopped(&mut shutdown) => break,
            completed = connections.join_next(), if !connections.is_empty() => {
                if let Some(Err(error)) = completed {
                    tracing::warn!(target: "tiangz::transport", error = ?error, "connection task failed");
                }
                continue;
            }
            accepted = listener.accept() => accepted?,
        };
        let Some(permit) = context.stats.admission.accept_stream() else {
            continue;
        };
        let connection_id = allocate_connection_id(&context.next_connection_id)?;
        tracing::debug!(target: "tiangz::transport",
            "{} accepted {} as conn {} backend=epoll",
            context.scene.name, peer, connection_id
        );

        let connection_context = context.clone();
        let connection_shutdown = shutdown.clone();
        connections.spawn(async move {
            if let Err(error) = handle_connection(
                connection_context,
                connection_id,
                stream,
                connection_shutdown,
                permit,
            )
            .await
            {
                tracing::warn!(target: "tiangz::transport", connection_id, error = ?error, "connection closed with error");
            }
        });
    }
    drop(listener);
    tokio::time::timeout(context.shutdown_timeout, async {
        while connections.join_next().await.is_some() {}
    })
    .await
    .context("endpoint connections exceeded process stop budget")?;
    Ok(())
}

/// 握手属于端点生命周期，未完成握手不得阻止停机。 / Keeps handshakes within endpoint lifetime so incomplete peers cannot prevent shutdown.
async fn handle_connection(
    context: Arc<EndpointContext>,
    connection_id: u64,
    stream: TcpStream,
    mut shutdown: watch::Receiver<bool>,
    mut permit: ConnectionPermit,
) -> Result<()> {
    stream
        .set_nodelay(true)
        .context("failed to enable TCP_NODELAY")?;
    let accepted = tokio::select! {
        biased;
        _ = stopped(&mut shutdown) => return Ok(()),
        accepted = accept_connection(stream, context.scene.protocol, context.scene.audience) => accepted?,
    };
    permit.complete_handshake();
    match accepted {
        Some(AcceptedConnection::WebSocket(websocket)) => {
            handle_websocket_connection(context, connection_id, *websocket, shutdown).await
        }
        Some(AcceptedConnection::Tcp(connection)) => {
            handle_raw_tcp_connection(context, connection_id, connection, shutdown).await
        }
        None => Ok(()),
    }
}

/// 原生连接持有 writer 与登记，端点停止走正常排空，任务取消走 RAII。 / Owns the native writer/registration, drains on endpoint stop and uses RAII on cancellation.
async fn handle_raw_tcp_connection(
    context: Arc<EndpointContext>,
    connection_id: u64,
    connection: AcceptedTcp,
    mut endpoint_shutdown: watch::Receiver<bool>,
) -> Result<()> {
    let scene_index = context.scene_index;
    let event_tx = &context.event_tx;
    let writers = &context.writers;
    let stats = &context.stats;
    let AcceptedTcp {
        mut reader,
        mut writer,
        kind: connection_kind,
        mut first_frame_len,
    } = connection;
    let (write_tx, mut write_rx) =
        mpsc::channel::<ConnectionWriteBatch>(CONNECTION_OUTBOUND_FRAME_CAPACITY);
    let queued_bytes = Arc::new(AtomicUsize::new(0));
    let queued_frames = Arc::new(AtomicUsize::new(0));
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let connection_writer = ConnectionWriter {
        process_buffer_budget: stats.outbound_buffers.clone(),
        sender: write_tx,
        queued_bytes,
        queued_frames,
        shutdown_tx: shutdown_tx.clone(),
    };
    let _registration =
        ConnectionRegistration::new(writers.clone(), connection_id, connection_writer.clone());

    let mut writer_shutdown = shutdown_rx.clone();
    let writer_shutdown_tx = shutdown_tx.clone();
    let writer_stats = Arc::clone(stats);
    let write_timeout = context.write_timeout;
    let writer_task = OwnedTask::new(tokio::spawn(drain_writer(
        async move {
            while let Some(batch) = next_write_batch(&mut write_rx, &mut writer_shutdown).await {
                let frame_count = batch.frames.len();
                let packet_bytes = batch.frame_bytes + frame_count * 4;
                batch
                    .write_within(
                        write_timeout,
                        write_raw_frames_vectored(&mut writer, &batch.frames),
                    )
                    .await?;
                writer_stats.transport_write_completed(frame_count, packet_bytes);
            }
            Result::<()>::Ok(())
        },
        writer_shutdown_tx,
        context.shutdown_timeout,
    )));

    let mut reader_shutdown = shutdown_rx;
    let read_result: Result<()> = tokio::select! {
        biased;
        _ = stopped(&mut endpoint_shutdown) => Ok(()),
        _ = stopped(&mut reader_shutdown) => Ok(()),
        result = async {
        loop {
            let frame = read_raw_frame(&mut reader, &mut first_frame_len).await?;
            let Some(frame) = frame else {
                break;
            };
            validate_frame_access(connection_kind, &frame)?;
            stats.transport_read_completed(1, frame.len() + 4);
            let rpc_id = (connection_kind == ConnectionKind::Internal)
                .then(|| inner_frame_rpc_id(&frame))
                .flatten();
            let event = ProcessEvent::Frame {
                backing_reservation: None,
                control_reservation: None,
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
                            "rejected inner RPC because target ingress capacity is exhausted"
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
        } => result,
    };

    // 断线通知等待业务准入时不继续占有读半边 Socket。 / Releases the read half before disconnect notification waits for ingress.
    drop(reader);
    // 错误也必须移除writer并通知断线；恶意/损坏连接不再等待发送排空。
    // Errors must remove the writer and notify disconnect; corrupt peers skip outbound draining.
    if read_result.is_err() {
        writer_task.abort();
    }
    let finish_result =
        finish_connection(scene_index, connection_id, event_tx, writers, &shutdown_tx).await;
    if finish_result.is_err() {
        writer_task.abort();
    }
    let writer_result = writer_task.await;
    read_result?;
    finish_result?;
    writer_result??;
    Ok(())
}

/// WebSocket 连接与 writer 共享端点的停止与取消所有权。 / Shares endpoint stop/cancellation ownership with the WebSocket writer.
async fn handle_websocket_connection(
    context: Arc<EndpointContext>,
    connection_id: u64,
    websocket: AcceptedWebSocket,
    mut endpoint_shutdown: watch::Receiver<bool>,
) -> Result<()> {
    let scene_index = context.scene_index;
    let event_tx = &context.event_tx;
    let writers = &context.writers;
    let stats = &context.stats;
    let (mut writer, mut reader) = websocket.split();
    let (write_tx, mut write_rx) =
        mpsc::channel::<ConnectionWriteBatch>(CONNECTION_OUTBOUND_FRAME_CAPACITY);
    let queued_bytes = Arc::new(AtomicUsize::new(0));
    let queued_frames = Arc::new(AtomicUsize::new(0));
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let _registration = ConnectionRegistration::new(
        writers.clone(),
        connection_id,
        ConnectionWriter {
            process_buffer_budget: stats.outbound_buffers.clone(),
            sender: write_tx,
            queued_bytes,
            queued_frames,
            shutdown_tx: shutdown_tx.clone(),
        },
    );

    let mut writer_shutdown = shutdown_rx.clone();
    let writer_shutdown_tx = shutdown_tx.clone();
    let writer_stats = Arc::clone(stats);
    let write_timeout = context.write_timeout;
    let writer_task = OwnedTask::new(tokio::spawn(drain_writer(
        async move {
            while let Some(batch) = next_write_batch(&mut write_rx, &mut writer_shutdown).await {
                let frame_count = batch.frames.len();
                batch
                    .write_within(write_timeout, async {
                        for frame in &batch.frames {
                            writer.feed(Message::Binary(frame.clone())).await?;
                        }
                        writer.flush().await?;
                        Ok(())
                    })
                    .await?;
                writer_stats.transport_write_completed(frame_count, batch.frame_bytes);
            }
            Result::<()>::Ok(())
        },
        writer_shutdown_tx,
        context.shutdown_timeout,
    )));

    let mut reader_shutdown = shutdown_rx;
    let read_result: Result<()> = tokio::select! {
        biased;
        _ = stopped(&mut endpoint_shutdown) => Ok(()),
        _ = stopped(&mut reader_shutdown) => Ok(()),
        result = async {
        loop {
            let message = reader.next().await;
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
                                backing_reservation: None,
                                control_reservation: None,
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
        } => result,
    };

    // writer 已由预算约束，读半边无需在断线通知排队时继续持有。 / The writer has its own budget; disconnect queue wait need not retain the read half.
    drop(reader);
    // 协议校验和读取失败同样走统一清理，防止孤儿发送任务留住Socket。
    // Protocol/read failures also run cleanup so orphaned writers cannot retain sockets.
    if read_result.is_err() {
        writer_task.abort();
    }
    let finish_result =
        finish_connection(scene_index, connection_id, event_tx, writers, &shutdown_tx).await;
    if finish_result.is_err() {
        writer_task.abort();
    }
    let writer_result = writer_task.await;
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
                backing_reservation: None,
                control_reservation: None,
                scene_index,
                connection_id,
            },
            None,
        )
        .await
        .map_err(anyhow::Error::msg)
}

pub(super) async fn write_raw_frames_vectored(
    writer: &mut (impl tokio::io::AsyncWrite + Unpin),
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
