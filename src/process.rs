//! 协调有界宿主队列、单 V8 业务线程、端点、Update 与停机。 / Coordinates bounded host queues, one V8 business thread, endpoints, updates, and shutdown.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::ffi::c_void;
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use bytes::Bytes;
use serde::Deserialize;
use serde_json::json;
use sysinfo::{Pid, ProcessesToUpdate, System};
#[cfg(test)]
use tokio::sync::{mpsc as tokio_mpsc, watch};

use crate::config::{ProcessConfig, ProcessSchedulingMode, RuntimeConfig, SceneConfig};
use crate::health::{HealthServer, ProcessHealthState};
use crate::host::{
    BinaryOutboundBatch, HostSceneCompletion, call_js_push_host_events, call_js_start_process,
    call_js_stop_process, call_js_update_binary, configure_host_scene_bridge, create_runtime,
    load_js_entrypoints, pump_js_event_loop_once, take_close_connection_requests,
};
use crate::inspector::ProcessInspector;
use crate::transport::init_remote_transport;
use crate::transport_backend::{
    CONNECTION_OUTBOUND_BYTE_CAPACITY, ConnectionWriters, EndpointContext, create_io_backend,
};
#[cfg(test)]
use crate::transport_backend::{ConnectionKind, ConnectionWriter, validate_frame_access};

const DEFAULT_PROCESS_EVENT_QUEUE_CAPACITY: usize = 4096;
const EVENT_HEADER_BYTES: usize = 13;
const BACKPRESSURE_RETRY_MS: u64 = 1;

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

#[derive(Debug)]
pub(crate) enum ProcessEvent {
    Frame {
        scene_index: u32,
        connection_id: u64,
        frame: Bytes,
    },
    Disconnect {
        scene_index: u32,
        connection_id: u64,
    },
    HostSceneCompletion(HostSceneCompletion),
    Shutdown,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateResult {
    #[serde(default)]
    metrics: Vec<SceneMetricsSnapshot>,
    #[serde(default)]
    game: Option<GameMetricsSnapshot>,
    #[serde(default)]
    native_data: Option<NativeDataMetricsSnapshot>,
    #[serde(default)]
    pending_async: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeDataMetricsSnapshot {
    scalar_gets: u64,
    scalar_sets: u64,
    batch_calls: u64,
    live_entities: u32,
    live_units: u32,
    encoded_frames: u64,
    encoded_items: u64,
    encoded_bytes: u64,
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
    #[serde(default)]
    protocol_successes: u64,
    #[serde(default)]
    business_errors: u64,
    #[serde(default)]
    system_errors: u64,
    #[serde(default)]
    decode_errors: u64,
    #[serde(default)]
    handler_not_found: u64,
    #[serde(default)]
    message_handler_failures: u64,
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
    #[serde(default)]
    custom_metrics: Vec<CustomMetricSnapshot>,
}

#[derive(Debug, Deserialize)]
struct CustomMetricSnapshot {
    name: String,
    #[serde(default)]
    values: BTreeMap<String, f64>,
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

pub(crate) struct ProcessQueueStats {
    capacity: usize,
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
    transport_read_ops: AtomicU64,
    transport_read_frames: AtomicU64,
    transport_read_bytes: AtomicU64,
    transport_write_ops: AtomicU64,
    transport_write_frames: AtomicU64,
    transport_write_bytes: AtomicU64,
}

impl ProcessQueueStats {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            depth: AtomicUsize::default(),
            max_depth: AtomicUsize::default(),
            backpressure_waits: AtomicU64::default(),
            slow_client_disconnects: AtomicU64::default(),
            outbound_batches: AtomicU64::default(),
            outbound_recipients: AtomicU64::default(),
            outbound_bridge_bytes: AtomicU64::default(),
            outbound_logical_bytes: AtomicU64::default(),
            inbound_frames: AtomicU64::default(),
            host_completions: AtomicU64::default(),
            disconnects: AtomicU64::default(),
            runtime_updates: AtomicU64::default(),
            runtime_events: AtomicU64::default(),
            max_runtime_batch: AtomicUsize::default(),
            transport_read_ops: AtomicU64::default(),
            transport_read_frames: AtomicU64::default(),
            transport_read_bytes: AtomicU64::default(),
            transport_write_ops: AtomicU64::default(),
            transport_write_frames: AtomicU64::default(),
            transport_write_bytes: AtomicU64::default(),
        }
    }

    pub(crate) fn transport_read_completed(&self, frames: usize, bytes: usize) {
        self.transport_read_ops.fetch_add(1, Ordering::Relaxed);
        self.transport_read_frames
            .fetch_add(frames as u64, Ordering::Relaxed);
        self.transport_read_bytes
            .fetch_add(bytes as u64, Ordering::Relaxed);
    }

    pub(crate) fn transport_write_completed(&self, frames: usize, bytes: usize) {
        self.transport_write_ops.fetch_add(1, Ordering::Relaxed);
        self.transport_write_frames
            .fetch_add(frames as u64, Ordering::Relaxed);
        self.transport_write_bytes
            .fetch_add(bytes as u64, Ordering::Relaxed);
    }

    fn queued(&self) {
        let depth = self.depth.fetch_add(1, Ordering::Relaxed) + 1;
        self.max_depth
            .fetch_max(depth.min(self.capacity), Ordering::Relaxed);
    }

    fn dequeue(&self) {
        let _ = self
            .depth
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                Some(value.saturating_sub(1))
            });
    }
}

impl Default for ProcessQueueStats {
    fn default() -> Self {
        Self::new(DEFAULT_PROCESS_EVENT_QUEUE_CAPACITY)
    }
}

#[derive(Clone)]
pub(crate) struct ProcessEventSender {
    sender: mpsc::SyncSender<ProcessEvent>,
    stats: Arc<ProcessQueueStats>,
}

impl ProcessEventSender {
    pub(crate) async fn send(
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

/// 使用单 V8 业务线程和异步 I/O 宿主运行一个已配置进程。
///
/// 网络端点把事件写入由 V8 线程消费的有界队列。停机时先关闭连接，
/// 再发送 mailbox 事件执行 TS 生命周期，最后等待线程退出。
/// 除非已超过配置的宽限时间，调用方不可直接终止 OS 进程。
///
/// Runs one configured process with a single V8 business thread and asynchronous I/O host.
///
/// Network endpoints feed a bounded queue consumed by the V8 thread. Shutdown
/// first closes connections, then sends a mailbox event that executes TS
/// lifecycle hooks before the thread is joined. Callers must not terminate the
/// OS process to stop it unless the configured grace period has expired.
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

    tracing::info!(
        target: "tiangz::runtime",
        process = %config.process.name,
        scene_count = config.scenes.len(),
        config = %resolved_config.display(),
        "starting process with one V8"
    );

    let event_queue_capacity = config
        .process
        .scheduling
        .event_queue_capacity
        .unwrap_or(DEFAULT_PROCESS_EVENT_QUEUE_CAPACITY);
    let (event_tx, event_rx) = mpsc::sync_channel::<ProcessEvent>(event_queue_capacity);
    let queue_stats = Arc::new(ProcessQueueStats::new(event_queue_capacity));
    let writers: ConnectionWriters = Arc::new(Mutex::new(HashMap::new()));
    let event_tx = ProcessEventSender {
        sender: event_tx,
        stats: Arc::clone(&queue_stats),
    };
    let health_state = Arc::new(ProcessHealthState::starting());
    let health_server = match config
        .process
        .observability
        .as_ref()
        .and_then(|observability| observability.health.as_ref())
    {
        Some(health) => Some(
            HealthServer::start(
                health,
                config.process.name.clone(),
                Arc::clone(&health_state),
            )
            .await?,
        ),
        None => None,
    };
    let next_connection_id = Arc::new(AtomicU64::new(1));
    let completion_sender = event_tx.clone();
    let completion_sink: crate::host::HostSceneCompletionSink =
        Arc::new(move |completion| completion_sender.try_send_completion(completion));

    let io_backend = create_io_backend(&config.process.network)?;
    tracing::info!(
        target: "tiangz::transport",
        process = %config.process.name,
        io_backend = io_backend.name(),
        "process I/O backend selected"
    );
    for (scene_index, scene) in config.scenes.iter().cloned().enumerate() {
        io_backend.start_endpoint(EndpointContext {
            scene_index: scene_index as u32,
            scene,
            event_tx: event_tx.clone(),
            writers: Arc::clone(&writers),
            next_connection_id: Arc::clone(&next_connection_id),
            stats: Arc::clone(&queue_stats),
        })?;
    }
    health_state.mark_endpoints_ready();

    let process = config.process.clone();
    let scenes = config.scenes.clone();
    let known_scenes = config.known_scenes.clone();
    let runtime_writers = Arc::clone(&writers);
    let runtime_queue_stats = Arc::clone(&queue_stats);
    let runtime_health = Arc::clone(&health_state);
    let host_runtime = tokio::runtime::Handle::current();
    let (runtime_exit_tx, mut runtime_exit_rx) = tokio::sync::oneshot::channel();
    let runtime_thread = thread::spawn(move || {
        let result = run_process_runtime(
            process,
            scenes,
            known_scenes,
            app_code,
            app_module_url,
            event_rx,
            runtime_writers,
            runtime_queue_stats,
            host_runtime,
            completion_sink,
            Arc::clone(&runtime_health),
        );
        runtime_health.mark_runtime_stopped();
        let _ = runtime_exit_tx.send(());
        result
    });

    let runtime_exited_early = tokio::select! {
        result = wait_for_shutdown_signal() => {
            result?;
            false
        }
        _ = &mut runtime_exit_rx => true,
    };
    health_state.mark_stopping();
    shutdown_all_connections(&writers);
    let shutdown_send_error = if !runtime_exited_early {
        event_tx
            .send(ProcessEvent::Shutdown, None)
            .await
            .err()
            .map(anyhow::Error::msg)
    } else {
        None
    };
    let runtime_result = tokio::task::spawn_blocking(move || runtime_thread.join())
        .await
        .context("failed to join process runtime task")?
        .map_err(|_| anyhow::anyhow!("process runtime thread panicked"))?;
    if let Some(server) = health_server {
        server.stop().await;
    }
    if runtime_exited_early {
        runtime_result.context("V8 runtime failed before process shutdown was requested")?;
        bail!("V8 runtime exited unexpectedly before process shutdown was requested");
    }
    runtime_result?;
    if let Some(error) = shutdown_send_error {
        return Err(error).context("failed to deliver shutdown to V8 runtime");
    }
    Ok(())
}

async fn wait_for_shutdown_signal() -> Result<()> {
    #[cfg(windows)]
    {
        let mut ctrl_break =
            tokio::signal::windows::ctrl_break().context("failed to install CTRL_BREAK handler")?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result?,
            _ = ctrl_break.recv() => {},
            result = crate::shutdown::wait_for_parent_control() => result?,
        }
    }
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .context("failed to install SIGTERM handler")?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result?,
            _ = terminate.recv() => {},
            result = crate::shutdown::wait_for_parent_control() => result?,
        }
    }
    Ok(())
}

// These arguments are the explicit ownership handoff from async host to the
// single V8 thread; grouping them would hide rather than reduce coupling.
#[allow(clippy::too_many_arguments)]
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
    health_state: Arc<ProcessHealthState>,
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
        create_runtime(
            process.debug.is_some(),
            crate::logging::typescript_min_level(&process.logging),
        )
        .context("failed to create V8 runtime")?
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
    tracing::info!(target: "tiangz::typescript", process = %process_name, message = %start_result, "TypeScript process started");
    health_state.mark_runtime_ready();
    tracing::info!(target: "tiangz::runtime",
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
        let mut shutdown_requested = false;
        let wait_ms = scheduling.idle_tick_ms;
        match event_rx.recv_timeout(Duration::from_millis(wait_ms)) {
            Ok(ProcessEvent::Shutdown) => {
                queue_stats.dequeue();
                shutdown_requested = true;
            }
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
        while !shutdown_requested && event_count < batch_capacity as u32 {
            match event_rx.try_recv() {
                Ok(ProcessEvent::Shutdown) => {
                    queue_stats.dequeue();
                    shutdown_requested = true;
                    break;
                }
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
        if shutdown_requested {
            break;
        }
    }

    let stop_result = call_js_stop_process(&js_event_loop, &mut runtime, &entrypoints)
        .context("failed to stop TypeScript process")?;
    close_requested_connections(take_close_connection_requests(), &writers);
    tracing::info!(target: "tiangz::runtime", process = %process_name, message = %stop_result, "TypeScript process stopped");

    runtime
        .v8_isolate()
        .remove_gc_prologue_callback(v8_gc_prologue, gc_metrics_ptr);
    runtime
        .v8_isolate()
        .remove_gc_epilogue_callback(v8_gc_epilogue, gc_metrics_ptr);

    Ok(())
}

// The batch boundary deliberately receives all mutable interval state together
// so no global runtime state is introduced on this hot path.
#[allow(clippy::too_many_arguments)]
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
    let (pending_async, metrics, game_metrics, native_data_metrics) = if sample_metrics {
        let result: UpdateResult = serde_json::from_str(&update_result).with_context(|| {
            format!("TS update returned invalid metrics snapshot: {update_result}")
        })?;
        (
            result.pending_async,
            result.metrics,
            result.game,
            result.native_data,
        )
    } else {
        (update_result == "1", Vec::new(), None, None)
    };
    if sample_metrics {
        maybe_log_metrics(
            process_name,
            &metrics,
            game_metrics.as_ref(),
            native_data_metrics.as_ref(),
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
    close_requested_connections(take_close_connection_requests(), writers);
    Ok(pending_async)
}

fn close_requested_connections(mut connection_ids: Vec<u64>, writers: &ConnectionWriters) {
    if connection_ids.is_empty() {
        return;
    }
    connection_ids.sort_unstable();
    connection_ids.dedup();

    let mut writers = writers.lock().expect("connection writer map poisoned");
    for connection_id in connection_ids {
        if let Some(writer) = writers.remove(&connection_id) {
            let _ = writer.shutdown_tx.send(true);
        }
    }
}

fn shutdown_all_connections(writers: &ConnectionWriters) {
    let mut writers = writers.lock().expect("connection writer map poisoned");
    for (_, writer) in writers.drain() {
        let _ = writer.shutdown_tx.send(true);
    }
}

// Metrics are sampled from independent owners; a parameter object would be an
// allocation-oriented facade with no stronger invariant.
#[allow(clippy::too_many_arguments)]
fn maybe_log_metrics(
    process_name: &str,
    metrics: &[SceneMetricsSnapshot],
    game_metrics: Option<&GameMetricsSnapshot>,
    native_data_metrics: Option<&NativeDataMetricsSnapshot>,
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
    tracing::info!(target: "tiangz::metrics",
        "[process-metrics] process={process_name} cpu_percent={cpu_percent:.2} cpu_time_ms={cpu_time_ms} rss_bytes={rss_bytes} v8_heap_used_bytes={} v8_heap_total_bytes={} v8_gc_count={} v8_gc_ms={:.3} timestamp_ms={timestamp_ms} dropped_logs={} inbound_frames={} host_completions={} disconnects={} runtime_updates={} runtime_events={} max_runtime_batch={} outbound_batches={} outbound_recipients={} outbound_bridge_bytes={} outbound_logical_bytes={} transport_read_ops={} transport_read_frames={} transport_read_bytes={} transport_write_ops={} transport_write_frames={} transport_write_bytes={}",
        heap.used_heap_size(),
        heap.total_heap_size(),
        gc_metrics.count,
        gc_metrics.total_duration.as_secs_f64() * 1000.0,
        crate::logging::dropped_lines(),
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
        queue_stats.transport_read_ops.load(Ordering::Relaxed),
        queue_stats.transport_read_frames.load(Ordering::Relaxed),
        queue_stats.transport_read_bytes.load(Ordering::Relaxed),
        queue_stats.transport_write_ops.load(Ordering::Relaxed),
        queue_stats.transport_write_frames.load(Ordering::Relaxed),
        queue_stats.transport_write_bytes.load(Ordering::Relaxed),
    );
    if let Some(game) = game_metrics {
        tracing::info!(target: "tiangz::metrics",
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
    if let Some(native) = native_data_metrics {
        tracing::info!(target: "tiangz::metrics",
            "[native-data-metrics] process={process_name} scalar_gets={} scalar_sets={} batch_calls={} live_entities={} live_units={} encoded_frames={} encoded_items={} encoded_bytes={}",
            native.scalar_gets,
            native.scalar_sets,
            native.batch_calls,
            native.live_entities,
            native.live_units,
            native.encoded_frames,
            native.encoded_items,
            native.encoded_bytes,
        );
    }
    for metric in metrics {
        tracing::info!(target: "tiangz::metrics",
            "[metrics:{process_name}] scene={} type={} processed={} failed={} protocol_successes={} business_errors={} system_errors={} decode_errors={} handler_not_found={} message_handler_failures={} ts_queue={} ts_max_queue={} async_in_flight={} max_async_in_flight={} rust_queue={} rust_max_queue={} backpressure={} slow_disconnects={} update_ms={:.2} handler_ms={:.2} max_handler_ms={:.2} total_handler_ms={:.2}",
            metric.scene,
            metric.scene_type,
            metric.processed_frames,
            metric.failed_frames,
            metric.protocol_successes,
            metric.business_errors,
            metric.system_errors,
            metric.decode_errors,
            metric.handler_not_found,
            metric.message_handler_failures,
            metric.ingress_queue_length,
            metric.max_ingress_queue_length,
            metric.async_in_flight,
            metric.max_async_in_flight,
            queue_stats
                .depth
                .load(Ordering::Relaxed)
                .min(queue_stats.capacity),
            queue_stats.max_depth.load(Ordering::Relaxed),
            queue_stats.backpressure_waits.load(Ordering::Relaxed),
            queue_stats.slow_client_disconnects.load(Ordering::Relaxed),
            metric.last_update_cost_ms,
            metric.last_handler_cost_ms,
            metric.max_handler_cost_ms,
            metric.total_handler_cost_ms,
        );
        for latency in &metric.latencies {
            tracing::info!(target: "tiangz::latency",
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
        for custom in &metric.custom_metrics {
            let values = custom
                .values
                .iter()
                .map(|(name, value)| format!("{name}={value}"))
                .collect::<Vec<_>>()
                .join(" ");
            tracing::info!(target: "tiangz::metrics",
                "[custom-metrics:{process_name}] scene={} type={} name={} timestamp_ms={} {}",
                metric.scene, metric.scene_type, custom.name, timestamp_ms, values,
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
        ProcessEvent::Shutdown => bail!("shutdown event cannot enter a host event batch"),
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
            tracing::warn!(
                target: "tiangz::transport",
                connection_id,
                "closing slow connection: outbound queue limit exceeded"
            );
        }
    }
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
    fn requested_connection_is_removed_and_signaled() {
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

        close_requested_connections(vec![7, 7, 999], &writers);

        assert!(!writers.lock().unwrap().contains_key(&7));
        assert!(*shutdown_rx.borrow());
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

    #[test]
    fn parses_custom_scene_metrics_from_ts_update() {
        let result: UpdateResult = serde_json::from_str(
            r#"{
                "metrics": [{
                    "scene": "map_1",
                    "sceneType": "MapHost",
                    "processedFrames": 1,
                    "failedFrames": 0,
                    "ingressQueueLength": 0,
                    "maxIngressQueueLength": 1,
                    "lastUpdateCostMs": 0.1,
                    "lastHandlerCostMs": 0.1,
                    "maxHandlerCostMs": 0.1,
                    "totalHandlerCostMs": 0.1,
                    "asyncInFlight": 0,
                    "maxAsyncInFlight": 1,
                    "latencies": [],
                    "customMetrics": [{
                        "name": "map_broadcast",
                        "values": {
                            "in_flight": 1,
                            "pending_units": 12,
                            "coalesced_frames_total": 34
                        }
                    }]
                }],
                "pendingAsync": false
            }"#,
        )
        .expect("custom scene metrics must deserialize");

        let custom = &result.metrics[0].custom_metrics[0];
        assert_eq!(custom.name, "map_broadcast");
        assert_eq!(custom.values.get("in_flight"), Some(&1.0));
        assert_eq!(custom.values.get("pending_units"), Some(&12.0));
        assert_eq!(custom.values.get("coalesced_frames_total"), Some(&34.0));
    }
}
