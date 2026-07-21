use std::collections::HashMap;
use std::ffi::c_void;
use std::io::IoSlice;
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

use crate::config::{ProcessConfig, ProcessSchedulingMode, RuntimeConfig, SceneConfig};
use crate::host::{
    BinaryOutboundBatch, HostSceneCompletion, call_js_push_host_events, call_js_start_process,
    call_js_update_binary, configure_host_scene_bridge, create_runtime, load_js_entrypoints,
    pump_js_event_loop_once,
};
use crate::inspector::ProcessInspector;
use crate::transport::{INNER_HANDSHAKE_MAGIC, init_remote_transport, inner_token};

const MAX_FRAME_LEN: usize = 1024 * 1024;
const PROCESS_EVENT_QUEUE_CAPACITY: usize = 4096;
const CONNECTION_OUTBOUND_FRAME_CAPACITY: usize = 4096;
const CONNECTION_OUTBOUND_BYTE_CAPACITY: usize = 4 * 1024 * 1024;
const RAW_WRITE_BATCH_FRAME_CAPACITY: usize = 64;
const RAW_WRITE_BATCH_BYTE_CAPACITY: usize = 256 * 1024;
const EVENT_HEADER_BYTES: usize = 13;
const BACKPRESSURE_RETRY_MS: u64 = 1;
const INNER_MSGCODE_START: u16 = 20_000;
const INNER_MSGCODE_END_EXCLUSIVE: u16 = 30_000;
const MAX_INNER_TOKEN_LEN: usize = 1024;

#[derive(Clone, Copy)]
struct RuntimeScheduling {
    mode: ProcessSchedulingMode,
    idle_tick_ms: u64,
    max_events_per_update: usize,
    coalesce_micros: u64,
}

impl RuntimeScheduling {
    fn from_process(process: &ProcessConfig) -> Self {
        //空闲时tick 间隔default_tick毫秒，每次最多处理default_batch个Rust事件，聚合窗口时间（微妙）
        let (default_tick, default_batch, default_coalesce) = match process.scheduling.mode {
            ProcessSchedulingMode::LowLatency => (10, 64, 0),
            ProcessSchedulingMode::Throughput => (50, 1024, 1_000),
            ProcessSchedulingMode::Adaptive => (50, 512, 250),
        };
        Self {
            mode: process.scheduling.mode,
            idle_tick_ms: process
                .scheduling
                .idle_tick_ms
                .unwrap_or(default_tick)
                .min(process.game.fixed_update_ms),
            max_events_per_update: process
                .scheduling
                .max_events_per_update
                .unwrap_or(default_batch),
            coalesce_micros: process
                .scheduling
                .coalesce_micros
                .unwrap_or(default_coalesce),
        }
    }

    fn batch_capacity(self, queued_events: usize) -> usize {
        match self.mode {
            ProcessSchedulingMode::Adaptive if queued_events < 64 => {
                self.max_events_per_update.min(64)
            }
            _ => self.max_events_per_update,
        }
    }

    fn coalesce_deadline(self, queued_events: usize) -> Instant {
        let micros = match self.mode {
            ProcessSchedulingMode::Adaptive if queued_events < 8 => 0,
            _ => self.coalesce_micros,
        };
        Instant::now() + Duration::from_micros(micros)
    }
}

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
    HostSceneCompletion(HostSceneCompletion),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateResult {
    #[serde(default)]
    metrics: Vec<SceneMetricsSnapshot>,
    #[serde(default)]
    game: Option<GameMetricsSnapshot>,
    #[serde(default)]
    pending_async: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GameMetricsSnapshot {
    fixed_update_ms: u64,
    frame_count: u64,
    skipped_fixed_updates: u64,
    update_targets: usize,
    update_calls: u64,
    update_failures: u64,
    timers: usize,
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
    #[serde(default)]
    async_in_flight: usize,
    #[serde(default)]
    max_async_in_flight: usize,
    #[serde(default)]
    latencies: Vec<LatencyMetricSnapshot>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LatencyMetricSnapshot {
    name: String,
    msgcode: Option<u16>,
    count: u64,
    avg_ms: f64,
    p50_ms: f64,
    p95_ms: f64,
    p99_ms: f64,
    max_ms: f64,
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
    inbound_frames: AtomicU64,
    host_completions: AtomicU64,
    disconnects: AtomicU64,
    runtime_updates: AtomicU64,
    runtime_events: AtomicU64,
    max_runtime_batch: AtomicUsize,
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

    fn try_send_completion(
        &self,
        completion: HostSceneCompletion,
    ) -> std::result::Result<(), HostSceneCompletion> {
        self.stats.queued();
        match self
            .sender
            .try_send(ProcessEvent::HostSceneCompletion(completion))
        {
            Ok(()) => Ok(()),
            Err(mpsc::TrySendError::Full(ProcessEvent::HostSceneCompletion(completion))) => {
                self.stats.dequeue();
                self.stats
                    .backpressure_waits
                    .fetch_add(1, Ordering::Relaxed);
                Err(completion)
            }
            Err(mpsc::TrySendError::Disconnected(_)) => {
                self.stats.dequeue();
                Ok(())
            }
            Err(_) => unreachable!("completion event changed while entering the process queue"),
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
    let completion_sender = event_tx.clone();
    let completion_sink: crate::host::HostSceneCompletionSink =
        Arc::new(move |completion| completion_sender.try_send_completion(completion));

    let process = config.process.clone();
    let scenes = config.scenes.clone();
    let known_scenes = config.known_scenes.clone();
    let runtime_writers = Arc::clone(&writers);
    let host_runtime = tokio::runtime::Handle::current();
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
            host_runtime,
            completion_sink,
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
    host_runtime: tokio::runtime::Handle,
    completion_sink: crate::host::HostSceneCompletionSink,
) -> Result<()> {
    let process_name = process.name.clone();
    let scheduling = RuntimeScheduling::from_process(&process);
    let js_event_loop = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("failed to create JS event loop runtime")?;
    configure_host_scene_bridge(host_runtime, completion_sink);
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
        "tickMs": process.game.fixed_update_ms,
    });
    let entrypoints = load_js_entrypoints(&mut runtime)?;
    let start_result = call_js_start_process(
        &js_event_loop,
        &mut runtime,
        &entrypoints,
        &serde_json::to_string(&process_config)?,
    )?;
    println!("{start_result}");
    println!(
        "[process:{process_name}] scheduling={:?} idle_tick_ms={} max_events_per_update={} coalesce_micros={}",
        scheduling.mode,
        scheduling.idle_tick_ms,
        scheduling.max_events_per_update,
        scheduling.coalesce_micros,
    );

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
        let mut packed_events = vec![0; 4];
        let mut event_count = 0_u32;
        let wait_ms = scheduling.idle_tick_ms;
        match event_rx.recv_timeout(Duration::from_millis(wait_ms)) {
            Ok(event) => {
                queue_stats.dequeue();
                push_event(&mut packed_events, &mut event_count, event, &queue_stats)?;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }

        let batch_capacity = scheduling
            .batch_capacity(queue_stats.depth.load(Ordering::Relaxed) + event_count as usize);
        let coalesce_deadline = scheduling
            .coalesce_deadline(queue_stats.depth.load(Ordering::Relaxed) + event_count as usize);
        while event_count < batch_capacity as u32 {
            match event_rx.try_recv() {
                Ok(event) => {
                    queue_stats.dequeue();
                    push_event(&mut packed_events, &mut event_count, event, &queue_stats)?;
                }
                Err(mpsc::TryRecvError::Empty) => {
                    if Instant::now() >= coalesce_deadline {
                        break;
                    }
                    thread::yield_now();
                }
                Err(mpsc::TryRecvError::Disconnected) => break,
            }
        }
        let _pending_async = flush_runtime_batch(
            &js_event_loop,
            &mut runtime,
            &entrypoints,
            &writers,
            &mut packed_events,
            event_count,
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
    entrypoints: &crate::host::JsEntrypoints,
    writers: &ConnectionWriters,
    packed_events: &mut Vec<u8>,
    event_count: u32,
    process_name: &str,
    last_metrics_log: &mut Instant,
    queue_stats: &ProcessQueueStats,
    system: &mut System,
    process_pid: Pid,
    gc_metrics: &V8GcMetrics,
    last_process_cpu_time_ms: &mut u64,
    last_resource_sample_at: &mut Instant,
) -> Result<bool> {
    queue_stats.runtime_updates.fetch_add(1, Ordering::Relaxed);
    queue_stats
        .runtime_events
        .fetch_add(event_count as u64, Ordering::Relaxed);
    queue_stats
        .max_runtime_batch
        .fetch_max(event_count as usize, Ordering::Relaxed);
    if event_count > 0 {
        packed_events[0..4].copy_from_slice(&event_count.to_le_bytes());
        let batch = std::mem::replace(packed_events, vec![0; 4]);
        call_js_push_host_events(runtime, entrypoints, batch)?;
    }
    pump_js_event_loop_once(js_event_loop, runtime)?;

    let sample_metrics = last_metrics_log.elapsed() >= Duration::from_secs(5);
    let (update_result, outbound) =
        call_js_update_binary(js_event_loop, runtime, entrypoints, sample_metrics)?;
    let (pending_async, metrics, game_metrics) = if sample_metrics {
        let result: UpdateResult = serde_json::from_str(&update_result).with_context(|| {
            format!("TS update returned invalid metrics snapshot: {update_result}")
        })?;
        (result.pending_async, result.metrics, result.game)
    } else {
        (update_result == "1", Vec::new(), None)
    };
    if sample_metrics {
        maybe_log_metrics(
            process_name,
            &metrics,
            game_metrics.as_ref(),
            last_metrics_log,
            queue_stats,
            runtime,
            system,
            process_pid,
            gc_metrics,
            last_process_cpu_time_ms,
            last_resource_sample_at,
        );
    }
    flush_outbound(outbound, writers, queue_stats)?;
    Ok(pending_async)
}

fn maybe_log_metrics(
    process_name: &str,
    metrics: &[SceneMetricsSnapshot],
    game_metrics: Option<&GameMetricsSnapshot>,
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
        "[process-metrics] process={process_name} cpu_percent={cpu_percent:.2} cpu_time_ms={cpu_time_ms} rss_bytes={rss_bytes} v8_heap_used_bytes={} v8_heap_total_bytes={} v8_gc_count={} v8_gc_ms={:.3} timestamp_ms={timestamp_ms} inbound_frames={} host_completions={} disconnects={} runtime_updates={} runtime_events={} max_runtime_batch={} outbound_batches={} outbound_recipients={} outbound_bridge_bytes={} outbound_logical_bytes={}",
        heap.used_heap_size(),
        heap.total_heap_size(),
        gc_metrics.count,
        gc_metrics.total_duration.as_secs_f64() * 1000.0,
        queue_stats.inbound_frames.load(Ordering::Relaxed),
        queue_stats.host_completions.load(Ordering::Relaxed),
        queue_stats.disconnects.load(Ordering::Relaxed),
        queue_stats.runtime_updates.load(Ordering::Relaxed),
        queue_stats.runtime_events.load(Ordering::Relaxed),
        queue_stats.max_runtime_batch.load(Ordering::Relaxed),
        queue_stats.outbound_batches.load(Ordering::Relaxed),
        queue_stats.outbound_recipients.load(Ordering::Relaxed),
        queue_stats.outbound_bridge_bytes.load(Ordering::Relaxed),
        queue_stats.outbound_logical_bytes.load(Ordering::Relaxed),
    );
    if let Some(game) = game_metrics {
        println!(
            "[game-metrics] process={process_name} fixed_update_ms={} frame_count={} skipped_fixed_updates={} update_targets={} update_calls={} update_failures={} timers={}",
            game.fixed_update_ms,
            game.frame_count,
            game.skipped_fixed_updates,
            game.update_targets,
            game.update_calls,
            game.update_failures,
            game.timers,
        );
    }
    for metric in metrics {
        println!(
            "[metrics:{process_name}] scene={} type={} processed={} failed={} ts_queue={} ts_max_queue={} async_in_flight={} max_async_in_flight={} rust_queue={} rust_max_queue={} backpressure={} slow_disconnects={} update_ms={:.2} handler_ms={:.2} max_handler_ms={:.2} total_handler_ms={:.2}",
            metric.scene,
            metric.scene_type,
            metric.processed_frames,
            metric.failed_frames,
            metric.ingress_queue_length,
            metric.max_ingress_queue_length,
            metric.async_in_flight,
            metric.max_async_in_flight,
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
        for latency in &metric.latencies {
            println!(
                "[latency:{process_name}] scene={} type={} name={} msgcode={} count={} avg_ms={:.3} p50_ms={:.3} p95_ms={:.3} p99_ms={:.3} max_ms={:.3}",
                metric.scene,
                metric.scene_type,
                latency.name,
                latency
                    .msgcode
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "-".to_string()),
                latency.count,
                latency.avg_ms,
                latency.p50_ms,
                latency.p95_ms,
                latency.p99_ms,
                latency.max_ms,
            );
        }
    }
}

fn push_event(
    packed_events: &mut Vec<u8>,
    event_count: &mut u32,
    event: ProcessEvent,
    queue_stats: &ProcessQueueStats,
) -> Result<()> {
    match event {
        ProcessEvent::Frame {
            scene_index,
            connection_id,
            frame,
        } => {
            queue_stats.inbound_frames.fetch_add(1, Ordering::Relaxed);
            push_packed_event(packed_events, 1, connection_id, scene_index, &frame)?;
        }
        ProcessEvent::Disconnect {
            scene_index,
            connection_id,
        } => {
            queue_stats.disconnects.fetch_add(1, Ordering::Relaxed);
            push_packed_event(packed_events, 2, connection_id, scene_index, &[])?;
        }
        ProcessEvent::HostSceneCompletion(completion) => {
            queue_stats.host_completions.fetch_add(1, Ordering::Relaxed);
            let (event_type, payload) = match completion.result {
                Ok(frame) => (3, frame),
                Err(error) => (4, error.into_bytes()),
            };
            push_packed_event(
                packed_events,
                event_type,
                completion.operation_id as u64,
                0,
                &payload,
            )?;
        }
    }
    *event_count += 1;
    Ok(())
}

fn push_packed_event(
    packed_events: &mut Vec<u8>,
    event_type: u8,
    connection_id: u64,
    scene_index: u32,
    payload: &[u8],
) -> Result<()> {
    let connection_id = u32::try_from(connection_id).context("connection id exceeds uint32")?;
    let payload_len = u32::try_from(payload.len()).context("host event payload exceeds uint32")?;
    packed_events.reserve(EVENT_HEADER_BYTES + payload.len());
    packed_events.push(event_type);
    packed_events.extend_from_slice(&connection_id.to_le_bytes());
    packed_events.extend_from_slice(&scene_index.to_le_bytes());
    packed_events.extend_from_slice(&payload_len.to_le_bytes());
    packed_events.extend_from_slice(payload);
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
        let mut frames = Vec::<Bytes>::with_capacity(RAW_WRITE_BATCH_FRAME_CAPACITY);
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
            frames.clear();
            let mut queued_frame_bytes = frame.len();
            let mut packet_bytes = 4 + frame.len();
            frames.push(frame);
            while frames.len() < RAW_WRITE_BATCH_FRAME_CAPACITY
                && packet_bytes < RAW_WRITE_BATCH_BYTE_CAPACITY
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
                    if changed.is_err() || *writer_shutdown.borrow() {
                        break;
                    }
                    continue;
                }
                result = write_raw_frames_vectored(&mut writer, &frames) => result,
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
        let mut frames = Vec::<Bytes>::with_capacity(RAW_WRITE_BATCH_FRAME_CAPACITY);
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
            frames.clear();
            let mut frame_bytes = frame.len();
            frames.push(frame);
            while frames.len() < RAW_WRITE_BATCH_FRAME_CAPACITY
                && frame_bytes < RAW_WRITE_BATCH_BYTE_CAPACITY
            {
                let Ok(frame) = write_rx.try_recv() else {
                    break;
                };
                frame_bytes += frame.len();
                frames.push(frame);
            }
            let result = tokio::select! {
                changed = writer_shutdown.changed() => {
                    if changed.is_err() || *writer_shutdown.borrow() {
                        break;
                    }
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

    #[test]
    fn packs_host_events_with_payload_length() {
        let mut packed = vec![0; 4];
        push_packed_event(&mut packed, 1, 7, 3, &[10, 11]).unwrap();
        packed[0..4].copy_from_slice(&1_u32.to_le_bytes());

        assert_eq!(&packed[0..4], &1_u32.to_le_bytes());
        assert_eq!(packed[4], 1);
        assert_eq!(&packed[5..9], &7_u32.to_le_bytes());
        assert_eq!(&packed[9..13], &3_u32.to_le_bytes());
        assert_eq!(&packed[13..17], &2_u32.to_le_bytes());
        assert_eq!(&packed[17..], &[10, 11]);
    }

    #[test]
    fn parses_game_metrics_from_ts_update() {
        let result: UpdateResult = serde_json::from_str(
            r#"{
                "metrics": [],
                "game": {
                    "fixedUpdateMs": 50,
                    "frameCount": 123,
                    "skippedFixedUpdates": 2,
                    "updateTargets": 4,
                    "updateCalls": 492,
                    "updateFailures": 0,
                    "timers": 3
                },
                "pendingAsync": false
            }"#,
        )
        .unwrap();

        let game = result.game.unwrap();
        assert_eq!(game.fixed_update_ms, 50);
        assert_eq!(game.frame_count, 123);
        assert_eq!(game.skipped_fixed_updates, 2);
        assert_eq!(game.update_targets, 4);
        assert_eq!(game.update_calls, 492);
        assert_eq!(game.update_failures, 0);
        assert_eq!(game.timers, 3);
    }
}
