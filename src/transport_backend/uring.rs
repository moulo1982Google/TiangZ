//! 在与 epoll 相同的端点契约下实现 Linux io_uring TCP 后端。 / Implements the Linux io_uring TCP backend behind the same endpoint contract as epoll.

use std::io;
use std::net::Shutdown;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use anyhow::{Context, Result, bail};
use bytes::Bytes;
use tokio::sync::{mpsc, watch};
use tokio_uring::buf::{BoundedBuf, Slice};
use tokio_uring::net::{TcpListener, TcpStream};

use super::{
    CONNECTION_OUTBOUND_FRAME_CAPACITY, ConnectionKind, ConnectionWriteBatch, ConnectionWriter,
    EndpointContext, IoBackend, MAX_INNER_TOKEN_LEN, RawFrameDecoder, WRITE_BATCH_BYTE_CAPACITY,
    try_queue_connection_frame, validate_frame_access,
};
use crate::process::{ProcessEvent, ProcessIngressTrySendError};
use crate::transport::{
    INNER_HANDSHAKE_MAGIC, build_target_ingress_overload, inner_frame_rpc_id, inner_token,
};

pub(crate) struct UringIoBackend {
    entries: u32,
    read_buffer_bytes: usize,
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

    fn start_endpoint(&self, context: EndpointContext) -> Result<()> {
        let bind_addr = format!("{}:{}", context.scene.bind_ip(), context.scene.port);
        let listener = std::net::TcpListener::bind(&bind_addr)
            .with_context(|| format!("scene {} failed to bind {bind_addr}", context.scene.name))?;
        let entries = self.entries;
        let read_buffer_bytes = self.read_buffer_bytes;
        let scene_name = context.scene.name.clone();
        let error_scene_name = scene_name.clone();
        let scene_type = context.scene.scene_type.clone();
        let thread_name = format!("uring-{scene_name}");
        std::thread::Builder::new()
            .name(thread_name)
            .spawn(move || {
                let mut builder = tokio_uring::builder();
                builder.entries(entries);
                let result = builder.start(async move {
                    tracing::info!(target: "tiangz::transport",
                        "scene {scene_name} ({scene_type}) listening on {bind_addr} protocol=Tcp audience={:?} io_backend=io-uring entries={entries} read_buffer_bytes={read_buffer_bytes}",
                        context.scene.audience
                    );
                    run_scene_listener(
                        TcpListener::from_std(listener),
                        context,
                        read_buffer_bytes,
                    )
                    .await
                });
                if let Err(error) = result {
                    tracing::error!(target: "tiangz::transport", scene = %error_scene_name, error = ?error, "io-uring listener stopped");
                }
            })?;
        Ok(())
    }
}

async fn run_scene_listener(
    listener: TcpListener,
    context: EndpointContext,
    read_buffer_bytes: usize,
) -> Result<()> {
    loop {
        let (stream, peer) = listener.accept().await?;
        let connection_id = context.next_connection_id.fetch_add(1, Ordering::Relaxed);
        tracing::debug!(target: "tiangz::transport",
            "{} accepted {} as conn {} backend=io-uring",
            context.scene.name, peer, connection_id
        );
        let event_tx = context.event_tx.clone();
        let writers = Arc::clone(&context.writers);
        let stats = Arc::clone(&context.stats);
        let scene_index = context.scene_index;
        tokio_uring::spawn(async move {
            if let Err(error) = handle_raw_connection(
                scene_index,
                connection_id,
                stream,
                event_tx,
                writers,
                stats,
                read_buffer_bytes,
            )
            .await
            {
                tracing::warn!(target: "tiangz::transport", connection_id, error = ?error, "io-uring connection closed with error");
            }
        });
    }
}

async fn handle_raw_connection(
    scene_index: u32,
    connection_id: u64,
    stream: TcpStream,
    event_tx: crate::process::ProcessEventSender,
    writers: super::ConnectionWriters,
    stats: Arc<crate::process::ProcessQueueStats>,
    read_buffer_bytes: usize,
) -> Result<()> {
    stream
        .set_nodelay(true)
        .context("failed to enable TCP_NODELAY")?;
    let stream = Rc::new(stream);
    let Some((connection_kind, first_frame_len)) = read_raw_preamble(&stream).await? else {
        return Ok(());
    };

    let (write_tx, write_rx) =
        mpsc::channel::<ConnectionWriteBatch>(CONNECTION_OUTBOUND_FRAME_CAPACITY);
    let queued_bytes = Arc::new(AtomicUsize::new(0));
    let queued_frames = Arc::new(AtomicUsize::new(0));
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let connection_writer = ConnectionWriter {
        sender: write_tx,
        queued_bytes: Arc::clone(&queued_bytes),
        queued_frames: Arc::clone(&queued_frames),
        shutdown_tx: shutdown_tx.clone(),
    };
    writers
        .lock()
        .expect("connection writer map poisoned")
        .insert(connection_id, connection_writer.clone());

    let writer_stream = Rc::clone(&stream);
    let writer_stats = Arc::clone(&stats);
    let writer_task = tokio_uring::spawn(async move {
        run_writer(
            writer_stream,
            write_rx,
            shutdown_rx,
            queued_bytes,
            queued_frames,
            writer_stats,
        )
        .await
    });

    let read_result = run_reader(
        scene_index,
        connection_id,
        connection_kind,
        first_frame_len,
        Rc::clone(&stream),
        event_tx.clone(),
        connection_writer,
        Arc::clone(&stats),
        read_buffer_bytes,
    )
    .await;

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

    read_result?;
    writer_task.await??;
    Ok(())
}

async fn run_reader(
    scene_index: u32,
    connection_id: u64,
    connection_kind: ConnectionKind,
    first_frame_len: Option<usize>,
    stream: Rc<TcpStream>,
    event_tx: crate::process::ProcessEventSender,
    connection_writer: ConnectionWriter,
    stats: Arc<crate::process::ProcessQueueStats>,
    read_buffer_bytes: usize,
) -> Result<()> {
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
        stats.transport_read_completed(frame_count, read);
    }
}

async fn run_writer(
    stream: Rc<TcpStream>,
    mut write_rx: mpsc::Receiver<ConnectionWriteBatch>,
    mut shutdown_rx: watch::Receiver<bool>,
    queued_bytes: Arc<AtomicUsize>,
    queued_frames: Arc<AtomicUsize>,
    stats: Arc<crate::process::ProcessQueueStats>,
) -> Result<()> {
    let mut packet = Vec::<u8>::with_capacity(WRITE_BATCH_BYTE_CAPACITY);
    loop {
        let batch = tokio::select! {
            changed = shutdown_rx.changed() => {
                if changed.is_err() || *shutdown_rx.borrow() {
                    // 关闭请求不能越过已入队的通知；先排空队列，再关闭 io_uring Socket。
                    // A close request must not overtake queued notices; drain the
                    // queue before shutting down the io_uring socket.
                    while let Ok(batch) = write_rx.try_recv() {
                        let frame_count = batch.frames.len();
                        let packet_bytes = batch.frame_bytes + frame_count * 4;
                        packet.clear();
                        packet.reserve(packet_bytes);
                        for frame in &batch.frames {
                            packet.extend_from_slice(&(frame.len() as u32).to_be_bytes());
                            packet.extend_from_slice(frame);
                        }
                        let (result, returned_packet) = stream.write_all(packet).await;
                        packet = returned_packet;
                        queued_bytes.fetch_sub(batch.frame_bytes, Ordering::Relaxed);
                        queued_frames.fetch_sub(frame_count, Ordering::Relaxed);
                        result?;
                        stats.transport_write_completed(frame_count, packet_bytes);
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

        packet.clear();
        packet.reserve(packet_bytes);
        for frame in &batch.frames {
            packet.extend_from_slice(&(frame.len() as u32).to_be_bytes());
            packet.extend_from_slice(frame);
        }
        let (result, returned_packet) = stream.write_all(packet).await;
        packet = returned_packet;
        queued_bytes.fetch_sub(batch.frame_bytes, Ordering::Relaxed);
        queued_frames.fetch_sub(frame_count, Ordering::Relaxed);
        result?;
        stats.transport_write_completed(frame_count, packet_bytes);
    }
    // 只有写队列完成后才关闭连接；否则最后一条业务通知可能还在内核队列之外。
    // Close only after the write queue is drained; otherwise the final business
    // notice may still be outside the kernel queue.
    let _ = stream.shutdown(Shutdown::Both);
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
