//! 在与 epoll 相同的端点契约下实现 Linux io_uring TCP 后端。 / Implements the Linux io_uring TCP backend behind the same endpoint contract as epoll.

use std::io;
use std::net::Shutdown;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;

use super::admission::{ConnectionPermit, allocate_connection_id};
use super::lifecycle::{
    ConnectionRegistration, OwnedTask, drain_writer, next_write_batch, stopped,
};
use anyhow::{Context, Result, bail};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinSet;
use tokio_uring::buf::{BoundedBuf, Slice};
use tokio_uring::net::{TcpListener, TcpStream};

use super::{
    CONNECTION_OUTBOUND_FRAME_CAPACITY, ConnectionKind, ConnectionWriteBatch, ConnectionWriter,
    EndpointContext, EndpointTask, IoBackend, MAX_INNER_TOKEN_LEN, RawFrameDecoder,
    WRITE_BATCH_BYTE_CAPACITY, try_queue_connection_frame, validate_connection_audience,
    validate_frame_access,
};
use crate::process::{ProcessEvent, ProcessIngressTrySendError};
use crate::transport::{
    INNER_HANDSHAKE_MAGIC, build_target_ingress_overload, inner_frame_rpc_id, inner_token,
};

pub(crate) struct UringIoBackend {
    entries: u32,
    read_buffer_bytes: usize,
}

struct SocketShutdown(Rc<TcpStream>);

impl Drop for SocketShutdown {
    /// 结束握手或 writer 的所有路径都唤醒遗留内核 I/O，不能只丢弃 Future。 / Wakes retained kernel I/O on every handshake or writer exit, not merely by dropping its Future.
    fn drop(&mut self) {
        let _ = self.0.shutdown(Shutdown::Both);
    }
}

struct ListenerShutdown(socket2::Socket);

impl Drop for ListenerShutdown {
    /// 关闭监听的所有路径都唤醒未完成 accept，原 Future 仍需消费实际结果。 / Wakes a pending accept on every listener exit; its original Future still consumes the actual result.
    fn drop(&mut self) {
        let _ = self.0.shutdown(Shutdown::Both);
    }
}

impl UringIoBackend {
    pub(crate) fn new(entries: u32, read_buffer_bytes: usize) -> Self {
        Self {
            entries,
            read_buffer_bytes,
        }
    }
}

impl IoBackend for UringIoBackend {
    fn name(&self) -> &'static str {
        "io-uring"
    }

    /// 把独立 io_uring 线程的停止与 join 所有权交给 Process。 / Gives the process stop/join ownership of the dedicated io_uring thread.
    fn start_endpoint(&self, context: EndpointContext) -> Result<EndpointTask> {
        let bind_addr = format!("{}:{}", context.scene.bind_ip(), context.scene.port);
        let listener = std::net::TcpListener::bind(&bind_addr)
            .with_context(|| format!("scene {} failed to bind {bind_addr}", context.scene.name))?;
        let listener_shutdown = ListenerShutdown(
            listener
                .try_clone()
                .context("failed to clone io-uring listener control")?
                .into(),
        );
        let entries = self.entries;
        let read_buffer_bytes = self.read_buffer_bytes;
        let scene_name = context.scene.name.clone();
        let endpoint_name = scene_name.clone();
        let scene_type = context.scene.scene_type.clone();
        let thread_name = format!("uring-{scene_name}");
        let (shutdown, shutdown_rx) = watch::channel(false);
        let thread = std::thread::Builder::new()
            .name(thread_name)
            .spawn(move || {
                let mut builder = tokio_uring::builder();
                builder.entries(entries);
                builder.start(async move {
                    tracing::info!(target: "tiangz::transport",
                        "scene {scene_name} ({scene_type}) listening on {bind_addr} protocol=Tcp audience={:?} io_backend=io-uring entries={entries} read_buffer_bytes={read_buffer_bytes}",
                        context.scene.audience
                    );
                    run_scene_listener(
                        TcpListener::from_std(listener),
                        listener_shutdown,
                        context,
                        read_buffer_bytes,
                        shutdown_rx,
                    )
                    .await
                })
            })?;
        // join 在阻塞池中持有实际线程；线程自身的排空期限不依赖外层任务仍被 poll。
        // Join owns the actual thread in the blocking pool; its drain deadline is enforced inside the thread.
        let task = tokio::task::spawn_blocking(move || {
            thread
                .join()
                .map_err(|_| anyhow::anyhow!("io-uring endpoint thread panicked"))?
        });
        Ok(EndpointTask::new(endpoint_name, shutdown, task))
    }
}

/// LocalSet 上持有所有连接，停止后有界等待并取消剩余连接。 / Owns local connections and bounds their drain before cancelling remaining work.
async fn run_scene_listener(
    listener: TcpListener,
    listener_shutdown: ListenerShutdown,
    context: EndpointContext,
    read_buffer_bytes: usize,
    mut shutdown: watch::Receiver<bool>,
) -> Result<()> {
    let context = Arc::new(context);
    let mut connections = JoinSet::new();
    // 收割连接不能丢弃仍在内核等待的 accept，否则下一连接会落入无人消费的结果。
    // Reaping a connection must retain the pending accept and consume its eventual socket.
    let mut accepting = Box::pin(listener.accept());
    loop {
        let (stream, peer) = tokio::select! {
            biased;
            _ = stopped(&mut shutdown) => break,
            completed = connections.join_next(), if !connections.is_empty() => {
                if let Some(Err(error)) = completed {
                    tracing::warn!(target: "tiangz::transport", error = ?error, "io-uring connection task failed");
                }
                continue;
            }
            accepted = accepting.as_mut() => accepted?,
        };
        accepting.set(listener.accept());
        let Some(permit) = context.stats.admission.accept_stream() else {
            continue;
        };
        let connection_id = allocate_connection_id(&context.next_connection_id)?;
        tracing::debug!(target: "tiangz::transport",
            "{} accepted {} as conn {} backend=io-uring",
            context.scene.name, peer, connection_id
        );
        let connection_context = context.clone();
        let connection_shutdown = shutdown.clone();
        connections.spawn_local(async move {
            if let Err(error) = handle_raw_connection(
                connection_context,
                connection_id,
                stream,
                connection_shutdown,
                read_buffer_bytes,
                permit,
            )
            .await
            {
                tracing::warn!(target: "tiangz::transport", connection_id, error = ?error, "io-uring connection closed with error");
            }
        });
    }
    let _ = listener_shutdown.0.shutdown(Shutdown::Both);
    tokio::time::timeout(context.shutdown_timeout, async {
        // shutdown 唤醒 accept；若同时已接入，消费并关闭该连接，不遗弃成功的 FD。
        // Shutdown wakes accept; consume and close any connection that won the race.
        let _ = accepting.await;
        while connections.join_next().await.is_some() {}
    })
    .await
    .context("io-uring accept/connections exceeded process stop budget")?;
    drop(listener);
    Ok(())
}

/// 连接持有登记与 writer，握手和读循环可被端点停止取消。 / Owns registration/writer and allows endpoint stop to cancel handshake and reads.
async fn handle_raw_connection(
    context: Arc<EndpointContext>,
    connection_id: u64,
    stream: TcpStream,
    mut shutdown: watch::Receiver<bool>,
    read_buffer_bytes: usize,
    mut permit: ConnectionPermit,
) -> Result<()> {
    let scene_index = context.scene_index;
    let event_tx = &context.event_tx;
    let writers = &context.writers;
    stream
        .set_nodelay(true)
        .context("failed to enable TCP_NODELAY")?;
    let stream = Rc::new(stream);
    let socket_shutdown = SocketShutdown(Rc::clone(&stream));
    let preamble = tokio::select! {
        biased;
        _ = stopped(&mut shutdown) => return Ok(()),
        preamble = tokio::time::timeout(super::handshake::HANDSHAKE_TIMEOUT, read_raw_preamble(&stream)) => {
            preamble.context("io-uring handshake timed out")??
        },
    };
    let Some((connection_kind, first_frame_len)) = preamble else {
        return Ok(());
    };
    validate_connection_audience(context.scene.audience, connection_kind)?;
    permit.complete_handshake();

    let (write_tx, write_rx) =
        mpsc::channel::<ConnectionWriteBatch>(CONNECTION_OUTBOUND_FRAME_CAPACITY);
    let queued_bytes = Arc::new(AtomicUsize::new(0));
    let queued_frames = Arc::new(AtomicUsize::new(0));
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let connection_writer = ConnectionWriter {
        process_buffer_budget: context.stats.outbound_buffers.clone(),
        sender: write_tx,
        queued_bytes: Arc::clone(&queued_bytes),
        queued_frames: Arc::clone(&queued_frames),
        shutdown_tx: shutdown_tx.clone(),
    };
    let _registration =
        ConnectionRegistration::new(writers.clone(), connection_id, connection_writer.clone());

    let writer_context = context.clone();
    let mut reader_shutdown = shutdown_rx.clone();
    let writer_task = OwnedTask::new(tokio_uring::spawn(drain_writer(
        run_writer(socket_shutdown, write_rx, shutdown_rx, writer_context),
        shutdown_tx.clone(),
        context.shutdown_timeout,
    )));

    let read_result = tokio::select! {
        biased;
        _ = stopped(&mut shutdown) => Ok(()),
        _ = stopped(&mut reader_shutdown) => Ok(()),
        result = run_reader(
        &context,
        connection_id,
        connection_kind,
        first_frame_len,
        Rc::clone(&stream),
        connection_writer,
        read_buffer_bytes,
        ) => result,
    };

    // 先释放连接持有的读引用，断线通知堵塞不能阻止超时 writer 关闭 Socket。
    // Release the read reference so a blocked disconnect notification cannot retain a timed-out socket.
    drop(stream);
    if read_result.is_err() {
        writer_task.abort();
    }
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
        .map_err(anyhow::Error::msg)?;

    let writer_result = writer_task.await;
    read_result?;
    writer_result??;
    Ok(())
}

async fn run_reader(
    context: &EndpointContext,
    connection_id: u64,
    connection_kind: ConnectionKind,
    first_frame_len: Option<usize>,
    stream: Rc<TcpStream>,
    connection_writer: ConnectionWriter,
    read_buffer_bytes: usize,
) -> Result<()> {
    let scene_index = context.scene_index;
    let event_tx = &context.event_tx;
    let mut read_buffer = vec![0_u8; read_buffer_bytes];
    let mut decoder = RawFrameDecoder::new(read_buffer_bytes * 2, first_frame_len)?;
    loop {
        let (result, returned_buffer) = stream.read(read_buffer).await;
        read_buffer = returned_buffer;
        let read = result?;
        if read == 0 {
            return Ok(());
        }
        decoder.push(&read_buffer[..read]);
        let mut frame_count = 0;
        while let Some(frame) = decoder.next_frame()? {
            validate_frame_access(connection_kind, &frame)?;
            frame_count += 1;
            let rpc_id = (connection_kind == ConnectionKind::Internal)
                .then(|| inner_frame_rpc_id(&frame))
                .flatten();
            let event = ProcessEvent::Frame {
                internal: connection_kind == ConnectionKind::Internal,
                scene_index,
                connection_id,
                frame,
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
        context.stats.transport_read_completed(frame_count, read);
    }
}

async fn run_writer(
    socket_shutdown: SocketShutdown,
    mut write_rx: mpsc::Receiver<ConnectionWriteBatch>,
    mut shutdown_rx: watch::Receiver<bool>,
    context: Arc<EndpointContext>,
) -> Result<()> {
    let stream = &socket_shutdown.0;
    let mut packet = Vec::<u8>::with_capacity(WRITE_BATCH_BYTE_CAPACITY);
    while let Some(batch) = next_write_batch(&mut write_rx, &mut shutdown_rx).await {
        let frame_count = batch.frames.len();
        let packet_bytes = batch.frame_bytes + frame_count * 4;

        packet.clear();
        packet.reserve(packet_bytes);
        for frame in &batch.frames {
            packet.extend_from_slice(&(frame.len() as u32).to_be_bytes());
            packet.extend_from_slice(frame);
        }
        packet = batch
            .write_within(context.write_timeout, async {
                let (result, returned_packet) = stream.write_all(packet).await;
                result?;
                Ok(returned_packet)
            })
            .await?;
        context
            .stats
            .transport_write_completed(frame_count, packet_bytes);
    }
    // 正常路径排空后才归还关闭守卫；错误/取消也由同一所有者关闭 Socket。
    // Normal exit drains first; the same owner also closes the socket on errors/cancellation.
    Ok(())
}

async fn read_raw_preamble(stream: &TcpStream) -> Result<Option<(ConnectionKind, Option<usize>)>> {
    let prefix = match uring_read_exact(stream, vec![0_u8; 4]).await {
        Ok(prefix) => prefix,
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let prefix = u32::from_be_bytes(prefix.as_slice().try_into().unwrap());
    if prefix != INNER_HANDSHAKE_MAGIC {
        return Ok(Some((ConnectionKind::External, Some(prefix as usize))));
    }

    let token_len = uring_read_exact(stream, vec![0_u8; 2]).await?;
    let token_len = u16::from_be_bytes(token_len.as_slice().try_into().unwrap()) as usize;
    if token_len == 0 || token_len > MAX_INNER_TOKEN_LEN {
        bail!("invalid inner handshake token length: {token_len}");
    }
    let token = uring_read_exact(stream, vec![0_u8; token_len]).await?;
    if token != inner_token().as_bytes() {
        bail!("invalid inner handshake token");
    }
    Ok(Some((ConnectionKind::Internal, None)))
}

async fn uring_read_exact(stream: &TcpStream, buffer: Vec<u8>) -> io::Result<Vec<u8>> {
    let mut slice: Slice<Vec<u8>> = buffer.slice(..);
    while slice.bytes_total() != 0 {
        let (result, returned) = stream.read(slice).await;
        match result {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "connection closed while reading frame",
                ));
            }
            Ok(read) => slice = returned.slice(read..),
            Err(error) => return Err(error),
        }
    }
    Ok(slice.into_inner())
}
