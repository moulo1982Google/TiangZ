//! 协调有界宿主队列、单 V8 业务线程、端点、Update 与停机。 / Coordinates bounded host queues, one V8 business thread, endpoints, updates, and shutdown.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sysinfo::{Pid, ProcessesToUpdate, System};
#[cfg(test)]
use tokio::sync::{mpsc as tokio_mpsc, watch};

use crate::config::{ProcessConfig, ProcessSchedulingMode, RuntimeConfig, SceneConfig};
use crate::game_config::GameConfigBundle;
use crate::health::{
    GameObservabilitySnapshot, HealthServer, LatencyObservabilitySnapshot,
    MailboxObservabilitySnapshot, NativeDataObservabilitySnapshot, ProcessHealthState,
    ProcessObservabilitySnapshot, ProcessQueueStageObservabilitySnapshot, SceneCustomMetricKind,
    SceneCustomMetricSnapshot, SceneObservabilitySnapshot,
    TransportDiagnosticObservabilitySnapshot, TransportOverloadStageObservabilitySnapshot,
};
use crate::host::{
    BinaryOutboundBatch, HostSceneCompletion, call_js_install_game_config,
    call_js_push_host_events, call_js_start_process, call_js_stop_process, call_js_update_binary,
    configure_host_scene_bridge, create_runtime, pump_js_event_loop_once,
    take_close_connection_requests,
};
use crate::hotfix::{HotfixInstallResult, RuntimeBundles};
use crate::inspector::ProcessInspector;
use crate::shutdown::{
    ParentControlCommand, receive_parent_control, spawn_parent_control_receiver,
};
use crate::transport::{init_remote_transport, snapshot_remote_transport};
#[cfg(test)]
use crate::transport_backend::{
    CONNECTION_OUTBOUND_BYTE_CAPACITY, ConnectionKind, ConnectionWriter, validate_frame_access,
};
use crate::transport_backend::{
    ConnectionWriteBatch, ConnectionWriters, EndpointContext, WRITE_BATCH_BYTE_CAPACITY,
    WRITE_BATCH_FRAME_CAPACITY, create_io_backend, try_queue_connection_batch,
    try_queue_connection_frame,
};

const DEFAULT_PROCESS_EVENT_QUEUE_CAPACITY: usize = 4096;
const PROCESS_CONTROL_QUEUE_DIVISOR: usize = 4;
const MAX_CONSECUTIVE_CONTROL_EVENTS: usize = 32;
const MAX_PENDING_INGRESS_CONTROL_EVENTS: usize = 128;
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

/// 进程入口的物理调度类别；它只决定保留容量和取队公平性，不改变Scene/Actor业务语义。
/// Physical process-ingress scheduling class. It controls reserved capacity and dequeue fairness,
/// but does not change Scene or Actor business semantics.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProcessIngressClass {
    Control,
    Data,
}

impl ProcessIngressClass {
    const ALL: [Self; 2] = [Self::Control, Self::Data];

    fn name(self) -> &'static str {
        match self {
            Self::Control => "control_ingress",
            Self::Data => "data_ingress",
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum ProcessEventKind {
    Frame,
    Completion,
    Disconnect,
    Shutdown,
}

impl ProcessEventKind {
    const ALL: [Self; 4] = [
        Self::Frame,
        Self::Completion,
        Self::Disconnect,
        Self::Shutdown,
    ];

    fn name(self) -> &'static str {
        match self {
            Self::Frame => "frame",
            Self::Completion => "completion",
            Self::Disconnect => "disconnect",
            Self::Shutdown => "shutdown",
        }
    }
}

impl ProcessEvent {
    fn kind(&self) -> ProcessEventKind {
        match self {
            Self::Frame { .. } => ProcessEventKind::Frame,
            Self::HostSceneCompletion(_) => ProcessEventKind::Completion,
            Self::Disconnect { .. } => ProcessEventKind::Disconnect,
            Self::Shutdown => ProcessEventKind::Shutdown,
        }
    }

    fn ingress_class(&self) -> ProcessIngressClass {
        match self {
            Self::Frame { frame, .. } if crate::transport::inner_frame_rpc_id(frame).is_none() => {
                ProcessIngressClass::Data
            }
            Self::Frame { .. }
            | Self::Disconnect { .. }
            | Self::HostSceneCompletion(_)
            | Self::Shutdown => ProcessIngressClass::Control,
        }
    }
}

pub(crate) enum RuntimeControl {
    ReloadHotfix {
        candidate_directory: PathBuf,
        requested_at: Instant,
        response: tokio::sync::oneshot::Sender<std::result::Result<HotfixReloadReport, String>>,
    },
    ReloadGameConfig {
        candidate: Box<GameConfigBundle>,
        requested_at: Instant,
        response: tokio::sync::oneshot::Sender<std::result::Result<GameConfigReloadReport, String>>,
    },
}

/// Hotfix 控制面返回的分段结果，同时作为结构化日志与性能测试的稳定字段。 / Segmented Hotfix control result used by structured logs and performance tests.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HotfixReloadReport {
    pub(crate) candidate_directory: String,
    pub(crate) bundle_version: String,
    pub(crate) generation: u64,
    pub(crate) validation_ms: f64,
    pub(crate) preflight_ms: f64,
    pub(crate) barrier_wait_ms: f64,
    pub(crate) begin_ms: f64,
    pub(crate) candidate_eval_ms: f64,
    pub(crate) commit_ms: f64,
    pub(crate) reload_total_ms: f64,
    pub(crate) status_json: String,
}

/// 配置数据控制面结果；schema不变时只替换Snapshot，不改变Model或Hotfix generation。 / Config-data control result; a schema-compatible swap changes only the snapshot, not Model or Hotfix generation.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GameConfigReloadReport {
    candidate_directory: String,
    data_fingerprint: String,
    commit_ms: f64,
    reload_total_ms: f64,
    status_json: String,
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
    actor_mailbox: MailboxMetricsSnapshot,
    #[serde(default)]
    pending_async: bool,
    #[serde(default)]
    pending_ingress: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeDataMetricsSnapshot {
    scalar_gets: u64,
    scalar_sets: u64,
    batch_calls: u64,
    live_entities: u32,
    live_units: u32,
    #[serde(default)]
    live_items: u32,
    #[serde(default)]
    pool_capacity_bytes: u64,
    #[serde(default)]
    scratch_capacity_bytes: u64,
    #[serde(default)]
    scratch_growths: u64,
    #[serde(default)]
    native_refs: BTreeMap<String, u64>,
    encoded_frames: u64,
    encoded_items: u64,
    encoded_bytes: u64,
    #[serde(default)]
    aoi_worlds: u32,
    #[serde(default)]
    aoi_entries: u32,
    #[serde(default)]
    aoi_grids: u32,
    #[serde(default)]
    aoi_candidate_relations: u64,
    #[serde(default)]
    aoi_visible_relations: u64,
    #[serde(default)]
    aoi_lingering_relations: u64,
    #[serde(default)]
    aoi_rejected_relations: u64,
    #[serde(default)]
    aoi_relocations: u64,
    #[serde(default)]
    aoi_visibility_changes: u64,
    #[serde(default)]
    aoi_filter_overrides: u64,
    #[serde(default)]
    navigation_assets: u32,
    #[serde(default)]
    navigation_worlds: u32,
    #[serde(default)]
    numeric_replication: Vec<NativeNumericReplicationMetricsSnapshot>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeNumericReplicationMetricsSnapshot {
    numeric_type: u32,
    changes: u64,
    encoded_records: u64,
    recipient_deliveries: u64,
    logical_bytes: u64,
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
    #[serde(default)]
    coroutine_lock_waiters: usize,
    #[serde(default)]
    coroutine_lock_timeouts: u64,
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
    #[serde(default)]
    last_ingress_pump_frames: u64,
    #[serde(default)]
    last_ingress_pump_cost_ms: f64,
    last_update_cost_ms: f64,
    last_handler_cost_ms: f64,
    max_handler_cost_ms: f64,
    total_handler_cost_ms: f64,
    #[serde(default)]
    async_in_flight: usize,
    #[serde(default)]
    max_async_in_flight: usize,
    #[serde(default)]
    mailbox: MailboxMetricsSnapshot,
    #[serde(default)]
    latencies: Vec<LatencyMetricSnapshot>,
    #[serde(default)]
    custom_metrics: Vec<CustomMetricSnapshot>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MailboxMetricsSnapshot {
    #[serde(default)]
    fast_path_calls: u64,
    #[serde(default)]
    queued_calls: u64,
    #[serde(default)]
    async_calls: u64,
    #[serde(default)]
    one_way_fast_path_calls: u64,
    #[serde(default)]
    one_way_queued_calls: u64,
    #[serde(default)]
    one_way_async_calls: u64,
    #[serde(default)]
    queued_depth: u64,
    #[serde(default)]
    max_queued_depth: u64,
}

#[derive(Debug, Deserialize)]
struct CustomMetricSnapshot {
    name: String,
    #[serde(default)]
    values: BTreeMap<String, f64>,
    #[serde(default)]
    kinds: BTreeMap<String, CustomMetricKind>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum CustomMetricKind {
    Counter,
    #[default]
    Gauge,
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
    sum_ms: f64,
    bounds_ms: Vec<f64>,
    bucket_counts: Vec<u64>,
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
    frame: ProcessQueueStageStats,
    completion: ProcessQueueStageStats,
    disconnect: ProcessQueueStageStats,
    shutdown: ProcessQueueStageStats,
    control_ingress: ProcessQueueStageStats,
    data_ingress: ProcessQueueStageStats,
}

#[derive(Default)]
struct ProcessQueueStageStats {
    depth: AtomicUsize,
    max_depth: AtomicUsize,
    backpressure_waits: AtomicU64,
    backpressure_wait_ns: AtomicU64,
    max_backpressure_wait_ns: AtomicU64,
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
            frame: ProcessQueueStageStats::default(),
            completion: ProcessQueueStageStats::default(),
            disconnect: ProcessQueueStageStats::default(),
            shutdown: ProcessQueueStageStats::default(),
            control_ingress: ProcessQueueStageStats::default(),
            data_ingress: ProcessQueueStageStats::default(),
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

    fn stage(&self, kind: ProcessEventKind) -> &ProcessQueueStageStats {
        match kind {
            ProcessEventKind::Frame => &self.frame,
            ProcessEventKind::Completion => &self.completion,
            ProcessEventKind::Disconnect => &self.disconnect,
            ProcessEventKind::Shutdown => &self.shutdown,
        }
    }

    fn ingress_stage(&self, class: ProcessIngressClass) -> &ProcessQueueStageStats {
        match class {
            ProcessIngressClass::Control => &self.control_ingress,
            ProcessIngressClass::Data => &self.data_ingress,
        }
    }

    fn queued(&self, kind: ProcessEventKind, class: ProcessIngressClass) {
        let depth = self.depth.fetch_add(1, Ordering::Relaxed) + 1;
        self.max_depth
            .fetch_max(depth.min(self.capacity), Ordering::Relaxed);
        let stage = self.stage(kind);
        let stage_depth = stage.depth.fetch_add(1, Ordering::Relaxed) + 1;
        stage
            .max_depth
            .fetch_max(stage_depth.min(self.capacity), Ordering::Relaxed);
        let ingress_stage = self.ingress_stage(class);
        let ingress_depth = ingress_stage.depth.fetch_add(1, Ordering::Relaxed) + 1;
        ingress_stage
            .max_depth
            .fetch_max(ingress_depth.min(self.capacity), Ordering::Relaxed);
    }

    fn dequeue(&self, kind: ProcessEventKind, class: ProcessIngressClass) {
        let _ = self
            .depth
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                Some(value.saturating_sub(1))
            });
        let _ =
            self.stage(kind)
                .depth
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                    Some(value.saturating_sub(1))
                });
        let _ = self.ingress_stage(class).depth.fetch_update(
            Ordering::Relaxed,
            Ordering::Relaxed,
            |value| Some(value.saturating_sub(1)),
        );
    }

    fn record_backpressure(&self, kind: ProcessEventKind, class: ProcessIngressClass) {
        self.backpressure_waits.fetch_add(1, Ordering::Relaxed);
        self.stage(kind)
            .backpressure_waits
            .fetch_add(1, Ordering::Relaxed);
        self.ingress_stage(class)
            .backpressure_waits
            .fetch_add(1, Ordering::Relaxed);
    }

    fn record_backpressure_wait(
        &self,
        kind: ProcessEventKind,
        class: ProcessIngressClass,
        duration: Duration,
    ) {
        let nanos = duration.as_nanos().min(u128::from(u64::MAX)) as u64;
        let stage = self.stage(kind);
        stage
            .backpressure_wait_ns
            .fetch_add(nanos, Ordering::Relaxed);
        stage
            .max_backpressure_wait_ns
            .fetch_max(nanos, Ordering::Relaxed);
        let ingress_stage = self.ingress_stage(class);
        ingress_stage
            .backpressure_wait_ns
            .fetch_add(nanos, Ordering::Relaxed);
        ingress_stage
            .max_backpressure_wait_ns
            .fetch_max(nanos, Ordering::Relaxed);
    }
}

impl Default for ProcessQueueStats {
    fn default() -> Self {
        Self::new(DEFAULT_PROCESS_EVENT_QUEUE_CAPACITY)
    }
}

#[derive(Clone)]
pub(crate) struct ProcessEventSender {
    control_sender: mpsc::SyncSender<ProcessEvent>,
    data_sender: mpsc::SyncSender<ProcessEvent>,
    wake_sender: mpsc::SyncSender<()>,
    stats: Arc<ProcessQueueStats>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProcessIngressTrySendError {
    Overloaded,
    Stopped,
}

struct ProcessEventReceiver {
    control_receiver: mpsc::Receiver<ProcessEvent>,
    data_receiver: mpsc::Receiver<ProcessEvent>,
    wake_receiver: mpsc::Receiver<()>,
    consecutive_control: usize,
}

impl ProcessEventReceiver {
    fn try_recv_control(&mut self) -> std::result::Result<ProcessEvent, mpsc::TryRecvError> {
        match self.control_receiver.try_recv() {
            Ok(event) => {
                self.consecutive_control = self.consecutive_control.saturating_add(1);
                Ok(event)
            }
            Err(error) => Err(error),
        }
    }

    fn try_recv(&mut self) -> std::result::Result<ProcessEvent, mpsc::TryRecvError> {
        let force_data = self.consecutive_control >= MAX_CONSECUTIVE_CONTROL_EVENTS;
        if force_data {
            match self.data_receiver.try_recv() {
                Ok(event) => {
                    self.consecutive_control = 0;
                    return Ok(event);
                }
                Err(mpsc::TryRecvError::Disconnected) | Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        match self.control_receiver.try_recv() {
            Ok(event) => {
                self.consecutive_control = self.consecutive_control.saturating_add(1);
                return Ok(event);
            }
            Err(mpsc::TryRecvError::Disconnected) | Err(mpsc::TryRecvError::Empty) => {}
        }
        match self.data_receiver.try_recv() {
            Ok(event) => {
                self.consecutive_control = 0;
                Ok(event)
            }
            Err(mpsc::TryRecvError::Empty) => Err(mpsc::TryRecvError::Empty),
            Err(mpsc::TryRecvError::Disconnected) => match self.control_receiver.try_recv() {
                Ok(event) => {
                    self.consecutive_control = self.consecutive_control.saturating_add(1);
                    Ok(event)
                }
                Err(mpsc::TryRecvError::Empty) => Err(mpsc::TryRecvError::Empty),
                Err(mpsc::TryRecvError::Disconnected) => Err(mpsc::TryRecvError::Disconnected),
            },
        }
    }

    fn recv_timeout(
        &mut self,
        timeout: Duration,
    ) -> std::result::Result<ProcessEvent, mpsc::RecvTimeoutError> {
        let deadline = Instant::now() + timeout;
        loop {
            match self.try_recv() {
                Ok(event) => return Ok(event),
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Err(mpsc::RecvTimeoutError::Disconnected);
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return Err(mpsc::RecvTimeoutError::Timeout);
            };
            match self.wake_receiver.recv_timeout(remaining) {
                Ok(()) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    return Err(mpsc::RecvTimeoutError::Timeout);
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(mpsc::RecvTimeoutError::Disconnected);
                }
            }
        }
    }
}

impl ProcessEventSender {
    /// 内部RPC使用控制流保留队列并在队满时立即失败，调用方必须把明确错误回复给来源进程。
    /// Inner RPC uses the reserved control queue and fails immediately when full. The caller must
    /// return an explicit error to the source process instead of occupying a pending RPC waiter.
    pub(crate) fn try_send_control(
        &self,
        event: ProcessEvent,
    ) -> std::result::Result<(), ProcessIngressTrySendError> {
        debug_assert_eq!(event.ingress_class(), ProcessIngressClass::Control);
        let kind = event.kind();
        let class = ProcessIngressClass::Control;
        self.stats.queued(kind, class);
        match self.control_sender.try_send(event) {
            Ok(()) => {
                let _ = self.wake_sender.try_send(());
                Ok(())
            }
            Err(mpsc::TrySendError::Full(_)) => {
                self.stats.dequeue(kind, class);
                self.stats.record_backpressure(kind, class);
                Err(ProcessIngressTrySendError::Overloaded)
            }
            Err(mpsc::TrySendError::Disconnected(_)) => {
                self.stats.dequeue(kind, class);
                Err(ProcessIngressTrySendError::Stopped)
            }
        }
    }

    pub(crate) async fn send(
        &self,
        mut event: ProcessEvent,
        deadline: Option<tokio::time::Instant>,
    ) -> Result<(), String> {
        let kind = event.kind();
        let class = event.ingress_class();
        let mut counted_backpressure = false;
        let mut backpressure_started: Option<Instant> = None;
        loop {
            self.stats.queued(kind, class);
            let sender = match class {
                ProcessIngressClass::Control => &self.control_sender,
                ProcessIngressClass::Data => &self.data_sender,
            };
            match sender.try_send(event) {
                Ok(()) => {
                    if let Some(started) = backpressure_started {
                        self.stats
                            .record_backpressure_wait(kind, class, started.elapsed());
                    }
                    let _ = self.wake_sender.try_send(());
                    return Ok(());
                }
                Err(mpsc::TrySendError::Full(returned)) => {
                    self.stats.dequeue(kind, class);
                    event = returned;
                    if !counted_backpressure {
                        self.stats.record_backpressure(kind, class);
                        backpressure_started = Some(Instant::now());
                        counted_backpressure = true;
                    }
                    if deadline.is_some_and(|deadline| deadline <= tokio::time::Instant::now()) {
                        if let Some(started) = backpressure_started {
                            self.stats
                                .record_backpressure_wait(kind, class, started.elapsed());
                        }
                        return Err("process ingress queue is overloaded".to_string());
                    }
                    tokio::time::sleep(Duration::from_millis(BACKPRESSURE_RETRY_MS)).await;
                }
                Err(mpsc::TrySendError::Disconnected(_)) => {
                    self.stats.dequeue(kind, class);
                    if let Some(started) = backpressure_started {
                        self.stats
                            .record_backpressure_wait(kind, class, started.elapsed());
                    }
                    return Err("process event queue is stopped".to_string());
                }
            }
        }
    }

    fn try_send_completion(
        &self,
        completion: HostSceneCompletion,
    ) -> std::result::Result<(), HostSceneCompletion> {
        let class = ProcessIngressClass::Control;
        self.stats
            .queued(ProcessEventKind::Completion, ProcessIngressClass::Control);
        match self
            .control_sender
            .try_send(ProcessEvent::HostSceneCompletion(completion))
        {
            Ok(()) => {
                let _ = self.wake_sender.try_send(());
                Ok(())
            }
            Err(mpsc::TrySendError::Full(ProcessEvent::HostSceneCompletion(completion))) => {
                self.stats.dequeue(ProcessEventKind::Completion, class);
                self.stats
                    .record_backpressure(ProcessEventKind::Completion, class);
                Err(completion)
            }
            Err(mpsc::TrySendError::Disconnected(_)) => {
                self.stats.dequeue(ProcessEventKind::Completion, class);
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
    let runtime_bundles = RuntimeBundles::load(root)?;
    let game_config_schema_fingerprint =
        runtime_bundles.game_config_schema_fingerprint().to_string();
    let initial_game_config = GameConfigBundle::load(&root.join("dist/game-config"))?;
    initial_game_config.verify_schema(&game_config_schema_fingerprint)?;

    tracing::info!(
        target: "tiangz::runtime",
        version = crate::version::current(),
        hotfix = runtime_bundles.bundle_version(),
        game_config = initial_game_config.data_fingerprint(),
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
    if event_queue_capacity < 2 {
        bail!("process scheduling.eventQueueCapacity must be at least 2");
    }
    let control_queue_capacity = (event_queue_capacity / PROCESS_CONTROL_QUEUE_DIVISOR).max(1);
    let data_queue_capacity = event_queue_capacity - control_queue_capacity;
    let (control_tx, control_rx) = mpsc::sync_channel::<ProcessEvent>(control_queue_capacity);
    let (data_tx, data_rx) = mpsc::sync_channel::<ProcessEvent>(data_queue_capacity);
    let (wake_tx, wake_rx) = mpsc::sync_channel::<()>(1);
    let (runtime_control_tx, runtime_control_rx) = mpsc::channel::<RuntimeControl>();
    let queue_stats = Arc::new(ProcessQueueStats::new(event_queue_capacity));
    let writers: ConnectionWriters = Arc::new(Mutex::new(HashMap::new()));
    let event_tx = ProcessEventSender {
        control_sender: control_tx,
        data_sender: data_tx,
        wake_sender: wake_tx,
        stats: Arc::clone(&queue_stats),
    };
    let event_rx = ProcessEventReceiver {
        control_receiver: control_rx,
        data_receiver: data_rx,
        wake_receiver: wake_rx,
        consecutive_control: 0,
    };
    let runtime_stale_after = config
        .process
        .observability
        .as_ref()
        .and_then(|observability| observability.health.as_ref())
        .map(|health| Duration::from_millis(health.stale_after_ms.max(1)))
        .unwrap_or_else(|| Duration::from_secs(15));
    let health_state = Arc::new(ProcessHealthState::starting(runtime_stale_after));
    let health_server = match config
        .process
        .observability
        .as_ref()
        .and_then(|observability| observability.health.as_ref())
    {
        Some(health) => Some(
            HealthServer::start(
                health,
                config.process.lifecycle.hotfix_operations.as_ref(),
                config.process.lifecycle.hotfix_reload_timeout_ms,
                config.process.name.clone(),
                Arc::clone(&health_state),
                runtime_control_tx.clone(),
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
    let project_root = root.to_path_buf();
    let scenes = config.scenes.clone();
    let known_scenes = config.known_scenes.clone();
    let runtime_writers = Arc::clone(&writers);
    let runtime_queue_stats = Arc::clone(&queue_stats);
    let runtime_health = Arc::clone(&health_state);
    let host_runtime = tokio::runtime::Handle::current();
    let (runtime_exit_tx, mut runtime_exit_rx) = tokio::sync::oneshot::channel();
    let runtime_thread = thread::spawn(move || {
        let result = run_process_runtime(
            project_root,
            process,
            scenes,
            known_scenes,
            runtime_bundles,
            initial_game_config,
            event_rx,
            runtime_control_rx,
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

    let mut parent_control = spawn_parent_control_receiver();
    let shutdown_signal = wait_for_shutdown_signal();
    tokio::pin!(shutdown_signal);
    let runtime_exited_early = loop {
        tokio::select! {
            result = &mut shutdown_signal => {
                result?;
                break false;
            }
            _ = &mut runtime_exit_rx => break true,
            command = receive_parent_control(&mut parent_control) => {
                match command? {
                    ParentControlCommand::Shutdown => break false,
                    ParentControlCommand::Reload(candidate_directory) => {
                        let candidate_directory = if candidate_directory.is_absolute() {
                            candidate_directory
                        } else {
                            root.join(candidate_directory)
                        };
                        let (response, completed) = tokio::sync::oneshot::channel();
                        runtime_control_tx
                            .send(RuntimeControl::ReloadHotfix {
                                candidate_directory,
                                requested_at: Instant::now(),
                                response,
                            })
                            .map_err(|_| anyhow::anyhow!("V8 runtime control channel is stopped"))?;
                        tokio::spawn(async move {
                            match completed.await {
                                Ok(Ok(report)) => tracing::info!(
                                    target: "tiangz::hotfix",
                                    report = %serde_json::to_string(&report).unwrap_or_else(|_| "{}".to_string()),
                                    "Hotfix reload completed"
                                ),
                                Ok(Err(error)) => tracing::error!(target: "tiangz::hotfix", %error, "Hotfix reload rejected; active generation preserved"),
                                Err(_) => tracing::warn!(target: "tiangz::hotfix", "Hotfix reload response was dropped during shutdown"),
                            }
                        });
                    }
                    ParentControlCommand::ReloadConfig(candidate_directory) => {
                        let candidate_directory = if candidate_directory.is_absolute() {
                            candidate_directory
                        } else {
                            root.join(candidate_directory)
                        };
                        let requested_at = Instant::now();
                        match GameConfigBundle::load(&candidate_directory)
                            .and_then(|candidate| {
                                candidate.verify_schema(&game_config_schema_fingerprint)?;
                                Ok(candidate)
                            })
                        {
                            Ok(candidate) => {
                                let (response, completed) = tokio::sync::oneshot::channel();
                                runtime_control_tx
                                    .send(RuntimeControl::ReloadGameConfig {
                                        candidate: Box::new(candidate),
                                        requested_at,
                                        response,
                                    })
                                    .map_err(|_| anyhow::anyhow!("V8 runtime control channel is stopped"))?;
                                tokio::spawn(async move {
                                    match completed.await {
                                        Ok(Ok(report)) => tracing::info!(
                                            target: "tiangz::game_config",
                                            report = %serde_json::to_string(&report).unwrap_or_else(|_| "{}".to_string()),
                                            "game config reload completed"
                                        ),
                                        Ok(Err(error)) => tracing::error!(target: "tiangz::game_config", %error, "game config reload rejected; active snapshot preserved"),
                                        Err(_) => tracing::warn!(target: "tiangz::game_config", "game config reload response was dropped during shutdown"),
                                    }
                                });
                            }
                            Err(error) => {
                                health_state.record_game_config_failure();
                                tracing::error!(
                                    target: "tiangz::game_config",
                                    error = %format!("{error:#}"),
                                    candidate = %candidate_directory.display(),
                                    "game config candidate validation failed; active snapshot preserved"
                                );
                            }
                        }
                    }
                }
            }
        }
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
        }
    }
    Ok(())
}

// These arguments are the explicit ownership handoff from async host to the
// single V8 thread; grouping them would hide rather than reduce coupling.
#[allow(clippy::too_many_arguments)]
fn run_process_runtime(
    project_root: PathBuf,
    process: ProcessConfig,
    scenes: Vec<SceneConfig>,
    known_scenes: Vec<SceneConfig>,
    runtime_bundles: RuntimeBundles,
    initial_game_config: GameConfigBundle,
    mut event_rx: ProcessEventReceiver,
    runtime_control_rx: mpsc::Receiver<RuntimeControl>,
    writers: ConnectionWriters,
    queue_stats: Arc<ProcessQueueStats>,
    host_runtime: tokio::runtime::Handle,
    completion_sink: crate::host::HostSceneCompletionSink,
    health_state: Arc<ProcessHealthState>,
) -> Result<()> {
    crate::native_data::configure_project_root(&project_root)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let process_name = process.name.clone();
    let scheduling = RuntimeScheduling::from_process(&process);
    let js_event_loop = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("failed to create JS event loop runtime")?;
    configure_host_scene_bridge(host_runtime.clone(), completion_sink);
    crate::dbproxy::configure(&process, host_runtime)?;
    js_event_loop
        .block_on(crate::dbproxy::warm())
        .with_context(|| {
            format!("process {process_name} failed to warm DBProxy before readiness")
        })?;
    {
        let mut preflight_runtime = {
            let _guard = js_event_loop.enter();
            create_runtime(
                false,
                crate::logging::typescript_min_level(&process.logging),
            )
            .context("failed to create isolated Hotfix preflight V8")?
        };
        runtime_bundles
            .preflight(&js_event_loop, &mut preflight_runtime)
            .context("isolated Hotfix preflight failed")?;
    }
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
    let _inspector = ProcessInspector::start(
        &mut runtime,
        &process,
        runtime_bundles.model_specifier().to_string(),
    )?;
    let entrypoints = runtime_bundles
        .install_initial(&js_event_loop, &mut runtime)
        .context("failed to install initial Model/Hotfix generation")?;
    health_state.record_initial_hotfix(
        runtime_bundles.bundle_version().to_string(),
        project_root.join("dist").display().to_string(),
        runtime_bundles.model_contract_status(),
    );
    let active_game_config_cold_fingerprint =
        initial_game_config.cold_data_fingerprint().to_string();
    let initial_config_status = call_js_install_game_config(
        &js_event_loop,
        &mut runtime,
        &entrypoints,
        initial_game_config.manifest_json(),
        initial_game_config.server_data_json(),
    )
    .context("failed to install initial game config data")?;
    tracing::info!(
        target: "tiangz::game_config",
        data_fingerprint = initial_game_config.data_fingerprint(),
        status = %initial_config_status,
        "initial game config snapshot installed"
    );
    health_state.record_initial_game_config(initial_game_config.data_fingerprint().to_string());

    let process_config = json!({
        "process": process,
        "scenes": scenes,
        "knownScenes": known_scenes,
        "tickMs": process.game.fixed_update_ms,
    });
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
    let mut active_generation = 1_u64;
    let mut pending_async = false;
    let mut pending_ingress = false;
    let mut pending_reload: Option<(PathBuf, Instant, tokio::sync::oneshot::Sender<_>)> = None;
    let mut pending_config_reload: Option<(
        Box<GameConfigBundle>,
        Instant,
        tokio::sync::oneshot::Sender<_>,
    )> = None;
    let hotfix_reload_timeout = Duration::from_millis(process.lifecycle.hotfix_reload_timeout_ms);
    loop {
        while let Ok(control) = runtime_control_rx.try_recv() {
            match control {
                RuntimeControl::ReloadHotfix {
                    candidate_directory,
                    requested_at,
                    response,
                } => {
                    if pending_reload.is_some() {
                        let _ = response
                            .send(Err("another Hotfix reload is already pending".to_string()));
                    } else {
                        pending_reload = Some((candidate_directory, requested_at, response));
                    }
                }
                RuntimeControl::ReloadGameConfig {
                    candidate,
                    requested_at,
                    response,
                } => {
                    if pending_config_reload.is_some() {
                        let _ = response.send(Err(
                            "another game config reload is already pending".to_string()
                        ));
                    } else {
                        pending_config_reload = Some((candidate, requested_at, response));
                    }
                }
            }
        }

        if let Some((candidate, requested_at, response)) = pending_config_reload.take() {
            let result = if candidate.cold_data_fingerprint() != active_game_config_cold_fingerprint
            {
                Err(anyhow::anyhow!(
                    "cold game config changed: active={}, candidate={}; rebuild and restart the Process",
                    active_game_config_cold_fingerprint,
                    candidate.cold_data_fingerprint(),
                ))
            } else {
                execute_game_config_reload(
                    &js_event_loop,
                    &mut runtime,
                    &entrypoints,
                    &candidate,
                    requested_at,
                )
            };
            match &result {
                Ok(report) => health_state.record_game_config_success(
                    report.data_fingerprint.clone(),
                    report.commit_ms,
                    report.reload_total_ms,
                ),
                Err(_) => health_state.record_game_config_failure(),
            }
            let _ = response.send(result.map_err(|error| format!("{error:#}")));
            continue;
        }

        if pending_reload
            .as_ref()
            .is_some_and(|(_, requested_at, _)| requested_at.elapsed() >= hotfix_reload_timeout)
            && let Some((candidate_directory, _, response)) = pending_reload.take()
        {
            health_state.record_hotfix_failure();
            let _ = response.send(Err(format!(
                "Hotfix candidate {} did not reach a safe commit barrier within {}ms",
                candidate_directory.display(),
                hotfix_reload_timeout.as_millis(),
            )));
            continue;
        }

        if !pending_async
            && !pending_ingress
            && let Some((candidate_directory, requested_at, response)) = pending_reload.take()
        {
            let next_generation = active_generation + 1;
            let result = execute_hotfix_reload(
                &runtime_bundles,
                &js_event_loop,
                &mut runtime,
                &entrypoints,
                &candidate_directory,
                requested_at,
                next_generation,
                crate::logging::typescript_min_level(&process.logging),
            );
            if result.is_ok() {
                active_generation = next_generation;
            }
            match &result {
                Ok(report) => health_state.record_hotfix_success(
                    report.generation,
                    report.bundle_version.clone(),
                    report.candidate_directory.clone(),
                    report.validation_ms,
                    report.preflight_ms,
                    report.barrier_wait_ms,
                    report.candidate_eval_ms,
                    report.commit_ms,
                    report.reload_total_ms,
                ),
                Err(_) => health_state.record_hotfix_failure(),
            }
            let _ = response.send(result.map_err(|error| format!("{error:#}")));
            continue;
        }

        let mut packed_events = vec![0; 4];
        let mut event_count = 0_u32;
        let mut shutdown_requested = false;
        let wait_ms = scheduling.idle_tick_ms;
        let batch_capacity = scheduling.batch_capacity(queue_stats.depth.load(Ordering::Relaxed));
        if pending_ingress {
            // TS still has data ingress queued. Keep the control lane flowing so Probe,
            // disconnect, and completion responses cannot be rejected behind a data backlog.
            // Bound reinjection so the TS pump retains capacity to drain its existing queue.
            let control_capacity = batch_capacity.min(MAX_PENDING_INGRESS_CONTROL_EVENTS);
            while event_count < control_capacity as u32 {
                match event_rx.try_recv_control() {
                    Ok(event) => {
                        queue_stats.dequeue(event.kind(), event.ingress_class());
                        if matches!(&event, ProcessEvent::Shutdown) {
                            shutdown_requested = true;
                            break;
                        }
                        push_event(&mut packed_events, &mut event_count, event, &queue_stats)?;
                    }
                    Err(mpsc::TryRecvError::Empty | mpsc::TryRecvError::Disconnected) => break,
                }
            }
        } else {
            match event_rx.recv_timeout(Duration::from_millis(wait_ms)) {
                Ok(event) => {
                    queue_stats.dequeue(event.kind(), event.ingress_class());
                    if matches!(&event, ProcessEvent::Shutdown) {
                        shutdown_requested = true;
                    } else {
                        push_event(&mut packed_events, &mut event_count, event, &queue_stats)?;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        let coalesce_deadline = scheduling
            .coalesce_deadline(queue_stats.depth.load(Ordering::Relaxed) + event_count as usize);
        while !pending_ingress && !shutdown_requested && event_count < batch_capacity as u32 {
            match event_rx.try_recv() {
                Ok(event) => {
                    queue_stats.dequeue(event.kind(), event.ingress_class());
                    if matches!(&event, ProcessEvent::Shutdown) {
                        shutdown_requested = true;
                        break;
                    }
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
        (pending_async, pending_ingress) = flush_runtime_batch(
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
            &health_state,
        )?;
        if shutdown_requested {
            break;
        }
    }

    if let Some((_, _, response)) = pending_reload {
        let _ = response.send(Err(
            "Process stopped before Hotfix reached its commit barrier".to_string(),
        ));
    }
    if let Some((_, _, response)) = pending_config_reload {
        let _ = response.send(Err(
            "Process stopped before game config reload was committed".to_string(),
        ));
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

/// 在两个Update之间构造并替换配置Snapshot；失败不会修改当前Registry。 / Builds and swaps a config snapshot between updates; failure leaves the active registry untouched.
fn execute_game_config_reload(
    js_event_loop: &tokio::runtime::Runtime,
    runtime: &mut deno_core::JsRuntime,
    entrypoints: &crate::host::JsEntrypoints,
    candidate: &GameConfigBundle,
    requested_at: Instant,
) -> Result<GameConfigReloadReport> {
    let commit_started = Instant::now();
    let status_json = call_js_install_game_config(
        js_event_loop,
        runtime,
        entrypoints,
        candidate.manifest_json(),
        candidate.server_data_json(),
    )
    .context("TypeScript game config snapshot validation failed")?;
    Ok(GameConfigReloadReport {
        candidate_directory: candidate.directory().display().to_string(),
        data_fingerprint: candidate.data_fingerprint().to_string(),
        commit_ms: elapsed_ms(commit_started),
        reload_total_ms: elapsed_ms(requested_at),
        status_json,
    })
}

/// 在安全屏障内完成候选复核、隔离预检和正式 V8 提交；调用期间不从业务队列取新帧。
///
/// Revalidates, preflights, and commits one candidate inside the switch barrier. The caller does
/// not dequeue new business frames while this function runs, so queued ingress remains bounded in
/// Rust and observes either the old or the new handler table, never a partially committed table.
#[allow(clippy::too_many_arguments)]
fn execute_hotfix_reload(
    runtime_bundles: &RuntimeBundles,
    js_event_loop: &tokio::runtime::Runtime,
    runtime: &mut deno_core::JsRuntime,
    entrypoints: &crate::host::JsEntrypoints,
    candidate_directory: &Path,
    requested_at: Instant,
    generation: u64,
    typescript_log_level: u8,
) -> Result<HotfixReloadReport> {
    let candidate_directory = candidate_directory.canonicalize().with_context(|| {
        format!(
            "failed to resolve Hotfix candidate {}",
            candidate_directory.display()
        )
    })?;
    let validation_at = Instant::now();
    let candidate = runtime_bundles.load_candidate(&candidate_directory)?;
    let validation_ms = elapsed_ms(validation_at);

    let preflight_at = Instant::now();
    {
        let mut preflight_runtime = {
            let _guard = js_event_loop.enter();
            create_runtime(false, typescript_log_level)
                .context("failed to create isolated Hotfix reload preflight V8")?
        };
        runtime_bundles
            .preflight_candidate(js_event_loop, &mut preflight_runtime, &candidate)
            .context("isolated Hotfix reload preflight failed")?;
    }
    let preflight_ms = elapsed_ms(preflight_at);
    let install: HotfixInstallResult = candidate.install(js_event_loop, runtime, entrypoints)?;
    Ok(HotfixReloadReport {
        candidate_directory: candidate_directory.display().to_string(),
        bundle_version: install.bundle_version,
        generation,
        validation_ms,
        preflight_ms,
        barrier_wait_ms: (elapsed_ms(requested_at)
            - validation_ms
            - preflight_ms
            - install.timings.begin_ms
            - install.timings.candidate_eval_ms
            - install.timings.commit_ms)
            .max(0.0),
        begin_ms: install.timings.begin_ms,
        candidate_eval_ms: install.timings.candidate_eval_ms,
        commit_ms: install.timings.commit_ms,
        reload_total_ms: elapsed_ms(requested_at),
        status_json: install.status_json,
    })
}

fn elapsed_ms(started_at: Instant) -> f64 {
    started_at.elapsed().as_secs_f64() * 1_000.0
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
    health_state: &ProcessHealthState,
) -> Result<(bool, bool)> {
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
    let (
        pending_async,
        pending_ingress,
        metrics,
        game_metrics,
        native_data_metrics,
        actor_mailbox_metrics,
    ) = if sample_metrics {
        let result: UpdateResult = serde_json::from_str(&update_result).with_context(|| {
            format!("TS update returned invalid metrics snapshot: {update_result}")
        })?;
        (
            result.pending_async,
            result.pending_ingress,
            result.metrics,
            result.game,
            result.native_data,
            result.actor_mailbox,
        )
    } else {
        {
            let state = update_result.parse::<u8>().with_context(|| {
                format!("TS update returned invalid compact state: {update_result}")
            })?;
            (
                state & 1 != 0,
                state & 2 != 0,
                Vec::new(),
                None,
                None,
                MailboxMetricsSnapshot::default(),
            )
        }
    };
    if sample_metrics {
        maybe_log_metrics(
            process_name,
            &metrics,
            game_metrics.as_ref(),
            native_data_metrics.as_ref(),
            &actor_mailbox_metrics,
            last_metrics_log,
            queue_stats,
            runtime,
            system,
            process_pid,
            gc_metrics,
            last_process_cpu_time_ms,
            last_resource_sample_at,
            writers,
            health_state,
        );
    }
    flush_outbound(outbound, writers, queue_stats)?;
    close_requested_connections(take_close_connection_requests(), writers);
    Ok((pending_async, pending_ingress))
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
    actor_mailbox_metrics: &MailboxMetricsSnapshot,
    last_metrics_log: &mut Instant,
    queue_stats: &ProcessQueueStats,
    runtime: &mut deno_core::JsRuntime,
    system: &mut System,
    process_pid: Pid,
    gc_metrics: &V8GcMetrics,
    last_process_cpu_time_ms: &mut u64,
    last_resource_sample_at: &mut Instant,
    writers: &ConnectionWriters,
    health_state: &ProcessHealthState,
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
    let active_connections = writers
        .lock()
        .expect("connection writers lock poisoned")
        .len() as u64;
    let dropped_logs = crate::logging::dropped_lines();
    let remote_transport = snapshot_remote_transport();
    tracing::info!(target: "tiangz::metrics",
        "[process-metrics] process={process_name} cpu_percent={cpu_percent:.2} cpu_time_ms={cpu_time_ms} rss_bytes={rss_bytes} v8_heap_used_bytes={} v8_heap_total_bytes={} v8_gc_count={} v8_gc_ms={:.3} timestamp_ms={timestamp_ms} dropped_logs={} inbound_frames={} host_completions={} disconnects={} runtime_updates={} runtime_events={} max_runtime_batch={} outbound_batches={} outbound_recipients={} outbound_bridge_bytes={} outbound_logical_bytes={} transport_read_ops={} transport_read_frames={} transport_read_bytes={} transport_write_ops={} transport_write_frames={} transport_write_bytes={}",
        heap.used_heap_size(),
        heap.total_heap_size(),
        gc_metrics.count,
        gc_metrics.total_duration.as_secs_f64() * 1000.0,
        dropped_logs as u64,
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
            "[game-metrics] process={process_name} fixed_update_ms={} frame_count={} skipped_fixed_updates={} update_targets={} update_calls={} update_failures={} timers={} coroutine_lock_waiters={} coroutine_lock_timeouts={}",
            game.fixed_update_ms,
            game.frame_count,
            game.skipped_fixed_updates,
            game.update_targets,
            game.update_calls,
            game.update_failures,
            game.timers,
            game.coroutine_lock_waiters,
            game.coroutine_lock_timeouts,
        );
    }
    tracing::info!(target: "tiangz::metrics",
        "[actor-mailbox-metrics] process={process_name} fast_path={} queued={} async={} one_way_fast_path={} one_way_queued={} one_way_async={} depth={} max_depth={}",
        actor_mailbox_metrics.fast_path_calls,
        actor_mailbox_metrics.queued_calls,
        actor_mailbox_metrics.async_calls,
        actor_mailbox_metrics.one_way_fast_path_calls,
        actor_mailbox_metrics.one_way_queued_calls,
        actor_mailbox_metrics.one_way_async_calls,
        actor_mailbox_metrics.queued_depth,
        actor_mailbox_metrics.max_queued_depth,
    );
    if let Some(native) = native_data_metrics {
        tracing::info!(target: "tiangz::metrics",
            "[native-data-metrics] process={process_name} scalar_gets={} scalar_sets={} batch_calls={} live_entities={} live_units={} live_items={} pool_capacity_bytes={} scratch_capacity_bytes={} scratch_growths={} native_refs={} encoded_frames={} encoded_items={} encoded_bytes={} aoi_worlds={} aoi_entries={} aoi_grids={} aoi_candidate_relations={} aoi_visible_relations={} aoi_lingering_relations={} aoi_rejected_relations={} aoi_relocations={} aoi_visibility_changes={} aoi_filter_overrides={}",
            native.scalar_gets,
            native.scalar_sets,
            native.batch_calls,
            native.live_entities,
            native.live_units,
            native.live_items,
            native.pool_capacity_bytes,
            native.scratch_capacity_bytes,
            native.scratch_growths,
            native.native_refs.values().sum::<u64>(),
            native.encoded_frames,
            native.encoded_items,
            native.encoded_bytes,
            native.aoi_worlds,
            native.aoi_entries,
            native.aoi_grids,
            native.aoi_candidate_relations,
            native.aoi_visible_relations,
            native.aoi_lingering_relations,
            native.aoi_rejected_relations,
            native.aoi_relocations,
            native.aoi_visibility_changes,
            native.aoi_filter_overrides,
        );
    }
    for metric in metrics {
        tracing::info!(target: "tiangz::metrics",
            "[metrics:{process_name}] scene={} type={} processed={} failed={} protocol_successes={} business_errors={} system_errors={} decode_errors={} handler_not_found={} message_handler_failures={} ts_queue={} ts_max_queue={} ingress_pump_frames={} ingress_pump_ms={:.2} mailbox_fast={} mailbox_queued={} mailbox_async={} mailbox_one_way_fast={} mailbox_one_way_queued={} mailbox_one_way_async={} mailbox_depth={} mailbox_max_depth={} async_in_flight={} max_async_in_flight={} rust_queue={} rust_max_queue={} backpressure={} slow_disconnects={} update_ms={:.2} handler_ms={:.2} max_handler_ms={:.2} total_handler_ms={:.2}",
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
            metric.last_ingress_pump_frames,
            metric.last_ingress_pump_cost_ms,
            metric.mailbox.fast_path_calls,
            metric.mailbox.queued_calls,
            metric.mailbox.async_calls,
            metric.mailbox.one_way_fast_path_calls,
            metric.mailbox.one_way_queued_calls,
            metric.mailbox.one_way_async_calls,
            metric.mailbox.queued_depth,
            metric.mailbox.max_queued_depth,
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

    let mut scene_snapshots = Vec::with_capacity(metrics.len());
    for metric in metrics {
        let mut latency_snapshots = Vec::with_capacity(metric.latencies.len());
        for latency in &metric.latencies {
            latency_snapshots.push(LatencyObservabilitySnapshot {
                name: latency.name.clone(),
                msgcode: latency.msgcode.map(|msgcode| msgcode.to_string()),
                count: latency.count,
                sum_ms: latency.sum_ms,
                bounds_ms: latency.bounds_ms.clone(),
                bucket_counts: latency.bucket_counts.clone(),
            });
        }
        scene_snapshots.push(SceneObservabilitySnapshot {
            scene: metric.scene.clone(),
            scene_type: metric.scene_type.clone(),
            processed_frames: metric.processed_frames,
            failed_frames: metric.failed_frames,
            protocol_successes: metric.protocol_successes,
            business_errors: metric.business_errors,
            system_errors: metric.system_errors,
            decode_errors: metric.decode_errors,
            handler_not_found: metric.handler_not_found,
            message_handler_failures: metric.message_handler_failures,
            ingress_queue_length: metric.ingress_queue_length as u64,
            max_ingress_queue_length: metric.max_ingress_queue_length as u64,
            last_ingress_pump_frames: metric.last_ingress_pump_frames,
            last_ingress_pump_cost_ms: metric.last_ingress_pump_cost_ms,
            async_in_flight: metric.async_in_flight as u64,
            max_async_in_flight: metric.max_async_in_flight as u64,
            mailbox: MailboxObservabilitySnapshot {
                fast_path_calls: metric.mailbox.fast_path_calls,
                queued_calls: metric.mailbox.queued_calls,
                async_calls: metric.mailbox.async_calls,
                one_way_fast_path_calls: metric.mailbox.one_way_fast_path_calls,
                one_way_queued_calls: metric.mailbox.one_way_queued_calls,
                one_way_async_calls: metric.mailbox.one_way_async_calls,
                queued_depth: metric.mailbox.queued_depth,
                max_queued_depth: metric.mailbox.max_queued_depth,
            },
            last_update_cost_ms: metric.last_update_cost_ms,
            last_handler_cost_ms: metric.last_handler_cost_ms,
            max_handler_cost_ms: metric.max_handler_cost_ms,
            total_handler_cost_ms: metric.total_handler_cost_ms,
            latencies: latency_snapshots,
            custom_metrics: metric
                .custom_metrics
                .iter()
                .map(|item| SceneCustomMetricSnapshot {
                    name: item.name.clone(),
                    values: item.values.clone(),
                    kinds: item
                        .kinds
                        .iter()
                        .map(|(key, kind)| {
                            let kind = match kind {
                                CustomMetricKind::Counter => SceneCustomMetricKind::Counter,
                                CustomMetricKind::Gauge => SceneCustomMetricKind::Gauge,
                            };
                            (key.clone(), kind)
                        })
                        .collect(),
                })
                .collect(),
        });
    }

    let game_snapshot = game_metrics.map(|game| GameObservabilitySnapshot {
        fixed_update_ms: game.fixed_update_ms,
        frame_count: game.frame_count,
        skipped_fixed_updates: game.skipped_fixed_updates,
        update_targets: game.update_targets as u64,
        update_calls: game.update_calls,
        update_failures: game.update_failures,
        timers: game.timers as u64,
        coroutine_lock_waiters: game.coroutine_lock_waiters as u64,
        coroutine_lock_timeouts: game.coroutine_lock_timeouts,
    });
    let native_snapshot = native_data_metrics.map(|native| NativeDataObservabilitySnapshot {
        scalar_gets: native.scalar_gets,
        scalar_sets: native.scalar_sets,
        batch_calls: native.batch_calls,
        live_entities: native.live_entities as u64,
        live_units: native.live_units as u64,
        live_items: native.live_items as u64,
        pool_capacity_bytes: native.pool_capacity_bytes,
        scratch_capacity_bytes: native.scratch_capacity_bytes,
        scratch_growths: native.scratch_growths,
        native_refs: native.native_refs.clone(),
        encoded_frames: native.encoded_frames,
        encoded_items: native.encoded_items,
        encoded_bytes: native.encoded_bytes,
        aoi_worlds: native.aoi_worlds as u64,
        aoi_entries: native.aoi_entries as u64,
        aoi_grids: native.aoi_grids as u64,
        aoi_candidate_relations: native.aoi_candidate_relations,
        aoi_visible_relations: native.aoi_visible_relations,
        aoi_lingering_relations: native.aoi_lingering_relations,
        aoi_rejected_relations: native.aoi_rejected_relations,
        aoi_relocations: native.aoi_relocations,
        aoi_visibility_changes: native.aoi_visibility_changes,
        aoi_filter_overrides: native.aoi_filter_overrides,
        navigation_assets: native.navigation_assets as u64,
        navigation_worlds: native.navigation_worlds as u64,
        numeric_replication: native
            .numeric_replication
            .iter()
            .map(
                |item| crate::health::NativeNumericReplicationObservabilitySnapshot {
                    numeric_type: item.numeric_type,
                    changes: item.changes,
                    encoded_records: item.encoded_records,
                    recipient_deliveries: item.recipient_deliveries,
                    logical_bytes: item.logical_bytes,
                },
            )
            .collect(),
    });

    health_state.set_observability_snapshot(ProcessObservabilitySnapshot {
        sample_timestamp_ms: timestamp_ms as u64,
        cpu_percent,
        cpu_time_ms,
        rss_bytes,
        v8_heap_used_bytes: heap.used_heap_size() as u64,
        v8_heap_total_bytes: heap.total_heap_size() as u64,
        v8_gc_count: gc_metrics.count,
        v8_gc_ms: gc_metrics.total_duration.as_secs_f64() * 1000.0,
        dropped_logs: dropped_logs as u64,
        backpressure_waits: queue_stats.backpressure_waits.load(Ordering::Relaxed),
        slow_client_disconnects: queue_stats.slow_client_disconnects.load(Ordering::Relaxed),
        inbound_frames: queue_stats.inbound_frames.load(Ordering::Relaxed),
        host_completions: queue_stats.host_completions.load(Ordering::Relaxed),
        disconnects: queue_stats.disconnects.load(Ordering::Relaxed),
        runtime_updates: queue_stats.runtime_updates.load(Ordering::Relaxed),
        runtime_events: queue_stats.runtime_events.load(Ordering::Relaxed),
        max_runtime_batch: queue_stats.max_runtime_batch.load(Ordering::Relaxed) as u64,
        outbound_batches: queue_stats.outbound_batches.load(Ordering::Relaxed),
        outbound_recipients: queue_stats.outbound_recipients.load(Ordering::Relaxed),
        outbound_bridge_bytes: queue_stats.outbound_bridge_bytes.load(Ordering::Relaxed),
        outbound_logical_bytes: queue_stats.outbound_logical_bytes.load(Ordering::Relaxed),
        transport_read_ops: queue_stats.transport_read_ops.load(Ordering::Relaxed),
        transport_read_frames: queue_stats.transport_read_frames.load(Ordering::Relaxed),
        transport_read_bytes: queue_stats.transport_read_bytes.load(Ordering::Relaxed),
        transport_write_ops: queue_stats.transport_write_ops.load(Ordering::Relaxed),
        transport_write_frames: queue_stats.transport_write_frames.load(Ordering::Relaxed),
        transport_write_bytes: queue_stats.transport_write_bytes.load(Ordering::Relaxed),
        active_connections,
        remote_transport_active_connections: remote_transport
            .as_ref()
            .map(|snapshot| snapshot.active_connections)
            .unwrap_or_default(),
        remote_transport_opened_connections: remote_transport
            .as_ref()
            .map(|snapshot| snapshot.opened_connections)
            .unwrap_or_default(),
        remote_transport_pending_calls: remote_transport
            .as_ref()
            .map(|snapshot| snapshot.pending_calls)
            .unwrap_or_default(),
        remote_transport_max_pending_calls: remote_transport
            .as_ref()
            .map(|snapshot| snapshot.max_pending_calls)
            .unwrap_or_default(),
        remote_transport_overload_rejections: remote_transport
            .as_ref()
            .map(|snapshot| snapshot.overload_rejections)
            .unwrap_or_default(),
        remote_transport_timed_out_calls: remote_transport
            .as_ref()
            .map(|snapshot| snapshot.timed_out_calls)
            .unwrap_or_default(),
        remote_transport_disconnected_calls: remote_transport
            .as_ref()
            .map(|snapshot| snapshot.disconnected_calls)
            .unwrap_or_default(),
        remote_transport_late_responses: remote_transport
            .as_ref()
            .map(|snapshot| snapshot.late_responses)
            .unwrap_or_default(),
        remote_transport_idle_closes: remote_transport
            .as_ref()
            .map(|snapshot| snapshot.idle_closes)
            .unwrap_or_default(),
        remote_transport_overload_stages: remote_transport
            .as_ref()
            .map(|snapshot| {
                snapshot
                    .overload_stages
                    .iter()
                    .map(|stage| TransportOverloadStageObservabilitySnapshot {
                        stage: stage.stage.to_string(),
                        rejections: stage.rejections,
                    })
                    .collect()
            })
            .unwrap_or_default(),
        remote_transport_diagnostics: remote_transport
            .as_ref()
            .map(|snapshot| {
                snapshot
                    .diagnostics
                    .iter()
                    .map(|diagnostic| TransportDiagnosticObservabilitySnapshot {
                        msgcode: diagnostic.msgcode,
                        source: diagnostic.source.clone(),
                        target: diagnostic.target.clone(),
                        traffic: diagnostic.traffic.to_string(),
                        stage: diagnostic.stage.to_string(),
                        overloads: diagnostic.overloads,
                        timeouts: diagnostic.timeouts,
                    })
                    .collect()
            })
            .unwrap_or_default(),
        queue_depth: queue_stats.depth.load(Ordering::Relaxed) as u64,
        queue_capacity: queue_stats.capacity as u64,
        queue_max_depth: queue_stats.max_depth.load(Ordering::Relaxed) as u64,
        queue_stages: ProcessEventKind::ALL
            .into_iter()
            .map(|kind| {
                let stage = queue_stats.stage(kind);
                ProcessQueueStageObservabilitySnapshot {
                    stage: kind.name().to_string(),
                    depth: stage.depth.load(Ordering::Relaxed) as u64,
                    max_depth: stage.max_depth.load(Ordering::Relaxed) as u64,
                    backpressure_waits: stage.backpressure_waits.load(Ordering::Relaxed),
                    backpressure_wait_ms: stage.backpressure_wait_ns.load(Ordering::Relaxed) as f64
                        / 1_000_000.0,
                    max_backpressure_wait_ms: stage.max_backpressure_wait_ns.load(Ordering::Relaxed)
                        as f64
                        / 1_000_000.0,
                }
            })
            .chain(ProcessIngressClass::ALL.into_iter().map(|class| {
                let stage = queue_stats.ingress_stage(class);
                ProcessQueueStageObservabilitySnapshot {
                    stage: class.name().to_string(),
                    depth: stage.depth.load(Ordering::Relaxed) as u64,
                    max_depth: stage.max_depth.load(Ordering::Relaxed) as u64,
                    backpressure_waits: stage.backpressure_waits.load(Ordering::Relaxed),
                    backpressure_wait_ms: stage.backpressure_wait_ns.load(Ordering::Relaxed) as f64
                        / 1_000_000.0,
                    max_backpressure_wait_ms: stage.max_backpressure_wait_ns.load(Ordering::Relaxed)
                        as f64
                        / 1_000_000.0,
                }
            }))
            .collect(),
        scenes: scene_snapshots,
        actor_mailbox: MailboxObservabilitySnapshot {
            fast_path_calls: actor_mailbox_metrics.fast_path_calls,
            queued_calls: actor_mailbox_metrics.queued_calls,
            async_calls: actor_mailbox_metrics.async_calls,
            one_way_fast_path_calls: actor_mailbox_metrics.one_way_fast_path_calls,
            one_way_queued_calls: actor_mailbox_metrics.one_way_queued_calls,
            one_way_async_calls: actor_mailbox_metrics.one_way_async_calls,
            queued_depth: actor_mailbox_metrics.queued_depth,
            max_queued_depth: actor_mailbox_metrics.max_queued_depth,
        },
        game: game_snapshot,
        native_data: native_snapshot,
    });
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
            let event_type = if crate::transport::inner_frame_rpc_id(&frame).is_some() {
                5
            } else {
                1
            };
            push_packed_event(
                packed_events,
                event_type,
                connection_id,
                scene_index,
                &frame,
            )?;
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
    let aggregate_by_connection = outbound
        .iter()
        .map(|batch| batch.connection_ids.len())
        .sum::<usize>()
        > WRITE_BATCH_FRAME_CAPACITY;
    let mut frames_by_connection = HashMap::<u64, Vec<Bytes>>::new();
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
            if aggregate_by_connection {
                frames_by_connection
                    .entry(connection_id)
                    .or_default()
                    .push(batch.frame.clone());
            } else if let Some(writer) = writers.get(&connection_id)
                && try_queue_connection_frame(writer, batch.frame.clone()).is_err()
            {
                slow_connections.push(connection_id);
            }
        }
    }

    for (connection_id, frames) in frames_by_connection {
        let Some(writer) = writers.get(&connection_id) else {
            continue;
        };
        let mut pending = Vec::with_capacity(WRITE_BATCH_FRAME_CAPACITY);
        let mut pending_bytes = 0_usize;
        for frame in frames {
            if !pending.is_empty()
                && (pending.len() >= WRITE_BATCH_FRAME_CAPACITY
                    || pending_bytes + frame.len() > WRITE_BATCH_BYTE_CAPACITY)
            {
                let batch = ConnectionWriteBatch::from_frames(std::mem::take(&mut pending));
                if try_queue_connection_batch(writer, batch).is_err() {
                    slow_connections.push(connection_id);
                    break;
                }
                pending = Vec::with_capacity(WRITE_BATCH_FRAME_CAPACITY);
                pending_bytes = 0;
            }
            pending_bytes += frame.len();
            pending.push(frame);
        }
        if !pending.is_empty()
            && !slow_connections.contains(&connection_id)
            && try_queue_connection_batch(writer, ConnectionWriteBatch::from_frames(pending))
                .is_err()
        {
            slow_connections.push(connection_id);
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
        let (control_sender, control_receiver) = mpsc::sync_channel(1);
        let (data_sender, data_receiver) = mpsc::sync_channel(1);
        let (wake_sender, wake_receiver) = mpsc::sync_channel(1);
        let stats = Arc::new(ProcessQueueStats::default());
        let sender = ProcessEventSender {
            control_sender,
            data_sender,
            wake_sender,
            stats: Arc::clone(&stats),
        };
        let mut receiver = ProcessEventReceiver {
            control_receiver,
            data_receiver,
            wake_receiver,
            consecutive_control: 0,
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

        let event = receiver.recv_timeout(Duration::from_secs(1)).unwrap();
        stats.dequeue(event.kind(), event.ingress_class());
        second.await.unwrap().unwrap();
        let event = receiver.recv_timeout(Duration::from_secs(1)).unwrap();
        stats.dequeue(event.kind(), event.ingress_class());
        assert_eq!(stats.depth.load(Ordering::Relaxed), 0);
        assert_eq!(stats.disconnect.depth.load(Ordering::Relaxed), 0);
        assert!(stats.disconnect.backpressure_waits.load(Ordering::Relaxed) >= 1);
        assert!(
            stats
                .disconnect
                .backpressure_wait_ns
                .load(Ordering::Relaxed)
                > 0
        );
    }

    #[tokio::test]
    async fn process_queue_reserves_data_progress_after_control_burst() {
        let (control_sender, control_receiver) = mpsc::sync_channel(64);
        let (data_sender, data_receiver) = mpsc::sync_channel(8);
        let (wake_sender, wake_receiver) = mpsc::sync_channel(1);
        let stats = Arc::new(ProcessQueueStats::default());
        let sender = ProcessEventSender {
            control_sender,
            data_sender,
            wake_sender,
            stats: Arc::clone(&stats),
        };
        let mut receiver = ProcessEventReceiver {
            control_receiver,
            data_receiver,
            wake_receiver,
            consecutive_control: 0,
        };

        for connection_id in 1..=(MAX_CONSECUTIVE_CONTROL_EVENTS as u64 + 1) {
            sender
                .send(
                    ProcessEvent::Disconnect {
                        scene_index: 0,
                        connection_id,
                    },
                    None,
                )
                .await
                .unwrap();
        }
        sender
            .send(
                ProcessEvent::Frame {
                    scene_index: 0,
                    connection_id: 999,
                    frame: Bytes::from_static(&[0x4e, 0x20]),
                },
                None,
            )
            .await
            .unwrap();

        for _ in 0..MAX_CONSECUTIVE_CONTROL_EVENTS {
            let event = receiver.try_recv().unwrap();
            assert_eq!(event.ingress_class(), ProcessIngressClass::Control);
            stats.dequeue(event.kind(), event.ingress_class());
        }
        let event = receiver.try_recv().unwrap();
        assert_eq!(event.ingress_class(), ProcessIngressClass::Data);
        stats.dequeue(event.kind(), event.ingress_class());
    }

    #[test]
    fn control_ingress_overload_is_rejected_immediately() {
        let (control_sender, _control_receiver) = mpsc::sync_channel(1);
        let (data_sender, _data_receiver) = mpsc::sync_channel(1);
        let (wake_sender, _wake_receiver) = mpsc::sync_channel(1);
        let stats = Arc::new(ProcessQueueStats::default());
        let sender = ProcessEventSender {
            control_sender,
            data_sender,
            wake_sender,
            stats: Arc::clone(&stats),
        };
        sender
            .try_send_control(ProcessEvent::Disconnect {
                scene_index: 0,
                connection_id: 1,
            })
            .unwrap();

        let result = sender.try_send_control(ProcessEvent::Disconnect {
            scene_index: 0,
            connection_id: 2,
        });

        assert_eq!(result, Err(ProcessIngressTrySendError::Overloaded));
        assert_eq!(stats.depth.load(Ordering::Relaxed), 1);
        assert_eq!(stats.control_ingress.depth.load(Ordering::Relaxed), 1);
        assert_eq!(stats.backpressure_waits.load(Ordering::Relaxed), 1);
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
                queued_bytes: Arc::new(AtomicUsize::new(CONNECTION_OUTBOUND_BYTE_CAPACITY)),
                queued_frames: Arc::new(AtomicUsize::new(0)),
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
                queued_frames: Arc::new(AtomicUsize::new(0)),
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
                    queued_frames: Arc::new(AtomicUsize::new(0)),
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
        assert_eq!(received1.frames, received2.frames);
        assert_eq!(received1.frames[0].as_ptr(), received2.frames[0].as_ptr());
        assert_eq!(stats.outbound_batches.load(Ordering::Relaxed), 1);
        assert_eq!(stats.outbound_recipients.load(Ordering::Relaxed), 2);
        assert_eq!(stats.outbound_bridge_bytes.load(Ordering::Relaxed), 4);
        assert_eq!(stats.outbound_logical_bytes.load(Ordering::Relaxed), 8);
    }

    #[test]
    fn small_outbound_sets_keep_direct_connection_order() {
        let writers: ConnectionWriters = Arc::new(Mutex::new(HashMap::new()));
        let (sender, mut receiver) = tokio_mpsc::channel(4);
        let queued_bytes = Arc::new(AtomicUsize::new(0));
        let queued_frames = Arc::new(AtomicUsize::new(0));
        let (shutdown_tx, _shutdown_rx) = watch::channel(false);
        writers.lock().unwrap().insert(
            7,
            ConnectionWriter {
                sender,
                queued_bytes: Arc::clone(&queued_bytes),
                queued_frames: Arc::clone(&queued_frames),
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
                BinaryOutboundBatch {
                    connection_ids: vec![7],
                    frame: Bytes::from_static(&[0, 3]),
                },
            ],
            &writers,
            &stats,
        )
        .unwrap();

        assert_eq!(receiver.try_recv().unwrap().frames[0].as_ref(), [0, 1]);
        assert_eq!(receiver.try_recv().unwrap().frames[0].as_ref(), [0, 2]);
        assert_eq!(receiver.try_recv().unwrap().frames[0].as_ref(), [0, 3]);
        assert!(receiver.try_recv().is_err());
        assert_eq!(queued_frames.load(Ordering::Relaxed), 3);
        assert_eq!(queued_bytes.load(Ordering::Relaxed), 6);
    }

    #[test]
    fn outbound_connection_batches_preserve_frame_capacity() {
        let writers: ConnectionWriters = Arc::new(Mutex::new(HashMap::new()));
        let (sender, mut receiver) = tokio_mpsc::channel(4);
        let (shutdown_tx, _shutdown_rx) = watch::channel(false);
        writers.lock().unwrap().insert(
            7,
            ConnectionWriter {
                sender,
                queued_bytes: Arc::new(AtomicUsize::new(0)),
                queued_frames: Arc::new(AtomicUsize::new(0)),
                shutdown_tx,
            },
        );
        let stats = ProcessQueueStats::default();
        let outbound = (0..WRITE_BATCH_FRAME_CAPACITY + 1)
            .map(|index| BinaryOutboundBatch {
                connection_ids: vec![7],
                frame: Bytes::from(vec![0, index as u8]),
            })
            .collect();

        flush_outbound(outbound, &writers, &stats).unwrap();

        assert_eq!(
            receiver.try_recv().unwrap().frames.len(),
            WRITE_BATCH_FRAME_CAPACITY
        );
        assert_eq!(receiver.try_recv().unwrap().frames.len(), 1);
        assert!(receiver.try_recv().is_err());
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
                    "timers": 3,
                    "coroutineLockWaiters": 2,
                    "coroutineLockTimeouts": 7
                },
                "actorMailbox": {
                    "queuedCalls": 8,
                    "oneWayQueuedCalls": 9,
                    "queuedDepth": 2,
                    "maxQueuedDepth": 12
                },
                "pendingAsync": false,
                "pendingIngress": true
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
        assert_eq!(game.coroutine_lock_waiters, 2);
        assert_eq!(game.coroutine_lock_timeouts, 7);
        assert_eq!(result.actor_mailbox.queued_calls, 8);
        assert_eq!(result.actor_mailbox.one_way_queued_calls, 9);
        assert_eq!(result.actor_mailbox.queued_depth, 2);
        assert_eq!(result.actor_mailbox.max_queued_depth, 12);
        assert!(result.pending_ingress);
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
                    "lastIngressPumpFrames": 17,
                    "lastIngressPumpCostMs": 4.5,
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
                        },
                        "kinds": { "coalesced_frames_total": "counter" }
                    }]
                }],
                "pendingAsync": false
            }"#,
        )
        .expect("custom scene metrics must deserialize");

        assert_eq!(result.metrics[0].last_ingress_pump_frames, 17);
        assert_eq!(result.metrics[0].last_ingress_pump_cost_ms, 4.5);
        let custom = &result.metrics[0].custom_metrics[0];
        assert_eq!(custom.name, "map_broadcast");
        assert_eq!(custom.values.get("in_flight"), Some(&1.0));
        assert_eq!(custom.values.get("pending_units"), Some(&12.0));
        assert_eq!(custom.values.get("coalesced_frames_total"), Some(&34.0));
        assert!(matches!(
            custom.kinds.get("coalesced_frames_total"),
            Some(CustomMetricKind::Counter)
        ));
    }
}
