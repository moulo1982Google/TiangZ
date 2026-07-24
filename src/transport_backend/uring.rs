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
    CONNECTION_OUTBOUND_FRAME_CAPACITY, ConnectionKind, ConnectionWriter, EndpointContext,
    IoBackend, MAX_INNER_TOKEN_LEN, RawFrameDecoder, WRITE_BATCH_BYTE_CAPACITY,
    WRITE_BATCH_FRAME_CAPACITY, validate_frame_access,
};
use crate::process::ProcessEvent;
use crate::transport::{INNER_HANDSHAKE_MAGIC, inner_token};

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
        let bind_addr = format!("{}:{}", context.scene.ip, context.scene.port);
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

    let (write_tx, write_rx) = mpsc::channel::<Bytes>(CONNECTION_OUTBOUND_FRAME_CAPACITY);
    let queued_bytes = Arc::new(AtomicUsize::new(0));
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    writers
        .lock()
        .expect("connection writer map poisoned")
        .insert(
            connection_id,
            ConnectionWriter {
                sender: write_tx,
                queued_bytes: Arc::clone(&queued_bytes),
                shutdown_tx: shutdown_tx.clone(),
            },
        );

    let writer_stream = Rc::clone(&stream);
    let writer_shutdown_tx = shutdown_tx.clone();
    let writer_stats = Arc::clone(&stats);
    let writer_task = tokio_uring::spawn(async move {
        let result = run_writer(writer_stream, write_rx, queued_bytes, writer_stats).await;
        let _ = writer_shutdown_tx.send(true);
        result
    });

    let shutdown_stream = Rc::clone(&stream);
    let mut shutdown_rx = shutdown_rx;
    tokio_uring::spawn(async move {
        while shutdown_rx.changed().await.is_ok() {
            if *shutdown_rx.borrow() {
                let _ = shutdown_stream.shutdown(Shutdown::Both);
                break;
            }
        }
    });

    let read_result = run_reader(
        scene_index,
        connection_id,
        connection_kind,
        first_frame_len,
        Rc::clone(&stream),
        event_tx.clone(),
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
        stats.transport_read_completed(frame_count, read);
    }
}

async fn run_writer(
    stream: Rc<TcpStream>,
    mut write_rx: mpsc::Receiver<Bytes>,
    queued_bytes: Arc<AtomicUsize>,
    stats: Arc<crate::process::ProcessQueueStats>,
) -> Result<()> {
    let mut frames = Vec::<Bytes>::with_capacity(WRITE_BATCH_FRAME_CAPACITY);
    let mut packet = Vec::<u8>::with_capacity(WRITE_BATCH_BYTE_CAPACITY);
    while let Some(frame) = write_rx.recv().await {
        frames.clear();
        let mut queued_frame_bytes = frame.len();
        let mut packet_bytes = 4 + frame.len();
        frames.push(frame);
        while frames.len() < WRITE_BATCH_FRAME_CAPACITY && packet_bytes < WRITE_BATCH_BYTE_CAPACITY
        {
            let Ok(frame) = write_rx.try_recv() else {
                break;
            };
            queued_frame_bytes += frame.len();
            packet_bytes += 4 + frame.len();
            frames.push(frame);
        }

        packet.clear();
        packet.reserve(packet_bytes);
        for frame in &frames {
            packet.extend_from_slice(&(frame.len() as u32).to_be_bytes());
            packet.extend_from_slice(frame);
        }
        let (result, returned_packet) = stream.write_all(packet).await;
        packet = returned_packet;
        queued_bytes.fetch_sub(queued_frame_bytes, Ordering::Relaxed);
        result?;
        stats.transport_write_completed(frames.len(), packet_bytes);
    }
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
