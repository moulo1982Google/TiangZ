use std::collections::HashMap;
use std::ffi::c_void;
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use sysinfo::{Pid, ProcessesToUpdate, System};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc as tokio_mpsc, watch};
use tokio_tungstenite::{accept_async, tungstenite::Message};

use crate::config::{ProcessConfig, RuntimeConfig, SceneConfig};
use crate::host::{
    BinaryOutboundBatch, call_js_push_host_events, call_js_string, call_js_update_binary,
    create_runtime,
};
use crate::inspector::ProcessInspector;
use crate::transport::{INNER_HANDSHAKE_MAGIC, init_remote_transport, inner_token};

const MAX_FRAME_LEN: usize = 1024 * 1024;
const PROCESS_TICK_MS: u64 = 50;
const PROCESS_EVENT_QUEUE_CAPACITY: usize = 4096;
const PROCESS_EVENT_BATCH_CAPACITY: usize = 512;
const CONNECTION_OUTBOUND_FRAME_CAPACITY: usize = 4096;
const CONNECTION_OUTBOUND_BYTE_CAPACITY: usize = 4 * 1024 * 1024;
const RAW_WRITE_BATCH_FRAME_CAPACITY: usize = 64;
const RAW_WRITE_BATCH_BYTE_CAPACITY: usize = 256 * 1024;
const EVENT_META_BYTES: usize = 9;
const BACKPRESSURE_RETRY_MS: u64 = 1;
const INNER_MSGCODE_START: u16 = 20_000;
const INNER_MSGCODE_END_EXCLUSIVE: u16 = 30_000;
const MAX_INNER_TOKEN_LEN: usize = 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ConnectionKind {
    External,
    Internal,
}

#[derive(Debug)]
enum ProcessEvent {
    Frame {
        scene_index: u32,
        connection_id: u64,
        frame: Vec<u8>,
    },
    Disconnect {
        scene_index: u32,
        connection_id: u64,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateResult {
    #[serde(default)]
    metrics: Vec<SceneMetricsSnapshot>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SceneMetricsSnapshot {
    scene: String,
    scene_type: String,
    processed_frames: u64,
    failed_frames: u64,
    ingress_queue_length: usize,
    max_ingress_queue_length: usize,
    last_update_cost_ms: f64,
    last_handler_cost_ms: f64,
    max_handler_cost_ms: f64,
    total_handler_cost_ms: f64,
}

type ConnectionWriters = Arc<Mutex<HashMap<u64, ConnectionWriter>>>;

#[derive(Default)]
struct V8GcMetrics {
    count: u64,
    total_duration: Duration,
    started_at: Option<Instant>,
}

extern "C" fn v8_gc_prologue(
    _isolate: deno_core::v8::UnsafeRawIsolatePtr,
    _gc_type: deno_core::v8::GCType,
    _flags: deno_core::v8::GCCallbackFlags,
    data: *mut c_void,
) {
    let metrics = unsafe { &mut *(data as *mut V8GcMetrics) };
    metrics.started_at = Some(Instant::now());
}

extern "C" fn v8_gc_epilogue(
    _isolate: deno_core::v8::UnsafeRawIsolatePtr,
    _gc_type: deno_core::v8::GCType,
    _flags: deno_core::v8::GCCallbackFlags,
    data: *mut c_void,
) {
    let metrics = unsafe { &mut *(data as *mut V8GcMetrics) };
    metrics.count += 1;
    if let Some(started_at) = metrics.started_at.take() {
        metrics.total_duration += started_at.elapsed();
    }
}

#[derive(Clone)]
struct ConnectionWriter {
    sender: tokio_mpsc::Sender<Bytes>,
    queued_bytes: Arc<AtomicUsize>,
    shutdown_tx: watch::Sender<bool>,
}

#[derive(Default)]
struct ProcessQueueStats {
    depth: AtomicUsize,
    max_depth: AtomicUsize,
    backpressure_waits: AtomicU64,
    slow_client_disconnects: AtomicU64,
    outbound_batches: AtomicU64,
    outbound_recipients: AtomicU64,
    outbound_bridge_bytes: AtomicU64,
    outbound_logical_bytes: AtomicU64,
}

impl ProcessQueueStats {
    fn queued(&self) {
        let depth = self.depth.fetch_add(1, Ordering::Relaxed) + 1;
        self.max_depth
            .fetch_max(depth.min(PROCESS_EVENT_QUEUE_CAPACITY), Ordering::Relaxed);
    }

    fn dequeue(&self) {
        let _ = self
            .depth
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                Some(value.saturating_sub(1))
            });
    }
}

#[derive(Clone)]
struct ProcessEventSender {
    sender: mpsc::SyncSender<ProcessEvent>,
    stats: Arc<ProcessQueueStats>,
}

impl ProcessEventSender {
    async fn send(
        &self,
        mut event: ProcessEvent,
        deadline: Option<tokio::time::Instant>,
    ) -> Result<(), String> {
        let mut counted_backpressure = false;
        loop {
            self.stats.queued();
            match self.sender.try_send(event) {
                Ok(()) => return Ok(()),
                Err(mpsc::TrySendError::Full(returned)) => {
                    self.stats.dequeue();
                    event = returned;
                    if !counted_backpressure {
                        self.stats
                            .backpressure_waits
                            .fetch_add(1, Ordering::Relaxed);
                        counted_backpressure = true;
                    }
                    if deadline.is_some_and(|deadline| deadline <= tokio::time::Instant::now()) {
                        return Err("process ingress queue is overloaded".to_string());
                    }
                    tokio::time::sleep(Duration::from_millis(BACKPRESSURE_RETRY_MS)).await;
                }
                Err(mpsc::TrySendError::Disconnected(_)) => {
                    self.stats.dequeue();
                    return Err("process event queue is stopped".to_string());
                }
            }
        }
    }
}

pub async fn run_runtime_config(
    root: &Path,
    resolved_config: &Path,
    config: RuntimeConfig,
) -> Result<()> {
    init_remote_transport();
    let app_path = root.join("dist").join("main.js");
    let app_code = std::fs::read_to_string(&app_path)
        .with_context(|| format!("failed to read {}", app_path.display()))?;
    let app_module_url = deno_core::ModuleSpecifier::from_file_path(&app_path)
        .map_err(|_| anyhow::anyhow!("failed to convert {} to a file URL", app_path.display()))?
        .to_string();

    println!(
        "starting process {} with one V8 and {} scene(s) from {}",
        config.process.name,
        config.scenes.len(),
        resolved_config.display()
    );

    let mut listeners = Vec::with_capacity(config.scenes.len());
    for (scene_index, scene) in config.scenes.iter().cloned().enumerate() {
        let bind_addr = format!("{}:{}", scene.ip, scene.port);
        let listener = TcpListener::bind(&bind_addr)
            .await
            .with_context(|| format!("scene {} failed to bind {}", scene.name, bind_addr))?;
        println!(
            "scene {} ({}) listening on {}",
            scene.name, scene.scene_type, bind_addr
        );
        listeners.push((scene_index as u32, scene, listener));
    }

    let (event_tx, event_rx) = mpsc::sync_channel::<ProcessEvent>(PROCESS_EVENT_QUEUE_CAPACITY);
    let queue_stats = Arc::new(ProcessQueueStats::default());
    let writers: ConnectionWriters = Arc::new(Mutex::new(HashMap::new()));
    let event_tx = ProcessEventSender {
        sender: event_tx,
        stats: Arc::clone(&queue_stats),
    };
    let next_connection_id = Arc::new(AtomicU64::new(1));

    let process = config.process.clone();
    let scenes = config.scenes.clone();
    let known_scenes = config.known_scenes.clone();
    let runtime_writers = Arc::clone(&writers);
    thread::spawn(move || {
        if let Err(error) = run_process_runtime(
            process,
            scenes,
            known_scenes,
            app_code,
            app_module_url,
            event_rx,
            runtime_writers,
            queue_stats,
        ) {
            eprintln!("process runtime stopped: {error:?}");
        }
    });

    for (scene_index, scene, listener) in listeners {
        let event_tx = event_tx.clone();
        let writers = Arc::clone(&writers);
        let next_connection_id = Arc::clone(&next_connection_id);
        tokio::spawn(async move {
            if let Err(error) = run_scene_listener(
                scene_index,
                scene,
                listener,
                event_tx,
                writers,
                next_connection_id,
            )
            .await
            {
                eprintln!("scene listener stopped: {error:?}");
            }
        });
    }

    tokio::signal::ctrl_c().await?;
    Ok(())
}

async fn run_scene_listener(
    scene_index: u32,
    scene: SceneConfig,
    listener: TcpListener,
    event_tx: ProcessEventSender,
    writers: ConnectionWriters,
    next_connection_id: Arc<AtomicU64>,
) -> Result<()> {
    loop {
        let (stream, peer) = listener.accept().await?;
        let connection_id = next_connection_id.fetch_add(1, Ordering::Relaxed);
        println!("{} accepted {} as conn {}", scene.name, peer, connection_id);

        let event_tx = event_tx.clone();
        let writers = Arc::clone(&writers);
        tokio::spawn(async move {
            if let Err(error) =
                handle_connection(scene_index, connection_id, stream, event_tx, writers).await
            {
                eprintln!("conn {connection_id} error: {error:?}");
            }
        });
    }
}

fn run_process_runtime(
    process: ProcessConfig,
    scenes: Vec<SceneConfig>,
    known_scenes: Vec<SceneConfig>,
    app_code: String,
    app_module_url: String,
    event_rx: mpsc::Receiver<ProcessEvent>,
    writers: ConnectionWriters,
    queue_stats: Arc<ProcessQueueStats>,
) -> Result<()> {
    let process_name = process.name.clone();
    let js_event_loop = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("failed to create JS event loop runtime")?;
    // This state must outlive the V8 isolate because V8 stores its raw pointer.
    let mut gc_metrics = Box::<V8GcMetrics>::default();
    let gc_metrics_ptr = (&mut *gc_metrics) as *mut V8GcMetrics as *mut c_void;
    let mut runtime = {
        let _guard = js_event_loop.enter();
        create_runtime(process.debug.is_some()).context("failed to create V8 runtime")?
    };
    runtime.v8_isolate().add_gc_prologue_callback(
        v8_gc_prologue,
        gc_metrics_ptr,
        deno_core::v8::GCType::kGCTypeAll,
    );
    runtime.v8_isolate().add_gc_epilogue_callback(
        v8_gc_epilogue,
        gc_metrics_ptr,
        deno_core::v8::GCType::kGCTypeAll,
    );
    let _inspector = ProcessInspector::start(&mut runtime, &process, app_module_url.clone())?;
    {
        let _guard = js_event_loop.enter();
        runtime
            .execute_script(deno_core::FastString::from(app_module_url), app_code)
            .context("failed to execute dist/main.js")?;
    }

    let process_config = json!({
        "process": process,
        "scenes": scenes,
        "knownScenes": known_scenes,
        "tickMs": PROCESS_TICK_MS,
    });
    let start_result = call_js_string(
        &js_event_loop,
        &mut runtime,
        "__etsStartProcess",
        &serde_json::to_string(&process_config)?,
    )?;
    println!("{start_result}");

    let mut last_metrics_log = Instant::now();
    let process_pid = Pid::from_u32(std::process::id());
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::Some(&[process_pid]), false);
    let mut last_process_cpu_time_ms = system
        .process(process_pid)
        .map(|process| process.accumulated_cpu_time())
        .unwrap_or_default();
    let mut last_resource_sample_at = Instant::now();
    loop {
        let mut event_meta = Vec::<u8>::new();
        let mut binary_args = Vec::<Vec<u8>>::new();
        match event_rx.recv_timeout(Duration::from_millis(PROCESS_TICK_MS)) {
            Ok(event) => {
                queue_stats.dequeue();
                push_event(&mut event_meta, &mut binary_args, event)?
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }

        while event_meta.len() < PROCESS_EVENT_BATCH_CAPACITY * EVENT_META_BYTES {
            match event_rx.try_recv() {
                Ok(event) => {
                    queue_stats.dequeue();
                    push_event(&mut event_meta, &mut binary_args, event)?
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => break,
            }
        }

        flush_runtime_batch(
            &js_event_loop,
            &mut runtime,
            &writers,
            &mut event_meta,
            &mut binary_args,
            &process_name,
            &mut last_metrics_log,
            &queue_stats,
            &mut system,
            process_pid,
            &gc_metrics,
            &mut last_process_cpu_time_ms,
            &mut last_resource_sample_at,
        )?;
    }

    runtime
        .v8_isolate()
        .remove_gc_prologue_callback(v8_gc_prologue, gc_metrics_ptr);
    runtime
        .v8_isolate()
        .remove_gc_epilogue_callback(v8_gc_epilogue, gc_metrics_ptr);

    Ok(())
}

fn flush_runtime_batch(
    js_event_loop: &tokio::runtime::Runtime,
    runtime: &mut deno_core::JsRuntime,
    writers: &ConnectionWriters,
    event_meta: &mut Vec<u8>,
    binary_args: &mut Vec<Vec<u8>>,
    process_name: &str,
    last_metrics_log: &mut Instant,
    queue_stats: &ProcessQueueStats,
    system: &mut System,
    process_pid: Pid,
    gc_metrics: &V8GcMetrics,
    last_process_cpu_time_ms: &mut u64,
    last_resource_sample_at: &mut Instant,
) -> Result<()> {
    if !event_meta.is_empty() {
        call_js_push_host_events(
            runtime,
            std::mem::take(event_meta),
            std::mem::take(binary_args),
        )?;
    }

    let (outbound_json, outbound) = call_js_update_binary(js_event_loop, runtime)?;
    let result: UpdateResult = serde_json::from_str(&outbound_json).with_context(|| {
        format!("TS update returned invalid outbound frame list: {outbound_json}")
    })?;
    maybe_log_metrics(
        process_name,
        &result.metrics,
        last_metrics_log,
        queue_stats,
        runtime,
        system,
        process_pid,
        gc_metrics,
        last_process_cpu_time_ms,
        last_resource_sample_at,
    );
    flush_outbound(outbound, writers, queue_stats)
}

fn maybe_log_metrics(
    process_name: &str,
    metrics: &[SceneMetricsSnapshot],
    last_metrics_log: &mut Instant,
    queue_stats: &ProcessQueueStats,
    runtime: &mut deno_core::JsRuntime,
    system: &mut System,
    process_pid: Pid,
    gc_metrics: &V8GcMetrics,
    last_process_cpu_time_ms: &mut u64,
    last_resource_sample_at: &mut Instant,
) {
    if last_metrics_log.elapsed() < Duration::from_secs(5) {
        return;
    }
    *last_metrics_log = Instant::now();
    system.refresh_processes(ProcessesToUpdate::Some(&[process_pid]), false);
    let (cpu_time_ms, rss_bytes) = system
        .process(process_pid)
        .map(|process| (process.accumulated_cpu_time(), process.memory()))
        .unwrap_or_default();
    let resource_elapsed_ms = last_resource_sample_at.elapsed().as_secs_f64() * 1000.0;
    let cpu_delta_ms = cpu_time_ms.saturating_sub(*last_process_cpu_time_ms) as f64;
    let cpu_percent = if resource_elapsed_ms > 0.0 {
        cpu_delta_ms / resource_elapsed_ms * 100.0
    } else {
        0.0
    };
    *last_process_cpu_time_ms = cpu_time_ms;
    *last_resource_sample_at = Instant::now();
    let heap = runtime.v8_isolate().get_heap_statistics();
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    println!(
        "[process-metrics] process={process_name} cpu_percent={cpu_percent:.2} cpu_time_ms={cpu_time_ms} rss_bytes={rss_bytes} v8_heap_used_bytes={} v8_heap_total_bytes={} v8_gc_count={} v8_gc_ms={:.3} timestamp_ms={timestamp_ms} outbound_batches={} outbound_recipients={} outbound_bridge_bytes={} outbound_logical_bytes={}",
        heap.used_heap_size(),
        heap.total_heap_size(),
        gc_metrics.count,
        gc_metrics.total_duration.as_secs_f64() * 1000.0,
        queue_stats.outbound_batches.load(Ordering::Relaxed),
        queue_stats.outbound_recipients.load(Ordering::Relaxed),
        queue_stats.outbound_bridge_bytes.load(Ordering::Relaxed),
        queue_stats.outbound_logical_bytes.load(Ordering::Relaxed),
    );
    for metric in metrics {
        println!(
            "[metrics:{process_name}] scene={} type={} processed={} failed={} ts_queue={} ts_max_queue={} rust_queue={} rust_max_queue={} backpressure={} slow_disconnects={} update_ms={:.2} handler_ms={:.2} max_handler_ms={:.2} total_handler_ms={:.2}",
            metric.scene,
            metric.scene_type,
            metric.processed_frames,
            metric.failed_frames,
            metric.ingress_queue_length,
            metric.max_ingress_queue_length,
            queue_stats
                .depth
                .load(Ordering::Relaxed)
                .min(PROCESS_EVENT_QUEUE_CAPACITY),
            queue_stats.max_depth.load(Ordering::Relaxed),
            queue_stats.backpressure_waits.load(Ordering::Relaxed),
            queue_stats.slow_client_disconnects.load(Ordering::Relaxed),
            metric.last_update_cost_ms,
            metric.last_handler_cost_ms,
            metric.max_handler_cost_ms,
            metric.total_handler_cost_ms,
        );
    }
}

fn push_event(
    event_meta: &mut Vec<u8>,
    binary_args: &mut Vec<Vec<u8>>,
    event: ProcessEvent,
) -> Result<()> {
    match event {
        ProcessEvent::Frame {
            scene_index,
            connection_id,
            frame,
        } => {
            binary_args.push(frame);
            push_event_meta(event_meta, 1, connection_id, scene_index)?;
        }
        ProcessEvent::Disconnect {
            scene_index,
            connection_id,
        } => {
            push_event_meta(event_meta, 2, connection_id, scene_index)?;
        }
    }
    Ok(())
}

fn push_event_meta(
    event_meta: &mut Vec<u8>,
    event_type: u8,
    connection_id: u64,
    scene_index: u32,
) -> Result<()> {
    let connection_id = u32::try_from(connection_id).context("connection id exceeds uint32")?;
    event_meta.push(event_type);
    event_meta.extend_from_slice(&connection_id.to_le_bytes());
    event_meta.extend_from_slice(&scene_index.to_le_bytes());
    Ok(())
}

fn flush_outbound(
    outbound: Vec<BinaryOutboundBatch>,
    writers: &ConnectionWriters,
    queue_stats: &ProcessQueueStats,
) -> Result<()> {
    if outbound.is_empty() {
        return Ok(());
    }

    let mut writers = writers.lock().expect("connection writer map poisoned");
    let mut slow_connections = Vec::new();
    for batch in outbound {
        let frame_len = batch.frame.len();
        let recipient_count = batch.connection_ids.len() as u64;
        queue_stats.outbound_batches.fetch_add(1, Ordering::Relaxed);
        queue_stats
            .outbound_recipients
            .fetch_add(recipient_count, Ordering::Relaxed);
        queue_stats
            .outbound_bridge_bytes
            .fetch_add(frame_len as u64, Ordering::Relaxed);
        queue_stats.outbound_logical_bytes.fetch_add(
            (frame_len as u64).saturating_mul(recipient_count),
            Ordering::Relaxed,
        );
        for connection_id in batch.connection_ids {
            if let Some(writer) = writers.get(&connection_id) {
                let queued =
                    writer.queued_bytes.fetch_add(frame_len, Ordering::Relaxed) + frame_len;
                if queued > CONNECTION_OUTBOUND_BYTE_CAPACITY {
                    writer.queued_bytes.fetch_sub(frame_len, Ordering::Relaxed);
                    slow_connections.push(connection_id);
                    continue;
                }
                if writer.sender.try_send(batch.frame.clone()).is_err() {
                    writer.queued_bytes.fetch_sub(frame_len, Ordering::Relaxed);
                    slow_connections.push(connection_id);
                }
            }
        }
    }

    slow_connections.sort_unstable();
    slow_connections.dedup();
    for connection_id in slow_connections {
        if let Some(writer) = writers.remove(&connection_id) {
            let _ = writer.shutdown_tx.send(true);
            queue_stats
                .slow_client_disconnects
                .fetch_add(1, Ordering::Relaxed);
            eprintln!("closing slow connection {connection_id}: outbound queue limit exceeded");
        }
    }
    Ok(())
}

async fn handle_connection(
    scene_index: u32,
    connection_id: u64,
    stream: TcpStream,
    event_tx: ProcessEventSender,
    writers: ConnectionWriters,
) -> Result<()> {
    stream
        .set_nodelay(true)
        .context("failed to enable TCP_NODELAY")?;
    let mut probe = [0_u8; 3];
    let is_websocket = stream.peek(&mut probe).await? >= 3 && probe == *b"GET";
    if is_websocket {
        handle_websocket_connection(scene_index, connection_id, stream, event_tx, writers).await
    } else {
        handle_raw_tcp_connection(scene_index, connection_id, stream, event_tx, writers).await
    }
}

async fn handle_raw_tcp_connection(
    scene_index: u32,
    connection_id: u64,
    stream: TcpStream,
    event_tx: ProcessEventSender,
    writers: ConnectionWriters,
) -> Result<()> {
    let (mut reader, mut writer) = stream.into_split();
    let Some((connection_kind, mut first_frame_len)) = read_raw_preamble(&mut reader).await? else {
        return Ok(());
    };
    let (write_tx, mut write_rx) = tokio_mpsc::channel::<Bytes>(CONNECTION_OUTBOUND_FRAME_CAPACITY);
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
    let writer_task = tokio::spawn(async move {
        loop {
            let frame = tokio::select! {
                changed = writer_shutdown.changed() => {
                    if changed.is_err() || *writer_shutdown.borrow() {
                        break;
                    }
                    continue;
                }
                frame = write_rx.recv() => {
                    let Some(frame) = frame else { break; };
                    frame
                }
            };
            let mut frame_count = 1;
            let mut queued_frame_bytes = frame.len();
            let mut packet = Vec::with_capacity(4 + frame.len());
            append_raw_frame(&mut packet, &frame)?;
            while frame_count < RAW_WRITE_BATCH_FRAME_CAPACITY
                && packet.len() < RAW_WRITE_BATCH_BYTE_CAPACITY
            {
                let Ok(frame) = write_rx.try_recv() else {
                    break;
                };
                queued_frame_bytes += frame.len();
                append_raw_frame(&mut packet, &frame)?;
                frame_count += 1;
            }
            let result = tokio::select! {
                changed = writer_shutdown.changed() => {
                    if changed.is_err() || *writer_shutdown.borrow() {
                        break;
                    }
                    continue;
                }
                result = writer.write_all(&packet) => result.map_err(anyhow::Error::from),
            };
            writer_queued_bytes.fetch_sub(queued_frame_bytes, Ordering::Relaxed);
            if let Err(error) = result {
                let _ = writer_shutdown_tx.send(true);
                return Err(error);
            }
        }
        Result::<()>::Ok(())
    });

    let mut reader_shutdown = shutdown_rx;
    loop {
        let frame = tokio::select! {
            changed = reader_shutdown.changed() => {
                if changed.is_err() || *reader_shutdown.borrow() {
                    break;
                }
                continue;
            }
            frame = read_raw_frame(&mut reader, &mut first_frame_len) => frame?,
        };
        let Some(frame) = frame else {
            break;
        };
        validate_frame_access(connection_kind, &frame)?;
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
    writer_task.await??;
    Ok(())
}

async fn handle_websocket_connection(
    scene_index: u32,
    connection_id: u64,
    stream: TcpStream,
    event_tx: ProcessEventSender,
    writers: ConnectionWriters,
) -> Result<()> {
    let websocket = accept_async(stream).await?;
    let (mut writer, mut reader) = websocket.split();
    let (write_tx, mut write_rx) = tokio_mpsc::channel::<Bytes>(CONNECTION_OUTBOUND_FRAME_CAPACITY);
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
    let writer_task = tokio::spawn(async move {
        loop {
            let frame = tokio::select! {
                changed = writer_shutdown.changed() => {
                    if changed.is_err() || *writer_shutdown.borrow() {
                        break;
                    }
                    continue;
                }
                frame = write_rx.recv() => {
                    let Some(frame) = frame else { break; };
                    frame
                }
            };
            let frame_len = frame.len();
            let result = tokio::select! {
                changed = writer_shutdown.changed() => {
                    if changed.is_err() || *writer_shutdown.borrow() {
                        break;
                    }
                    continue;
                }
                result = writer.send(Message::Binary(frame.into())) => result,
            };
            writer_queued_bytes.fetch_sub(frame_len, Ordering::Relaxed);
            if let Err(error) = result {
                let _ = writer_shutdown_tx.send(true);
                return Err(error.into());
            }
        }
        Result::<()>::Ok(())
    });

    let mut reader_shutdown = shutdown_rx;
    loop {
        let message = tokio::select! {
            changed = reader_shutdown.changed() => {
                if changed.is_err() || *reader_shutdown.borrow() {
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
                event_tx
                    .send(
                        ProcessEvent::Frame {
                            scene_index,
                            connection_id,
                            frame: frame.to_vec(),
                        },
                        None,
                    )
                    .await
                    .map_err(anyhow::Error::msg)?;
            }
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) => {}
            Message::Text(_) => {
                bail!("websocket text frames are not supported");
            }
            Message::Frame(_) => {}
        }
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
    writer_task.await??;
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

fn validate_frame_access(kind: ConnectionKind, frame: &[u8]) -> Result<()> {
    if frame.len() < 2 {
        bail!("frame is shorter than msgcode");
    }
    let msgcode = u16::from_be_bytes([frame[0], frame[1]]);
    let is_inner = (INNER_MSGCODE_START..INNER_MSGCODE_END_EXCLUSIVE).contains(&msgcode);
    match (kind, is_inner) {
        (ConnectionKind::External, true) => {
            bail!("external connection cannot send inner msgcode {msgcode}")
        }
        (ConnectionKind::Internal, false) => {
            bail!("internal connection cannot send outer msgcode {msgcode}")
        }
        _ => Ok(()),
    }
}

fn append_raw_frame(packet: &mut Vec<u8>, frame: &[u8]) -> Result<()> {
    let len = u32::try_from(frame.len()).context("outbound frame too large")?;
    packet.extend_from_slice(&len.to_be_bytes());
    packet.extend_from_slice(frame);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn bounded_process_queue_applies_backpressure() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let stats = Arc::new(ProcessQueueStats::default());
        let sender = ProcessEventSender {
            sender,
            stats: Arc::clone(&stats),
        };

        sender
            .send(
                ProcessEvent::Disconnect {
                    scene_index: 0,
                    connection_id: 1,
                },
                None,
            )
            .await
            .unwrap();
        let second_sender = sender.clone();
        let second = tokio::spawn(async move {
            second_sender
                .send(
                    ProcessEvent::Disconnect {
                        scene_index: 0,
                        connection_id: 2,
                    },
                    None,
                )
                .await
        });

        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(!second.is_finished());
        assert!(stats.backpressure_waits.load(Ordering::Relaxed) >= 1);

        receiver.recv().unwrap();
        stats.dequeue();
        second.await.unwrap().unwrap();
        receiver.recv().unwrap();
        stats.dequeue();
        assert_eq!(stats.depth.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn slow_connection_is_closed_when_outbound_queue_is_full() {
        let writers: ConnectionWriters = Arc::new(Mutex::new(HashMap::new()));
        let (sender, _receiver) = tokio_mpsc::channel(1);
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        writers.lock().unwrap().insert(
            7,
            ConnectionWriter {
                sender,
                queued_bytes: Arc::new(AtomicUsize::new(0)),
                shutdown_tx,
            },
        );
        let stats = ProcessQueueStats::default();

        flush_outbound(
            vec![
                BinaryOutboundBatch {
                    connection_ids: vec![7],
                    frame: Bytes::from_static(&[0, 1]),
                },
                BinaryOutboundBatch {
                    connection_ids: vec![7],
                    frame: Bytes::from_static(&[0, 2]),
                },
            ],
            &writers,
            &stats,
        )
        .unwrap();

        assert!(!writers.lock().unwrap().contains_key(&7));
        assert!(*shutdown_rx.borrow());
        assert_eq!(stats.slow_client_disconnects.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn outbound_batch_fans_out_shared_bytes() {
        let writers: ConnectionWriters = Arc::new(Mutex::new(HashMap::new()));
        let (sender1, mut receiver1) = tokio_mpsc::channel(1);
        let (sender2, mut receiver2) = tokio_mpsc::channel(1);
        for (connection_id, sender) in [(1, sender1), (2, sender2)] {
            let (shutdown_tx, _shutdown_rx) = watch::channel(false);
            writers.lock().unwrap().insert(
                connection_id,
                ConnectionWriter {
                    sender,
                    queued_bytes: Arc::new(AtomicUsize::new(0)),
                    shutdown_tx,
                },
            );
        }
        let stats = ProcessQueueStats::default();
        let frame = Bytes::from_static(&[0, 1, 2, 3]);

        flush_outbound(
            vec![BinaryOutboundBatch {
                connection_ids: vec![1, 2],
                frame,
            }],
            &writers,
            &stats,
        )
        .unwrap();

        let received1 = receiver1.try_recv().unwrap();
        let received2 = receiver2.try_recv().unwrap();
        assert_eq!(received1, received2);
        assert_eq!(received1.as_ptr(), received2.as_ptr());
        assert_eq!(stats.outbound_batches.load(Ordering::Relaxed), 1);
        assert_eq!(stats.outbound_recipients.load(Ordering::Relaxed), 2);
        assert_eq!(stats.outbound_bridge_bytes.load(Ordering::Relaxed), 4);
        assert_eq!(stats.outbound_logical_bytes.load(Ordering::Relaxed), 8);
    }

    #[test]
    fn separates_inner_and_outer_msgcodes() {
        assert!(validate_frame_access(ConnectionKind::External, &[0x27, 0x12]).is_ok());
        assert!(validate_frame_access(ConnectionKind::External, &[0x4e, 0x22]).is_err());
        assert!(validate_frame_access(ConnectionKind::Internal, &[0x4e, 0x22]).is_ok());
        assert!(validate_frame_access(ConnectionKind::Internal, &[0x27, 0x12]).is_err());
    }
}
