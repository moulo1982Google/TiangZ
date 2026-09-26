//! 协调有界宿主队列、单 V8 业务线程、端点、Update 与停机。 / Coordinates bounded host queues, one V8 business thread, endpoints, updates, and shutdown.

mod host_events;
mod observability;
use host_events::HostEventBatch;
use observability::{
    GameMetricsSnapshot, MailboxMetricsSnapshot, NativeDataMetricsSnapshot, SceneMetricsSnapshot,
    maybe_log_metrics,
};

#[cfg(test)]
#[path = "process_endpoint_tests.rs"]
mod endpoint_tests;
#[cfg(test)]
mod host_batch_tests;
#[cfg(test)]
mod ingress_buffer_tests;
#[cfg(test)]
#[path = "process_lifecycle_tests.rs"]
mod lifecycle_tests;

use std::collections::{HashMap, VecDeque};
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use bytes::Bytes;
use futures_util::{StreamExt, stream::FuturesUnordered};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sysinfo::{Pid, ProcessesToUpdate, System};
#[cfg(test)]
use tokio::sync::{mpsc as tokio_mpsc, watch};

use crate::config::{ProcessConfig, ProcessSchedulingMode, RuntimeConfig, SceneConfig};
use crate::data_pack::{LoadedRuntimeDataPack, load_runtime_data_packs};
use crate::health::{HealthServer, ProcessHealthState};
use crate::host::{
    BinaryOutboundBatch, HostSceneCompletion, call_js_push_host_events, call_js_start_process,
    call_js_stop_process, call_js_update_binary, configure_host_scene_bridge, create_runtime,
    poll_js_stop_process, pump_js_event_loop_once, take_close_connection_requests,
};
use crate::hotfix::{HotfixCandidate, HotfixInstallResult, RuntimeBundles};
use crate::inspector::ProcessInspector;
use crate::shutdown::{
    ParentControlCommand, receive_parent_control, spawn_parent_control_receiver,
};
use crate::transport::init_remote_transport;
#[cfg(test)]
use crate::transport_backend::{
    CONNECTION_OUTBOUND_BYTE_CAPACITY, ConnectionKind, ConnectionWriter, validate_frame_access,
};
use crate::transport_backend::{
    ConnectionQueueError, ConnectionWriteBatch, ConnectionWriters, EndpointContext,
    WRITE_BATCH_BYTE_CAPACITY, WRITE_BATCH_FRAME_CAPACITY, create_io_backend, stop_endpoints,
    try_queue_connection_batch, try_queue_connection_frame,
};

const DEFAULT_PROCESS_EVENT_QUEUE_CAPACITY: usize = 4096;
const PROCESS_CONTROL_QUEUE_DIVISOR: usize = 4;
const MAX_CONSECUTIVE_CONTROL_EVENTS: usize = 32;
const MAX_PENDING_INGRESS_CONTROL_EVENTS: usize = 128;
const MAX_RETURNED_PROCESS_EVENTS: usize = 2;
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
        internal: bool,
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
            Self::Frame {
                frame, internal, ..
            } if !internal || crate::transport::inner_frame_rpc_id(frame).is_none() => {
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
}

/// Hotfix 控制面返回的分段结果，同时作为结构化日志与性能测试的稳定字段。 / Segmented Hotfix control result used by structured logs and performance tests.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HotfixReloadReport {
    pub(crate) candidate_directory: String,
    pub(crate) bundle_version: String,
    pub(crate) config_fingerprint: String,
    pub(crate) generation: u64,
    pub(crate) validation_ms: f64,
    pub(crate) preflight_ms: f64,
    pub(crate) barrier_wait_ms: f64,
    pub(crate) begin_ms: f64,
    pub(crate) candidate_eval_ms: f64,
    pub(crate) commit_ms: f64,
    pub(crate) reload_total_ms: f64,
    pub(crate) pause_ms: f64,
    pub(crate) status_json: String,
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
    pub(crate) admission: Arc<crate::transport_backend::admission::ConnectionAdmission>,
    pub(crate) outbound_buffers: Arc<tiangz_transport::buffer_budget::BufferBudget>,
    pub(crate) ingress_buffers: Arc<tiangz_transport::buffer_budget::BufferBudget>,
    pub(crate) kcp_buffers: Arc<tiangz_transport::buffer_budget::BufferBudget>,
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
    max_host_event_batch_bytes: AtomicUsize,
    host_event_batch_splits: AtomicU64,
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
    /// 未显式配置的夹具和默认状态沿用同一套网络默认值。 / Uses the network defaults for fixtures and default state.
    fn new(capacity: usize) -> Self {
        Self::with_network_limits(capacity, &crate::config::ProcessNetworkConfig::default())
    }

    /// Process 只创建一次准入所有者，端点通过共享统计句柄使用它。 / Creates one admission owner per process, shared through the endpoint statistics handle.
    fn with_network_limits(capacity: usize, network: &crate::config::ProcessNetworkConfig) -> Self {
        Self {
            outbound_buffers: tiangz_transport::buffer_budget::BufferBudget::new(
                network.max_outbound_buffered_bytes,
            ),
            ingress_buffers: tiangz_transport::buffer_budget::BufferBudget::new(
                network.max_ingress_buffered_bytes,
            ),
            kcp_buffers: tiangz_transport::buffer_budget::BufferBudget::new(
                network.max_kcp_buffered_bytes,
            ),
            admission: Arc::new(
                crate::transport_backend::admission::ConnectionAdmission::new(
                    network.max_accepted_connections,
                    network.max_pending_handshakes,
                ),
            ),
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
            max_host_event_batch_bytes: AtomicUsize::default(),
            host_event_batch_splits: AtomicU64::default(),
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
        // 包含两条通道各自的暂存队首；仍滤掉并发 try_send 失败前的瞬时计数。
        // Include both retained lane heads, still capping transient failed try_send attempts.
        let observed_capacity = self.capacity.saturating_add(MAX_RETURNED_PROCESS_EVENTS);
        let depth = self.depth.fetch_add(1, Ordering::Relaxed) + 1;
        self.max_depth
            .fetch_max(depth.min(observed_capacity), Ordering::Relaxed);
        let stage = self.stage(kind);
        let stage_depth = stage.depth.fetch_add(1, Ordering::Relaxed) + 1;
        stage
            .max_depth
            .fetch_max(stage_depth.min(observed_capacity), Ordering::Relaxed);
        let ingress_stage = self.ingress_stage(class);
        let ingress_depth = ingress_stage.depth.fetch_add(1, Ordering::Relaxed) + 1;
        ingress_stage
            .max_depth
            .fetch_max(ingress_depth.min(observed_capacity), Ordering::Relaxed);
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
    previous_consecutive_control: usize,
    pending_control: Option<ProcessEvent>,
    pending_data: Option<ProcessEvent>,
}

impl ProcessEventReceiver {
    fn new(
        control_receiver: mpsc::Receiver<ProcessEvent>,
        data_receiver: mpsc::Receiver<ProcessEvent>,
        wake_receiver: mpsc::Receiver<()>,
    ) -> Self {
        Self {
            control_receiver,
            data_receiver,
            wake_receiver,
            consecutive_control: 0,
            previous_consecutive_control: 0,
            pending_control: None,
            pending_data: None,
        }
    }

    fn received(&mut self, event: ProcessEvent) -> ProcessEvent {
        self.previous_consecutive_control = self.consecutive_control;
        self.consecutive_control = match event.ingress_class() {
            ProcessIngressClass::Control => self.consecutive_control.saturating_add(1),
            ProcessIngressClass::Data => 0,
        };
        event
    }

    /// 只退回最近取出的事件；深度和 ingress 守卫保留，公平计数恢复。 / Returns only the last received event, retaining depth/ingress ownership and restoring fairness.
    fn return_front(&mut self, event: ProcessEvent) {
        let pending = match event.ingress_class() {
            ProcessIngressClass::Control => &mut self.pending_control,
            ProcessIngressClass::Data => &mut self.pending_data,
        };
        assert!(
            pending.is_none(),
            "process ingress already has a returned event"
        );
        *pending = Some(event);
        self.consecutive_control = self.previous_consecutive_control;
    }

    fn take_data(&mut self) -> std::result::Result<ProcessEvent, mpsc::TryRecvError> {
        self.pending_data
            .take()
            .map(Ok)
            .unwrap_or_else(|| self.data_receiver.try_recv())
    }

    fn try_recv_control(&mut self) -> std::result::Result<ProcessEvent, mpsc::TryRecvError> {
        let event = self
            .pending_control
            .take()
            .map(Ok)
            .unwrap_or_else(|| self.control_receiver.try_recv())?;
        Ok(self.received(event))
    }

    fn try_recv(&mut self) -> std::result::Result<ProcessEvent, mpsc::TryRecvError> {
        let force_data = self.consecutive_control >= MAX_CONSECUTIVE_CONTROL_EVENTS;
        if force_data {
            match self.take_data() {
                Ok(event) => {
                    return Ok(self.received(event));
                }
                Err(mpsc::TryRecvError::Disconnected) | Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        match self.try_recv_control() {
            Ok(event) => {
                return Ok(event);
            }
            Err(mpsc::TryRecvError::Disconnected) | Err(mpsc::TryRecvError::Empty) => {}
        }
        match self.take_data() {
            Ok(event) => Ok(self.received(event)),
            Err(mpsc::TryRecvError::Empty) => Err(mpsc::TryRecvError::Empty),
            Err(mpsc::TryRecvError::Disconnected) => self.try_recv_control(),
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
    /// 首次入队前接管帧预算；重试和延后队列保留同一 Bytes 所有权。 / Admits once before enqueue; retries and deferred queues retain the same Bytes owner.
    fn reserve_frame(
        &self,
        mut event: ProcessEvent,
    ) -> std::result::Result<ProcessEvent, ProcessIngressTrySendError> {
        if let ProcessEvent::Frame { frame, .. } = &mut event {
            *frame = self
                .stats
                .ingress_buffers
                .try_hold_bytes(std::mem::take(frame))
                .ok_or(ProcessIngressTrySendError::Overloaded)?;
        }
        Ok(event)
    }

    /// 内部RPC使用控制流保留队列，在帧数或共享字节额度满时立即失败，调用方必须把明确错误回复给来源进程。
    /// Inner RPC uses the reserved control queue and fails immediately at count or byte capacity. The caller must
    /// return an explicit error to the source process instead of occupying a pending RPC waiter.
    pub(crate) fn try_send_control(
        &self,
        event: ProcessEvent,
    ) -> std::result::Result<(), ProcessIngressTrySendError> {
        debug_assert_eq!(event.ingress_class(), ProcessIngressClass::Control);
        let event = self.reserve_frame(event)?;
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
        event: ProcessEvent,
        deadline: Option<tokio::time::Instant>,
    ) -> Result<(), String> {
        let mut event = self
            .reserve_frame(event)
            .map_err(|_| "process ingress byte budget is full".to_string())?;
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
    run_runtime_config_with_backend(root, resolved_config, config, create_io_backend).await
}

/// 后端工厂在原有初始化位置调用，使隔离测试可验证同一生产监督/回滚路径。 / Calls the backend factory at the original initialization point so isolated tests exercise production supervision/rollback.
async fn run_runtime_config_with_backend(
    root: &Path,
    resolved_config: &Path,
    config: RuntimeConfig,
    backend_factory: impl FnOnce(
        &crate::config::ProcessNetworkConfig,
    ) -> Result<Arc<dyn crate::transport_backend::IoBackend>>,
) -> Result<()> {
    let runtime_data_packs = load_runtime_data_packs(resolved_config, &config.process.data_packs)?;
    init_remote_transport(Duration::from_millis(
        config.process.network.write_timeout_ms,
    ));
    let runtime_bundles = RuntimeBundles::load(root)?;

    tracing::info!(
        target: "tiangz::runtime",
        version = crate::version::current(),
        hotfix = runtime_bundles.bundle_version(),
        game_config = runtime_bundles.config_fingerprint(),
        process = %config.process.name,
        environment = config.process.environment.as_str(),
        scene_count = config.scenes.len(),
        data_pack_count = runtime_data_packs.len(),
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
    let queue_stats = Arc::new(ProcessQueueStats::with_network_limits(
        event_queue_capacity,
        &config.process.network,
    ));
    let writers: ConnectionWriters = Arc::new(Mutex::new(HashMap::new()));
    let event_tx = ProcessEventSender {
        control_sender: control_tx,
        data_sender: data_tx,
        wake_sender: wake_tx,
        stats: Arc::clone(&queue_stats),
    };
    let event_rx = ProcessEventReceiver::new(control_rx, data_rx, wake_rx);
    let runtime_stale_after = config
        .process
        .observability
        .as_ref()
        .and_then(|observability| observability.health.as_ref())
        .map(|health| Duration::from_millis(health.stale_after_ms.max(1)))
        .unwrap_or_else(|| Duration::from_secs(15));
    let health_state = Arc::new(ProcessHealthState::starting(runtime_stale_after));
    health_state.set_runtime_data_packs(&runtime_data_packs);
    health_state.set_process_environment(config.process.environment);
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

    let io_backend = backend_factory(&config.process.network)?;
    tracing::info!(
        target: "tiangz::transport",
        process = %config.process.name,
        io_backend = io_backend.name(),
        "process I/O backend selected"
    );
    let stop_budget = Duration::from_millis(config.process.lifecycle.stop_timeout_ms);
    let mut endpoints = FuturesUnordered::new();
    for (scene_index, scene) in config.scenes.iter().cloned().enumerate() {
        let endpoint = io_backend.start_endpoint(EndpointContext {
            shutdown_timeout: stop_budget,
            write_timeout: Duration::from_millis(config.process.network.write_timeout_ms),
            scene_index: scene_index as u32,
            scene,
            event_tx: event_tx.clone(),
            writers: Arc::clone(&writers),
            next_connection_id: Arc::clone(&next_connection_id),
            stats: Arc::clone(&queue_stats),
        });
        match endpoint {
            Ok(endpoint) => endpoints.push(endpoint),
            Err(error) => {
                health_state.mark_stopping();
                if let Err(cleanup) = stop_endpoints(&mut endpoints, stop_budget).await {
                    tracing::warn!(target: "tiangz::transport", error = ?cleanup, "endpoint startup rollback failed");
                }
                if let Some(server) = health_server {
                    server.stop().await;
                }
                return Err(error).context("failed to start process endpoints");
            }
        }
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
            runtime_data_packs,
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
    let mut supervision_error = None;
    let runtime_exited_early = loop {
        tokio::select! {
            result = &mut shutdown_signal => {
                supervision_error = result.err();
                break false;
            }
            _ = &mut runtime_exit_rx => break true,
            result = endpoints.next(), if !endpoints.is_empty() => {
                supervision_error = Some(match result {
                    Some(Err(error)) => error,
                    _ => anyhow::anyhow!("network endpoint exited unexpectedly"),
                });
                break false;
            }
            command = receive_parent_control(&mut parent_control) => {
                let command = match command {
                    Ok(command) => command,
                    Err(error) => {
                        supervision_error = Some(error);
                        break false;
                    }
                };
                match command {
                    ParentControlCommand::Shutdown => break false,
                    ParentControlCommand::Reload(candidate_directory) | ParentControlCommand::ReloadConfig(candidate_directory) => {
                        let candidate_directory = if candidate_directory.is_absolute() {
                            candidate_directory
                        } else {
                            root.join(candidate_directory)
                        };
                        let (response, completed) = tokio::sync::oneshot::channel();
                        if runtime_control_tx
                            .send(RuntimeControl::ReloadHotfix {
                                candidate_directory,
                                requested_at: Instant::now(),
                                response,
                            })
                            .is_err() {
                            supervision_error = Some(anyhow::anyhow!("V8 runtime control channel is stopped"));
                            break false;
                        }
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

                }
            }
        }
    };
    health_state.mark_stopping();
    for endpoint in endpoints.iter() {
        endpoint.request_stop();
    }
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
    let (runtime_join, network_result) = tokio::join!(
        tokio::task::spawn_blocking(move || runtime_thread.join()),
        stop_endpoints(&mut endpoints, stop_budget),
    );
    if let Some(server) = health_server {
        server.stop().await;
    }
    if let Some(error) = supervision_error {
        return Err(error).context("process supervision failed; shutdown completed");
    }
    let runtime_result = runtime_join
        .context("failed to join process runtime task")?
        .map_err(|_| anyhow::anyhow!("process runtime thread panicked"))?;
    if runtime_exited_early {
        runtime_result.context("V8 runtime failed before process shutdown was requested")?;
        bail!("V8 runtime exited unexpectedly before process shutdown was requested");
    }
    runtime_result?;
    network_result?;
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
    runtime_data_packs: Vec<LoadedRuntimeDataPack>,
    mut event_rx: ProcessEventReceiver,
    runtime_control_rx: mpsc::Receiver<RuntimeControl>,
    writers: ConnectionWriters,
    queue_stats: Arc<ProcessQueueStats>,
    host_runtime: tokio::runtime::Handle,
    completion_sink: crate::host::HostSceneCompletionSink,
    health_state: Arc<ProcessHealthState>,
) -> Result<()> {
    crate::module_native::configure_project_root(&project_root)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let process_name = process.name.clone();
    let scheduling = RuntimeScheduling::from_process(&process);
    let js_event_loop = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("failed to create JS event loop runtime")?;
    configure_host_scene_bridge(
        host_runtime.clone(),
        completion_sink,
        Arc::clone(&queue_stats.outbound_buffers),
    );
    crate::event_stream::configure(&process, host_runtime.clone())?;
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
    health_state.record_initial_game_config(runtime_bundles.config_fingerprint().to_string());

    let process_config = json!({
        "process": process,
        "scenes": scenes,
        "knownScenes": known_scenes,
        "tickMs": process.game.fixed_update_ms,
        "dataPacks": runtime_data_packs,
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
    let runtime_bundles = Arc::new(runtime_bundles);
    let mut preparing: Option<thread::JoinHandle<Result<PreparedHotfix>>> = None;
    let mut prepared: Option<PreparedHotfix> = None;
    let mut drain_started: Option<Instant> = None;
    let mut deferred_control = VecDeque::new();
    let mut pause_overflow = false;
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
                        let bundles = Arc::clone(&runtime_bundles);
                        let directory = candidate_directory.clone();
                        let log_level = crate::logging::typescript_min_level(&process.logging);
                        match thread::Builder::new()
                            .name("hotfix-preflight".into())
                            .spawn(move || prepare_hotfix_reload(&bundles, &directory, log_level))
                        {
                            Ok(worker) => {
                                preparing = Some(worker);
                                pending_reload =
                                    Some((candidate_directory, requested_at, response));
                            }
                            Err(error) => {
                                health_state.record_hotfix_failure();
                                let _ = response.send(Err(format!(
                                    "failed to start Hotfix preflight: {error}"
                                )));
                            }
                        }
                    }
                }
            }
        }

        if preparing
            .as_ref()
            .is_some_and(|worker| worker.is_finished())
        {
            let result = preparing
                .take()
                .unwrap()
                .join()
                .unwrap_or_else(|_| Err(anyhow::anyhow!("Hotfix preflight worker panicked")));
            match result {
                Ok(candidate) => {
                    prepared = Some(candidate);
                    drain_started = Some(Instant::now());
                    tracing::info!(target: "tiangz::hotfix", "Hotfix ingress pause started");
                }
                Err(error) => {
                    if let Some((_, _, response)) = pending_reload.take() {
                        health_state.record_hotfix_failure();
                        let _ = response.send(Err(format!("{error:#}")));
                    }
                }
            }
        }

        // 为同步提交留少量余量；同步V8执行不能靠此预算强行中断。
        // Reserve time for synchronous commit; this budget cannot interrupt synchronous V8 code.
        let drain_budget = hotfix_reload_timeout
            .saturating_sub(Duration::from_millis(100).min(hotfix_reload_timeout / 10));
        if (pause_overflow
            || drain_started.is_some_and(|started| started.elapsed() >= drain_budget)
            || (preparing.is_none()
                && pending_reload
                    .as_ref()
                    .is_some_and(|(_, _, reply)| reply.is_closed())))
            && let Some((candidate_directory, _, response)) = pending_reload.take()
        {
            let reason = if pause_overflow {
                "deferred inner request capacity reached"
            } else if response.is_closed() {
                "operation caller disconnected"
            } else {
                "drain deadline exceeded"
            };
            let pause_ms = drain_started.map(elapsed_ms).unwrap_or_default();
            prepared = None;
            drain_started = None;
            pause_overflow = false;
            tracing::warn!(target: "tiangz::hotfix", reason, pause_ms, pending_async, pending_ingress, deferred_requests = deferred_control.len(), "Hotfix ingress pause aborted; previous release resumed");
            health_state.record_hotfix_failure();
            let _ = response.send(Err(format!(
                "Hotfix candidate {} rejected: {reason}; window={}ms pause={pause_ms:.1}ms pendingAsync={pending_async} pendingIngress={pending_ingress} deferredRequests={}",
                candidate_directory.display(),
                hotfix_reload_timeout.as_millis(),
                deferred_control.len(),
            )));
            continue;
        }

        if prepared.is_some()
            && !pending_async
            && !pending_ingress
            && let Some((_, requested_at, response)) = pending_reload.take()
        {
            let next_generation = active_generation + 1;
            let result = execute_hotfix_reload(
                prepared.take().unwrap(),
                &js_event_loop,
                &mut runtime,
                &entrypoints,
                requested_at,
                drain_started.take().unwrap(),
                next_generation,
            );
            tracing::info!(target: "tiangz::hotfix", success = result.is_ok(), "Hotfix ingress resumed");
            if let Ok(report) = &result {
                active_generation = next_generation;
                health_state.record_game_config_success(
                    report.config_fingerprint.clone(),
                    report.commit_ms,
                    report.reload_total_ms,
                );
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
                Err(_) => {
                    health_state.record_hotfix_failure();
                    health_state.record_game_config_failure();
                }
            }
            let _ = response.send(result.map_err(|error| format!("{error:#}")));
            continue;
        }

        let mut events = HostEventBatch::new();
        let mut batch_full = false;
        let mut shutdown_requested = false;
        let wait_ms = scheduling.idle_tick_ms;
        let batch_capacity = scheduling.batch_capacity(queue_stats.depth.load(Ordering::Relaxed));
        // 内部RPC请求也可能是新业务；暂存有界请求，完成通知仍走控制通道。
        // Inner RPC requests can start new business too; defer them boundedly while completions flow.
        if drain_started.is_none() {
            while events.len() < batch_capacity as u32 {
                let Some(event) = deferred_control.pop_front() else {
                    break;
                };
                if let Some(event) = events.try_push(event, &queue_stats)? {
                    deferred_control.push_front(event);
                    batch_full = true;
                    break;
                }
            }
        }
        if pending_ingress || drain_started.is_some() {
            // TS still has data ingress queued. Keep the control lane flowing so Probe,
            // disconnect, and completion responses cannot be rejected behind a data backlog.
            // Bound reinjection so the TS pump retains capacity to drain its existing queue.
            let control_capacity = batch_capacity.min(MAX_PENDING_INGRESS_CONTROL_EVENTS);
            while !batch_full && events.len() < control_capacity as u32 {
                match event_rx.try_recv_control() {
                    Ok(event) => {
                        if drain_started.is_some() && matches!(&event, ProcessEvent::Frame { .. }) {
                            queue_stats.dequeue(event.kind(), event.ingress_class());
                            deferred_control.push_back(event);
                            if deferred_control.len() >= MAX_PENDING_INGRESS_CONTROL_EVENTS {
                                pause_overflow = true;
                                break;
                            }
                            continue;
                        }
                        if matches!(&event, ProcessEvent::Shutdown) {
                            queue_stats.dequeue(event.kind(), event.ingress_class());
                            shutdown_requested = true;
                            break;
                        }
                        if !push_received_event(&mut events, &mut event_rx, event, &queue_stats)? {
                            break;
                        }
                    }
                    Err(mpsc::TryRecvError::Empty | mpsc::TryRecvError::Disconnected) => break,
                }
            }
        } else if events.len() == 0 {
            match event_rx.recv_timeout(Duration::from_millis(wait_ms)) {
                Ok(event) => {
                    if matches!(&event, ProcessEvent::Shutdown) {
                        queue_stats.dequeue(event.kind(), event.ingress_class());
                        shutdown_requested = true;
                    } else {
                        batch_full =
                            !push_received_event(&mut events, &mut event_rx, event, &queue_stats)?;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        let coalesce_deadline = scheduling
            .coalesce_deadline(queue_stats.depth.load(Ordering::Relaxed) + events.len() as usize);
        while !batch_full
            && !pending_ingress
            && drain_started.is_none()
            && !shutdown_requested
            && events.len() < batch_capacity as u32
        {
            match event_rx.try_recv() {
                Ok(event) => {
                    if matches!(&event, ProcessEvent::Shutdown) {
                        queue_stats.dequeue(event.kind(), event.ingress_class());
                        shutdown_requested = true;
                        break;
                    }
                    if !push_received_event(&mut events, &mut event_rx, event, &queue_stats)? {
                        break;
                    }
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
            events,
            &process_name,
            &mut last_metrics_log,
            &queue_stats,
            &mut system,
            process_pid,
            &gc_metrics,
            &mut last_process_cpu_time_ms,
            &mut last_resource_sample_at,
            &health_state,
            drain_started.is_some(),
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
    let pending_stop = call_js_stop_process(&js_event_loop, &mut runtime, &entrypoints)
        .context("failed to begin TypeScript shutdown")?;
    let stop_deadline =
        Instant::now() + Duration::from_millis(process.lifecycle.stop_timeout_ms + 1000);
    let stop_result = loop {
        let mut completions = HostEventBatch::new();
        // 关闭监听后只接收已有RPC的完成事件；新业务帧不进入停机中的Scene。 / After listeners close, drain existing RPC completions without admitting business frames.
        for _ in 0..MAX_PENDING_INGRESS_CONTROL_EVENTS {
            let Ok(event) = event_rx.try_recv_control() else {
                break;
            };
            if matches!(&event, ProcessEvent::HostSceneCompletion(_)) {
                if !push_received_event(&mut completions, &mut event_rx, event, &queue_stats)? {
                    break;
                }
            } else {
                queue_stats.dequeue(event.kind(), event.ingress_class());
            }
        }
        if completions.len() > 0 {
            call_js_push_host_events(
                &mut runtime,
                &entrypoints,
                completions.into_bytes(&queue_stats),
            )?;
        }
        pump_js_event_loop_once(&js_event_loop, &mut runtime)?;
        // 停机模式的Update只提交RPC队列，不运行游戏Tick。 / Shutdown updates submit RPC queues without running gameplay ticks.
        call_js_update_binary(&js_event_loop, &mut runtime, &entrypoints, false, false)?;
        if let Some(result) = poll_js_stop_process(&mut runtime, &pending_stop)? {
            break result;
        }
        if Instant::now() >= stop_deadline {
            bail!("TypeScript shutdown exceeded its host drain deadline");
        }
        thread::sleep(Duration::from_millis(1));
    };
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

struct PreparedHotfix {
    candidate: HotfixCandidate,
    directory: PathBuf,
    validation_ms: f64,
    preflight_ms: f64,
}

/// 在独立线程校验并预检不可变候选，不暂停正在服务的V8。 / Validates and preflights an immutable candidate off-thread without pausing the serving V8.
fn prepare_hotfix_reload(
    runtime_bundles: &RuntimeBundles,
    candidate_directory: &Path,
    typescript_log_level: u8,
) -> Result<PreparedHotfix> {
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
    let js_event_loop = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    {
        let mut preflight_runtime = {
            let _guard = js_event_loop.enter();
            create_runtime(false, typescript_log_level)
                .context("failed to create isolated Hotfix reload preflight V8")?
        };
        runtime_bundles
            .preflight_candidate(&js_event_loop, &mut preflight_runtime, &candidate)
            .context("isolated Hotfix reload preflight failed")?;
    }
    let preflight_ms = elapsed_ms(preflight_at);
    Ok(PreparedHotfix {
        candidate,
        directory: candidate_directory,
        validation_ms,
        preflight_ms,
    })
}

/// 排空后在帧间提交已预检的代码和配置；不重新读取候选文件。 / Commits the preflighted code/config pair between drained frames without rereading candidate files.
fn execute_hotfix_reload(
    prepared: PreparedHotfix,
    js_event_loop: &tokio::runtime::Runtime,
    runtime: &mut deno_core::JsRuntime,
    entrypoints: &crate::host::JsEntrypoints,
    requested_at: Instant,
    drain_started: Instant,
    generation: u64,
) -> Result<HotfixReloadReport> {
    let PreparedHotfix {
        candidate,
        directory: candidate_directory,
        validation_ms,
        preflight_ms,
    } = prepared;
    let barrier_wait_ms = elapsed_ms(drain_started);
    let install: HotfixInstallResult = candidate.install(js_event_loop, runtime, entrypoints)?;
    Ok(HotfixReloadReport {
        candidate_directory: candidate_directory.display().to_string(),
        bundle_version: install.bundle_version,
        config_fingerprint: candidate.config_fingerprint().to_string(),
        generation,
        validation_ms,
        preflight_ms,
        barrier_wait_ms,
        begin_ms: install.timings.begin_ms,
        candidate_eval_ms: install.timings.candidate_eval_ms,
        commit_ms: install.timings.commit_ms,
        reload_total_ms: elapsed_ms(requested_at),
        pause_ms: elapsed_ms(drain_started),
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
    events: HostEventBatch,
    process_name: &str,
    last_metrics_log: &mut Instant,
    queue_stats: &ProcessQueueStats,
    system: &mut System,
    process_pid: Pid,
    gc_metrics: &V8GcMetrics,
    last_process_cpu_time_ms: &mut u64,
    last_resource_sample_at: &mut Instant,
    health_state: &ProcessHealthState,
    hotfix_draining: bool,
) -> Result<(bool, bool)> {
    let event_count = events.len();
    queue_stats.runtime_updates.fetch_add(1, Ordering::Relaxed);
    queue_stats
        .runtime_events
        .fetch_add(event_count as u64, Ordering::Relaxed);
    queue_stats
        .max_runtime_batch
        .fetch_max(event_count as usize, Ordering::Relaxed);
    if event_count > 0 {
        call_js_push_host_events(runtime, entrypoints, events.into_bytes(queue_stats))?;
    }
    pump_js_event_loop_once(js_event_loop, runtime)?;

    let sample_metrics = last_metrics_log.elapsed() >= Duration::from_secs(5);
    let (update_result, outbound) = call_js_update_binary(
        js_event_loop,
        runtime,
        entrypoints,
        sample_metrics,
        hotfix_draining,
    )?;
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

/// 满批退回接收通道队首，只有实际接受后才扣队列深度。 / Returns a full-batch event to its lane head, decrementing depth only after acceptance.
fn push_received_event(
    events: &mut HostEventBatch,
    receiver: &mut ProcessEventReceiver,
    event: ProcessEvent,
    queue_stats: &ProcessQueueStats,
) -> Result<bool> {
    let kind = event.kind();
    let class = event.ingress_class();
    match events.try_push(event, queue_stats) {
        Ok(Some(event)) => {
            receiver.return_front(event);
            return Ok(false);
        }
        Err(error) => {
            queue_stats.dequeue(kind, class);
            return Err(error);
        }
        Ok(None) => {}
    }
    queue_stats.dequeue(kind, class);
    Ok(true)
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
    let mut failed_connections = HashMap::new();
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
                && let Err(error) = try_queue_connection_frame(writer, batch.frame.clone())
            {
                failed_connections.entry(connection_id).or_insert(error);
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
                if let Err(error) = try_queue_connection_batch(writer, batch) {
                    failed_connections.entry(connection_id).or_insert(error);
                    break;
                }
                pending = Vec::with_capacity(WRITE_BATCH_FRAME_CAPACITY);
                pending_bytes = 0;
            }
            pending_bytes += frame.len();
            pending.push(frame);
        }
        if !pending.is_empty()
            && !failed_connections.contains_key(&connection_id)
            && let Err(error) =
                try_queue_connection_batch(writer, ConnectionWriteBatch::from_frames(pending))
        {
            failed_connections.entry(connection_id).or_insert(error);
        }
    }

    let mut failed_connections: Vec<_> = failed_connections.into_iter().collect();
    failed_connections.sort_unstable_by_key(|(connection_id, _)| *connection_id);
    for (connection_id, error) in failed_connections {
        if let Some(writer) = writers.remove(&connection_id) {
            let _ = writer.shutdown_tx.send(true);
            if error == ConnectionQueueError::Closed {
                tracing::debug!(target: "tiangz::transport", connection_id,
                    "removing connection whose outbound receiver is closed");
            } else if error == ConnectionQueueError::ProcessByteLimit {
                tracing::warn!(target: "tiangz::transport", connection_id, reason = %error,
                    "closing connection: shared process outbound payload budget exceeded");
            } else {
                queue_stats
                    .slow_client_disconnects
                    .fetch_add(1, Ordering::Relaxed);
                tracing::warn!(target: "tiangz::transport", connection_id, reason = %error,
                    "closing slow connection: outbound queue limit exceeded");
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_buffer_pressure_closes_rejected_recipient_without_blaming_slow_clients() {
        let network = crate::config::ProcessNetworkConfig {
            max_outbound_buffered_bytes: 2,
            ..Default::default()
        };
        let stats = ProcessQueueStats::with_network_limits(16, &network);
        let writers = Arc::new(Mutex::new(HashMap::new()));
        let mut receivers = Vec::new();
        let mut shutdowns = Vec::new();
        for id in 1..=2 {
            let (sender, receiver) = tokio::sync::mpsc::channel(1);
            let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
            writers.lock().unwrap().insert(
                id,
                ConnectionWriter {
                    process_buffer_budget: stats.outbound_buffers.clone(),
                    sender,
                    shutdown_tx,
                    queued_bytes: Arc::new(AtomicUsize::new(0)),
                    queued_frames: Arc::new(AtomicUsize::new(0)),
                },
            );
            receivers.push(receiver);
            shutdowns.push(shutdown_rx);
        }
        flush_outbound(
            vec![BinaryOutboundBatch {
                connection_ids: vec![1, 2],
                frame: Bytes::from_static(&[0, 1]),
            }],
            &writers,
            &stats,
        )
        .unwrap();
        assert_eq!(writers.lock().unwrap().len(), 1);
        assert!(writers.lock().unwrap().contains_key(&1));
        assert!(!*shutdowns[0].borrow());
        assert!(*shutdowns[1].borrow());
        assert_eq!(stats.slow_client_disconnects.load(Ordering::Relaxed), 0);
        assert_eq!(stats.outbound_buffers.snapshot().used_bytes, 2);
        assert_eq!(stats.outbound_buffers.snapshot().rejections, 1);
        drop(receivers);
        assert_eq!(stats.outbound_buffers.snapshot().used_bytes, 0);
    }

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
        let mut receiver =
            ProcessEventReceiver::new(control_receiver, data_receiver, wake_receiver);

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
        let mut receiver =
            ProcessEventReceiver::new(control_receiver, data_receiver, wake_receiver);

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
                    internal: true,
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
    fn outer_rpc_cannot_bypass_hotfix_pause_by_carrying_rpc_id() {
        // protobuf field 90 (rpcId) = 1; identity comes from the accepted endpoint.
        let frame = Bytes::from_static(&[0x9c, 0x40, 0xd0, 0x05, 0x01]);
        assert_eq!(crate::transport::inner_frame_rpc_id(&frame), Some(1));
        let outer = ProcessEvent::Frame {
            scene_index: 0,
            connection_id: 1,
            internal: false,
            frame: frame.clone(),
        };
        let inner = ProcessEvent::Frame {
            scene_index: 0,
            connection_id: 2,
            internal: true,
            frame,
        };
        assert_eq!(outer.ingress_class(), ProcessIngressClass::Data);
        assert_eq!(inner.ingress_class(), ProcessIngressClass::Control);
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
                process_buffer_budget: tiangz_transport::buffer_budget::BufferBudget::new(
                    64 * 1024 * 1024,
                ),
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
    fn closed_connection_is_not_counted_as_slow() {
        for recipient_count in [1, WRITE_BATCH_FRAME_CAPACITY + 1] {
            let writers: ConnectionWriters = Arc::new(Mutex::new(HashMap::new()));
            let (sender, receiver) = tokio_mpsc::channel(1);
            drop(receiver);
            let (shutdown_tx, shutdown_rx) = watch::channel(false);
            let queued_bytes = Arc::new(AtomicUsize::new(0));
            let queued_frames = Arc::new(AtomicUsize::new(0));
            writers.lock().unwrap().insert(
                7,
                ConnectionWriter {
                    process_buffer_budget: tiangz_transport::buffer_budget::BufferBudget::new(
                        64 * 1024 * 1024,
                    ),
                    sender,
                    queued_bytes: Arc::clone(&queued_bytes),
                    queued_frames: Arc::clone(&queued_frames),
                    shutdown_tx,
                },
            );
            let stats = ProcessQueueStats::default();
            flush_outbound(
                vec![BinaryOutboundBatch {
                    connection_ids: vec![7; recipient_count],
                    frame: Bytes::from_static(&[0, 1]),
                }],
                &writers,
                &stats,
            )
            .unwrap();
            assert!(!writers.lock().unwrap().contains_key(&7));
            assert!(*shutdown_rx.borrow());
            assert_eq!(queued_bytes.load(Ordering::Relaxed), 0);
            assert_eq!(queued_frames.load(Ordering::Relaxed), 0);
            assert_eq!(stats.slow_client_disconnects.load(Ordering::Relaxed), 0);
        }
    }

    #[test]
    fn requested_connection_is_removed_and_signaled() {
        let writers: ConnectionWriters = Arc::new(Mutex::new(HashMap::new()));
        let (sender, _receiver) = tokio_mpsc::channel(1);
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        writers.lock().unwrap().insert(
            7,
            ConnectionWriter {
                process_buffer_budget: tiangz_transport::buffer_budget::BufferBudget::new(
                    64 * 1024 * 1024,
                ),
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
                    process_buffer_budget: tiangz_transport::buffer_budget::BufferBudget::new(
                        64 * 1024 * 1024,
                    ),
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
                process_buffer_budget: tiangz_transport::buffer_budget::BufferBudget::new(
                    64 * 1024 * 1024,
                ),
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

        assert_eq!(queued_frames.load(Ordering::Relaxed), 3);
        assert_eq!(queued_bytes.load(Ordering::Relaxed), 6);
        assert_eq!(receiver.try_recv().unwrap().frames[0].as_ref(), [0, 1]);
        assert_eq!(receiver.try_recv().unwrap().frames[0].as_ref(), [0, 2]);
        assert_eq!(receiver.try_recv().unwrap().frames[0].as_ref(), [0, 3]);
        assert!(receiver.try_recv().is_err());
        assert_eq!(queued_frames.load(Ordering::Relaxed), 0);
        assert_eq!(queued_bytes.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn outbound_connection_batches_preserve_frame_capacity() {
        let writers: ConnectionWriters = Arc::new(Mutex::new(HashMap::new()));
        let (sender, mut receiver) = tokio_mpsc::channel(4);
        let (shutdown_tx, _shutdown_rx) = watch::channel(false);
        writers.lock().unwrap().insert(
            7,
            ConnectionWriter {
                process_buffer_budget: tiangz_transport::buffer_budget::BufferBudget::new(
                    64 * 1024 * 1024,
                ),
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
        let stats = ProcessQueueStats::default();
        let mut batch = HostEventBatch::new();
        assert!(
            batch
                .try_push(
                    ProcessEvent::Frame {
                        connection_id: 7,
                        scene_index: 3,
                        internal: false,
                        frame: Bytes::from_static(&[10, 11]),
                    },
                    &stats
                )
                .unwrap()
                .is_none()
        );
        let packed = batch.into_bytes(&stats);

        assert_eq!(&packed[0..4], &1_u32.to_le_bytes());
        assert_eq!(packed[4], 1);
        assert_eq!(&packed[5..9], &7_u32.to_le_bytes());
        assert_eq!(&packed[9..13], &3_u32.to_le_bytes());
        assert_eq!(&packed[13..17], &2_u32.to_le_bytes());
        assert_eq!(&packed[17..], &[10, 11]);
    }
}
