//! 提供独立于业务端点的进程存活与就绪探针。 / Provides process liveness and readiness probes independently from business endpoints.

mod metrics;
use metrics::format_prometheus_metrics;

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use crate::config::{HealthObservabilityConfig, HotfixOperationsConfig, ProcessEnvironment};
use crate::data_pack::{LoadedRuntimeDataPack, RuntimeDataPackIdentity};
use crate::process::RuntimeControl;

const MAX_HTTP_REQUEST_BYTES: usize = 16 * 1024;

pub(crate) struct ProcessHealthState {
    live: AtomicBool,
    runtime_ready: AtomicBool,
    endpoints_ready: AtomicBool,
    stopping: AtomicBool,
    started_at: Instant,
    runtime_heartbeat_at: Mutex<Instant>,
    runtime_stale_after: Duration,
    observability_snapshot: Mutex<ProcessObservabilitySnapshot>,
    hotfix_snapshot: Mutex<HotfixObservabilitySnapshot>,
    game_config_snapshot: Mutex<GameConfigObservabilitySnapshot>,
    runtime_data_packs: OnceLock<Vec<RuntimeDataPackIdentity>>,
    environment: OnceLock<ProcessEnvironment>,
}

#[derive(Debug, Clone, Default)]
struct HotfixObservabilitySnapshot {
    active_generation: u64,
    successes: u64,
    failures: u64,
    bundle_version: String,
    model_contract: Value,
    active_candidate_directory: String,
    previous_candidate_directory: Option<String>,
    operation_phase: String,
    last_operation_id: Option<String>,
    last_operation_kind: Option<String>,
    last_operation_error: Option<String>,
    validation_ms: f64,
    preflight_ms: f64,
    barrier_wait_ms: f64,
    candidate_eval_ms: f64,
    commit_ms: f64,
    reload_total_ms: f64,
}

#[derive(Debug, Clone, Default)]
struct GameConfigObservabilitySnapshot {
    data_fingerprint: String,
    successes: u64,
    failures: u64,
    commit_ms: f64,
    reload_total_ms: f64,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ProcessObservabilitySnapshot {
    pub(crate) sample_timestamp_ms: u64,
    pub(crate) cpu_percent: f64,
    pub(crate) cpu_time_ms: u64,
    pub(crate) rss_bytes: u64,
    pub(crate) v8_heap_used_bytes: u64,
    pub(crate) v8_heap_total_bytes: u64,
    pub(crate) v8_gc_count: u64,
    pub(crate) v8_gc_ms: f64,
    pub(crate) dropped_logs: u64,
    pub(crate) backpressure_waits: u64,
    pub(crate) slow_client_disconnects: u64,
    pub(crate) inbound_frames: u64,
    pub(crate) host_completions: u64,
    pub(crate) disconnects: u64,
    pub(crate) runtime_updates: u64,
    pub(crate) runtime_events: u64,
    pub(crate) max_runtime_batch: u64,
    pub(crate) host_event_batch_limit_bytes: u64,
    pub(crate) max_host_event_batch_bytes: u64,
    pub(crate) host_event_batch_splits: u64,
    pub(crate) host_backing_store: crate::host::event_buffer::HostBackingStoreSnapshot,
    pub(crate) host_event_buffers: tiangz_transport::buffer_budget::BufferBudgetSnapshot,
    pub(crate) host_disconnect_buffers: crate::process::control_ingress::ControlAdmissionSnapshot,
    pub(crate) outbound_batches: u64,
    pub(crate) outbound_recipients: u64,
    pub(crate) outbound_bridge_bytes: u64,
    pub(crate) outbound_logical_bytes: u64,
    pub(crate) transport_read_ops: u64,
    pub(crate) transport_read_frames: u64,
    pub(crate) transport_read_bytes: u64,
    pub(crate) transport_write_ops: u64,
    pub(crate) transport_write_frames: u64,
    pub(crate) transport_write_bytes: u64,
    pub(crate) active_connections: u64,
    pub(crate) admission: crate::transport_backend::admission::AdmissionSnapshot,
    pub(crate) outbound_buffers: tiangz_transport::buffer_budget::BufferBudgetSnapshot,
    pub(crate) host_scene_batches: crate::host::scene_operations::BatchAdmissionSnapshot,
    pub(crate) control_admission: crate::process::control_ingress::ControlAdmissionSnapshot,
    pub(crate) ingress_buffers: tiangz_transport::buffer_budget::BufferBudgetSnapshot,
    pub(crate) kcp_buffers: tiangz_transport::buffer_budget::BufferBudgetSnapshot,
    pub(crate) remote_transport_active_connections: u64,
    pub(crate) remote_transport_opened_connections: u64,
    pub(crate) remote_transport_pending_calls: u64,
    pub(crate) remote_transport_max_pending_calls: u64,
    pub(crate) remote_transport_overload_rejections: u64,
    pub(crate) remote_transport_timed_out_calls: u64,
    pub(crate) remote_transport_disconnected_calls: u64,
    pub(crate) remote_transport_late_responses: u64,
    pub(crate) remote_transport_idle_closes: u64,
    pub(crate) remote_transport_overload_stages: Vec<TransportOverloadStageObservabilitySnapshot>,
    pub(crate) remote_transport_diagnostics: Vec<TransportDiagnosticObservabilitySnapshot>,
    pub(crate) queue_depth: u64,
    pub(crate) queue_capacity: u64,
    pub(crate) queue_max_depth: u64,
    pub(crate) queue_stages: Vec<ProcessQueueStageObservabilitySnapshot>,
    /// 进程级 Actor mailbox 总计；不能复制到每个 Scene 的标签序列。 / Process-wide Actor mailbox totals; never duplicate them into Scene-labelled series.
    pub(crate) actor_mailbox: MailboxObservabilitySnapshot,
    pub(crate) scenes: Vec<SceneObservabilitySnapshot>,
    pub(crate) game: Option<GameObservabilitySnapshot>,
    pub(crate) native_data: Option<NativeDataObservabilitySnapshot>,
    pub(crate) dbproxy: Option<DbProxyClientObservabilitySnapshot>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct DbProxyClientObservabilitySnapshot {
    pub(crate) endpoints: Vec<DbProxyEndpointObservabilitySnapshot>,
    pub(crate) failovers: Vec<DbProxyFailoverObservabilitySnapshot>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct DbProxyEndpointObservabilitySnapshot {
    pub(crate) endpoint: String,
    pub(crate) selected: bool,
    pub(crate) connection_attempts: u64,
    pub(crate) connection_failures: u64,
    pub(crate) connection_duration_seconds: f64,
    pub(crate) request_attempts: u64,
    pub(crate) request_failures: u64,
    pub(crate) request_duration_seconds: f64,
    pub(crate) request_latencies: Vec<LatencyObservabilitySnapshot>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct DbProxyFailoverObservabilitySnapshot {
    pub(crate) from_endpoint: String,
    pub(crate) to_endpoint: String,
    pub(crate) count: u64,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct TransportOverloadStageObservabilitySnapshot {
    pub(crate) stage: String,
    pub(crate) rejections: u64,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct TransportDiagnosticObservabilitySnapshot {
    pub(crate) msgcode: u16,
    pub(crate) source: String,
    pub(crate) target: String,
    pub(crate) traffic: String,
    pub(crate) stage: String,
    pub(crate) overloads: u64,
    pub(crate) timeouts: u64,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ProcessQueueStageObservabilitySnapshot {
    pub(crate) stage: String,
    pub(crate) depth: u64,
    pub(crate) max_depth: u64,
    pub(crate) backpressure_waits: u64,
    pub(crate) backpressure_wait_ms: f64,
    pub(crate) max_backpressure_wait_ms: f64,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct SceneObservabilitySnapshot {
    pub(crate) scene: String,
    pub(crate) scene_type: String,
    pub(crate) processed_frames: u64,
    pub(crate) failed_frames: u64,
    pub(crate) protocol_successes: u64,
    pub(crate) business_errors: u64,
    pub(crate) system_errors: u64,
    pub(crate) decode_errors: u64,
    pub(crate) handler_not_found: u64,
    pub(crate) message_handler_failures: u64,
    pub(crate) ingress_queue_length: u64,
    pub(crate) max_ingress_queue_length: u64,
    pub(crate) last_ingress_pump_frames: u64,
    pub(crate) last_ingress_pump_cost_ms: f64,
    pub(crate) async_in_flight: u64,
    pub(crate) max_async_in_flight: u64,
    pub(crate) mailbox: MailboxObservabilitySnapshot,
    pub(crate) last_update_cost_ms: f64,
    pub(crate) last_handler_cost_ms: f64,
    pub(crate) max_handler_cost_ms: f64,
    pub(crate) total_handler_cost_ms: f64,
    pub(crate) latencies: Vec<LatencyObservabilitySnapshot>,
    pub(crate) custom_metrics: Vec<SceneCustomMetricSnapshot>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct MailboxObservabilitySnapshot {
    pub(crate) fast_path_calls: u64,
    pub(crate) queued_calls: u64,
    pub(crate) async_calls: u64,
    pub(crate) one_way_fast_path_calls: u64,
    pub(crate) one_way_queued_calls: u64,
    pub(crate) one_way_async_calls: u64,
    pub(crate) queued_depth: u64,
    pub(crate) max_queued_depth: u64,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct SceneCustomMetricSnapshot {
    pub(crate) name: String,
    pub(crate) labels: BTreeMap<String, String>,
    pub(crate) values: BTreeMap<String, f64>,
    pub(crate) kinds: BTreeMap<String, SceneCustomMetricKind>,
}

#[derive(Debug, Clone, Copy, Default, Eq, PartialEq)]
pub(crate) enum SceneCustomMetricKind {
    Counter,
    #[default]
    Gauge,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct LatencyObservabilitySnapshot {
    pub(crate) name: String,
    pub(crate) msgcode: Option<String>,
    pub(crate) count: u64,
    pub(crate) sum_ms: f64,
    pub(crate) bounds_ms: Vec<f64>,
    pub(crate) bucket_counts: Vec<u64>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct GameObservabilitySnapshot {
    pub(crate) fixed_update_ms: u64,
    pub(crate) frame_count: u64,
    pub(crate) skipped_fixed_updates: u64,
    pub(crate) update_targets: u64,
    pub(crate) update_calls: u64,
    pub(crate) update_failures: u64,
    pub(crate) timers: u64,
    pub(crate) coroutine_lock_waiters: u64,
    pub(crate) coroutine_lock_timeouts: u64,
    pub(crate) scene_task_in_flight: u64,
    pub(crate) scene_task_capacity: u64,
    pub(crate) scene_task_max_in_flight: u64,
    pub(crate) scene_task_rejections: u64,
    pub(crate) actor_mailbox_in_flight: u64,
    pub(crate) actor_mailbox_capacity: u64,
    pub(crate) actor_mailbox_per_actor_capacity: u64,
    pub(crate) actor_mailbox_max_in_flight: u64,
    pub(crate) actor_mailbox_actor_rejections: u64,
    pub(crate) actor_mailbox_process_rejections: u64,
    pub(crate) local_scene_mailbox_in_flight: u64,
    pub(crate) local_scene_mailbox_capacity: u64,
    pub(crate) local_scene_mailbox_per_scene_capacity: u64,
    pub(crate) local_scene_mailbox_max_in_flight: u64,
    pub(crate) local_scene_mailbox_scene_rejections: u64,
    pub(crate) local_scene_mailbox_process_rejections: u64,
    pub(crate) host_scene_queued_operations: u64,
    pub(crate) host_scene_queued_bytes: u64,
    pub(crate) host_scene_pending_replies: u64,
    pub(crate) host_scene_queue_capacity: u64,
    pub(crate) host_scene_queue_byte_capacity: u64,
    pub(crate) host_scene_pending_capacity: u64,
    pub(crate) host_scene_queue_rejections: u64,
    pub(crate) host_scene_byte_rejections: u64,
    pub(crate) host_scene_pending_rejections: u64,
    pub(crate) host_scene_invalid_frames: u64,
    pub(crate) host_scene_submit_failures: u64,
    pub(crate) host_scene_queue_timeouts: u64,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct NativeDataObservabilitySnapshot {
    pub(crate) scalar_gets: u64,
    pub(crate) scalar_sets: u64,
    pub(crate) batch_calls: u64,
    pub(crate) live_entities: u64,
    pub(crate) live_units: u64,
    pub(crate) live_items: u64,
    pub(crate) pool_capacity_bytes: u64,
    pub(crate) scratch_capacity_bytes: u64,
    pub(crate) scratch_growths: u64,
    pub(crate) native_refs: BTreeMap<String, u64>,
    pub(crate) encoded_frames: u64,
    pub(crate) encoded_items: u64,
    pub(crate) encoded_bytes: u64,
    pub(crate) aoi_worlds: u64,
    pub(crate) aoi_entries: u64,
    pub(crate) aoi_grids: u64,
    pub(crate) aoi_candidate_relations: u64,
    pub(crate) aoi_visible_relations: u64,
    pub(crate) aoi_lingering_relations: u64,
    pub(crate) aoi_rejected_relations: u64,
    pub(crate) aoi_relocations: u64,
    pub(crate) aoi_visibility_changes: u64,
    pub(crate) aoi_filter_overrides: u64,
    pub(crate) navigation_assets: u64,
    pub(crate) navigation_worlds: u64,
    pub(crate) numeric_replication: Vec<NativeNumericReplicationObservabilitySnapshot>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct NativeNumericReplicationObservabilitySnapshot {
    pub(crate) numeric_type: u32,
    pub(crate) changes: u64,
    pub(crate) encoded_records: u64,
    pub(crate) recipient_deliveries: u64,
    pub(crate) logical_bytes: u64,
}

impl ProcessHealthState {
    /// 创建启动中状态：宿主存活，但 TS Runtime 与业务端点尚未全部 ready。
    ///
    /// Creates the starting state: the host is live, while TS Runtime and business endpoints
    /// are not ready yet.
    pub(crate) fn starting(runtime_stale_after: Duration) -> Self {
        let now = Instant::now();
        Self {
            live: AtomicBool::new(true),
            runtime_ready: AtomicBool::new(false),
            endpoints_ready: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            started_at: now,
            runtime_heartbeat_at: Mutex::new(now),
            runtime_stale_after,
            observability_snapshot: Mutex::new(ProcessObservabilitySnapshot::default()),
            hotfix_snapshot: Mutex::new(HotfixObservabilitySnapshot {
                active_generation: 1,
                operation_phase: "idle".to_string(),
                ..HotfixObservabilitySnapshot::default()
            }),
            game_config_snapshot: Mutex::new(GameConfigObservabilitySnapshot::default()),
            runtime_data_packs: OnceLock::new(),
            environment: OnceLock::new(),
        }
    }

    /// 在就绪前冻结部署环境，供部署工具核对。 / Freezes the deployment environment before readiness for deployment checks.
    pub(crate) fn set_process_environment(&self, environment: ProcessEnvironment) {
        self.environment
            .set(environment)
            .expect("process environment installed twice");
    }

    /// 在就绪前冻结本进程装载的数据身份，磁盘更新不会改变它。 / Freezes loaded identities before readiness; disk updates cannot change them.
    pub(crate) fn set_runtime_data_packs(&self, packs: &[LoadedRuntimeDataPack]) {
        self.runtime_data_packs
            .set(packs.iter().map(LoadedRuntimeDataPack::identity).collect())
            .expect("runtime data pack identity installed twice");
    }

    /// 标记全部 TS Scene 已完成启动屏障。 / Marks every TS Scene as having completed the startup barrier.
    pub(crate) fn mark_runtime_ready(&self) {
        self.mark_runtime_heartbeat();
        self.runtime_ready.store(true, Ordering::Release);
    }

    /// 标记全部业务监听端点已绑定成功。 / Marks every business listener endpoint as successfully bound.
    pub(crate) fn mark_endpoints_ready(&self) {
        self.endpoints_ready.store(true, Ordering::Release);
    }

    /// 进入停机后立即撤销 ready，但在 V8 线程真正退出前仍保持 live。
    ///
    /// Withdraws readiness immediately when shutdown begins, while keeping liveness true until
    /// the V8 thread actually exits.
    pub(crate) fn mark_stopping(&self) {
        self.stopping.store(true, Ordering::Release);
    }

    /// 标记 V8 业务线程已经退出；此后存活与就绪探针都返回失败。
    ///
    /// Marks the V8 business thread as stopped. Both liveness and readiness fail afterwards.
    pub(crate) fn mark_runtime_stopped(&self) {
        self.live.store(false, Ordering::Release);
        self.runtime_ready.store(false, Ordering::Release);
    }

    pub(crate) fn set_observability_snapshot(&self, snapshot: ProcessObservabilitySnapshot) {
        self.mark_runtime_heartbeat();
        *self
            .observability_snapshot
            .lock()
            .expect("observability snapshot lock poisoned") = snapshot;
    }

    /// 原子发布一次成功 Reload 的 generation 与分段耗时，供 Prometheus 和验收脚本读取。 / Atomically publishes one successful Reload generation and segmented timings for Prometheus and acceptance tests.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn record_hotfix_success(
        &self,
        generation: u64,
        bundle_version: String,
        candidate_directory: String,
        validation_ms: f64,
        preflight_ms: f64,
        barrier_wait_ms: f64,
        candidate_eval_ms: f64,
        commit_ms: f64,
        reload_total_ms: f64,
    ) {
        let mut snapshot = self
            .hotfix_snapshot
            .lock()
            .expect("Hotfix observability lock poisoned");
        snapshot.active_generation = generation;
        snapshot.successes += 1;
        snapshot.bundle_version = bundle_version;
        snapshot.previous_candidate_directory = Some(std::mem::replace(
            &mut snapshot.active_candidate_directory,
            candidate_directory,
        ));
        snapshot.validation_ms = validation_ms;
        snapshot.preflight_ms = preflight_ms;
        snapshot.barrier_wait_ms = barrier_wait_ms;
        snapshot.candidate_eval_ms = candidate_eval_ms;
        snapshot.commit_ms = commit_ms;
        snapshot.reload_total_ms = reload_total_ms;
    }

    /// 发布启动时安装的 generation 1，不把它计入在线 Reload 成功数。 / Publishes startup generation 1 without counting it as an online Reload success.
    pub(crate) fn record_initial_hotfix(
        &self,
        bundle_version: String,
        candidate_directory: String,
        model_contract: Value,
    ) {
        let mut snapshot = self
            .hotfix_snapshot
            .lock()
            .expect("Hotfix observability lock poisoned");
        snapshot.active_generation = 1;
        snapshot.bundle_version = bundle_version;
        snapshot.active_candidate_directory = candidate_directory;
        snapshot.model_contract = model_contract;
    }

    /// 记录被拒绝的候选，不改变 active generation。 / Records a rejected candidate without changing the active generation.
    pub(crate) fn record_hotfix_failure(&self) {
        self.hotfix_snapshot
            .lock()
            .expect("Hotfix observability lock poisoned")
            .failures += 1;
    }

    fn begin_hotfix_operation(
        &self,
        operation_id: &str,
        kind: &str,
    ) -> std::result::Result<(), String> {
        let mut snapshot = self
            .hotfix_snapshot
            .lock()
            .expect("Hotfix observability lock poisoned");
        if snapshot.operation_phase != "idle" {
            return Err(format!(
                "Hotfix operation {} is still {}",
                snapshot.last_operation_id.as_deref().unwrap_or("<unknown>"),
                snapshot.operation_phase,
            ));
        }
        snapshot.operation_phase = kind.to_string();
        snapshot.last_operation_id = Some(operation_id.to_string());
        snapshot.last_operation_kind = Some(kind.to_string());
        snapshot.last_operation_error = None;
        Ok(())
    }

    fn finish_hotfix_operation(&self, error: Option<String>) {
        let mut snapshot = self
            .hotfix_snapshot
            .lock()
            .expect("Hotfix observability lock poisoned");
        snapshot.operation_phase = "idle".to_string();
        snapshot.last_operation_error = error;
    }

    fn hotfix_status_json(&self, process_name: &str) -> Value {
        let snapshot = self
            .hotfix_snapshot
            .lock()
            .expect("Hotfix observability lock poisoned")
            .clone();
        json!({
            "status": "ok",
            "process": process_name,
            "hotfix": {
                "generation": snapshot.active_generation,
                "bundleVersion": snapshot.bundle_version,
                "modelContract": snapshot.model_contract,
                "activeCandidateDirectory": snapshot.active_candidate_directory,
                "previousCandidateDirectory": snapshot.previous_candidate_directory,
                "successes": snapshot.successes,
                "failures": snapshot.failures,
                "operationPhase": snapshot.operation_phase,
                "lastOperationId": snapshot.last_operation_id,
                "lastOperationKind": snapshot.last_operation_kind,
                "lastOperationError": snapshot.last_operation_error,
            }
        })
    }

    fn previous_hotfix_candidate(&self) -> Option<PathBuf> {
        self.hotfix_snapshot
            .lock()
            .expect("Hotfix observability lock poisoned")
            .previous_candidate_directory
            .as_deref()
            .map(PathBuf::from)
    }

    /// 发布启动时配置版本，不计入在线Reload成功数。 / Publishes the startup config version without counting it as an online reload.
    pub(crate) fn record_initial_game_config(&self, data_fingerprint: String) {
        self.game_config_snapshot
            .lock()
            .expect("game config observability lock poisoned")
            .data_fingerprint = data_fingerprint;
    }

    /// 原子记录成功切换后的版本和耗时。 / Atomically records the version and timings after a successful swap.
    pub(crate) fn record_game_config_success(
        &self,
        data_fingerprint: String,
        commit_ms: f64,
        reload_total_ms: f64,
    ) {
        let mut snapshot = self
            .game_config_snapshot
            .lock()
            .expect("game config observability lock poisoned");
        snapshot.data_fingerprint = data_fingerprint;
        snapshot.successes += 1;
        snapshot.commit_ms = commit_ms;
        snapshot.reload_total_ms = reload_total_ms;
    }

    /// 记录失败但保留当前版本。 / Records a failure while preserving the active version.
    pub(crate) fn record_game_config_failure(&self) {
        self.game_config_snapshot
            .lock()
            .expect("game config observability lock poisoned")
            .failures += 1;
    }

    fn observability_snapshot(&self) -> ProcessObservabilitySnapshot {
        self.observability_snapshot
            .lock()
            .expect("observability snapshot lock poisoned")
            .clone()
    }

    fn is_live(&self) -> bool {
        self.live.load(Ordering::Acquire)
    }

    /// 由 V8 业务线程更新心跳；健康 HTTP 线程不得代替业务线程刷新它。
    ///
    /// Refreshes the heartbeat from the V8 business thread. The health HTTP thread must never
    /// refresh it on behalf of a stalled runtime.
    fn mark_runtime_heartbeat(&self) {
        *self
            .runtime_heartbeat_at
            .lock()
            .expect("runtime heartbeat lock poisoned") = Instant::now();
    }

    fn runtime_heartbeat_age(&self) -> Duration {
        self.runtime_heartbeat_at
            .lock()
            .expect("runtime heartbeat lock poisoned")
            .elapsed()
    }

    fn is_runtime_fresh(&self) -> bool {
        self.runtime_heartbeat_age() <= self.runtime_stale_after
    }

    fn is_ready(&self) -> bool {
        self.is_live()
            && self.runtime_ready.load(Ordering::Acquire)
            && self.endpoints_ready.load(Ordering::Acquire)
            && !self.stopping.load(Ordering::Acquire)
            && self.is_runtime_fresh()
    }
}

pub(crate) struct HealthServer {
    shutdown: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Clone)]
struct HotfixOperationsRuntime {
    token: Arc<str>,
    timeout: Duration,
    runtime_control: mpsc::Sender<RuntimeControl>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HotfixOperationRequest {
    operation_id: String,
    #[serde(default)]
    candidate_directory: Option<String>,
}

struct HttpRequest {
    method: String,
    path: String,
    authorization: Option<String>,
    body: Vec<u8>,
}

struct HttpResponse {
    status: &'static str,
    content_type: &'static str,
    body: String,
}

impl HealthServer {
    /// 绑定健康检查端口并启动轻量 HTTP 循环；绑定失败会中止进程启动。
    ///
    /// Binds the health endpoint and starts a lightweight HTTP loop. Bind failure aborts process
    /// startup instead of silently disabling observability.
    pub(crate) async fn start(
        config: &HealthObservabilityConfig,
        hotfix_operations: Option<&HotfixOperationsConfig>,
        hotfix_reload_timeout_ms: u64,
        process_name: String,
        state: Arc<ProcessHealthState>,
        runtime_control: mpsc::Sender<RuntimeControl>,
    ) -> Result<Self> {
        let hotfix_operations = hotfix_operations
            .map(|operations| {
                let token = std::env::var(&operations.auth_token_env).with_context(|| {
                    format!(
                        "Hotfix operations require non-empty environment variable {}",
                        operations.auth_token_env
                    )
                })?;
                if token.is_empty() {
                    anyhow::bail!(
                        "Hotfix operations require non-empty environment variable {}",
                        operations.auth_token_env
                    );
                }
                Ok(HotfixOperationsRuntime {
                    token: Arc::from(token),
                    timeout: Duration::from_millis(hotfix_reload_timeout_ms.saturating_add(5_000)),
                    runtime_control,
                })
            })
            .transpose()?;
        let address = format!("{}:{}", config.ip, config.port);
        let listener = TcpListener::bind(&address)
            .await
            .with_context(|| format!("failed to bind process health endpoint {address}"))?;
        let (shutdown, mut shutdown_rx) = watch::channel(false);
        let task = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    biased;
                    changed = shutdown_rx.changed() => {
                        if changed.is_err() || *shutdown_rx.borrow() { break; }
                    }
                    _ = connections.join_next(), if !connections.is_empty() => {}
                    accepted = listener.accept() => {
                        match accepted {
                            Ok((stream, peer)) => {
                                let state = Arc::clone(&state);
                                let process_name = process_name.clone();
                                let hotfix_operations = hotfix_operations.clone();
                                connections.spawn(async move {
                                    if let Err(error) = serve_connection(
                                        stream,
                                        peer,
                                        &process_name,
                                        &state,
                                        hotfix_operations.as_ref(),
                                    ).await {
                                        tracing::debug!(target: "tiangz::health", %error, "health connection failed");
                                    }
                                });
                            }
                            Err(error) => {
                                tracing::error!(target: "tiangz::health", %error, "health listener failed");
                                break;
                            }
                        }
                    }
                }
            }
            connections.shutdown().await;
        });
        tracing::info!(target: "tiangz::health", %address, "process health endpoint listening");
        Ok(Self { shutdown, task })
    }

    /// 关闭监听并取消所有健康连接，等待 accept 循环完成清理。
    ///
    /// Closes the listener, cancels health connections and awaits accept-loop cleanup.
    pub(crate) async fn stop(mut self) {
        let _ = self.shutdown.send(true);
        let _ = (&mut self.task).await;
    }
}

impl Drop for HealthServer {
    /// 启动失败或所有者取消时不遗留健康 listener。 / Prevents an orphaned health listener on startup failure or owner cancellation.
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
        self.task.abort();
    }
}

async fn serve_connection(
    mut stream: TcpStream,
    peer: SocketAddr,
    process_name: &str,
    state: &ProcessHealthState,
    hotfix_operations: Option<&HotfixOperationsRuntime>,
) -> Result<()> {
    let request = read_http_request(&mut stream).await?;
    let response = route_response(&request, peer, process_name, state, hotfix_operations).await;
    let response = format!(
        "HTTP/1.1 {}\r\nContent-Type: {}\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        response.status,
        response.content_type,
        response.body.len(),
        response.body,
    );
    stream.write_all(response.as_bytes()).await?;
    stream.shutdown().await?;
    Ok(())
}

async fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest> {
    let mut bytes = Vec::with_capacity(1024);
    let mut content_length = None;
    let mut header_length = None;
    loop {
        if bytes.len() >= MAX_HTTP_REQUEST_BYTES {
            anyhow::bail!("health request exceeded {MAX_HTTP_REQUEST_BYTES} bytes");
        }
        let mut chunk = [0_u8; 1024];
        let length = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut chunk))
            .await
            .context("health request timed out")??;
        if length == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..length]);
        if header_length.is_none()
            && let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n")
        {
            let end = index + 4;
            header_length = Some(end);
            let header = std::str::from_utf8(&bytes[..index]).context("invalid HTTP header")?;
            content_length = Some(parse_content_length(header)?);
        }
        if let (Some(header_length), Some(content_length)) = (header_length, content_length)
            && bytes.len() >= header_length + content_length
        {
            break;
        }
    }
    let header_length = header_length.context("incomplete HTTP header")?;
    let header = std::str::from_utf8(&bytes[..header_length - 4]).context("invalid HTTP header")?;
    let mut lines = header.split("\r\n");
    let mut request_line = lines.next().unwrap_or("").split_whitespace();
    let method = request_line.next().unwrap_or("").to_string();
    let path = request_line.next().unwrap_or("").to_string();
    let authorization = lines.find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("authorization")
            .then(|| value.trim().to_string())
    });
    let content_length = content_length.unwrap_or_default();
    Ok(HttpRequest {
        method,
        path,
        authorization,
        body: bytes[header_length..header_length + content_length].to_vec(),
    })
}

fn parse_content_length(header: &str) -> Result<usize> {
    let value = header.split("\r\n").skip(1).find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("content-length")
            .then(|| value.trim())
    });
    let length = value.map(str::parse).transpose()?.unwrap_or_default();
    if length > MAX_HTTP_REQUEST_BYTES {
        anyhow::bail!("HTTP body exceeded {MAX_HTTP_REQUEST_BYTES} bytes");
    }
    Ok(length)
}

async fn route_response(
    request: &HttpRequest,
    peer: SocketAddr,
    process_name: &str,
    state: &ProcessHealthState,
    hotfix_operations: Option<&HotfixOperationsRuntime>,
) -> HttpResponse {
    if request.path.starts_with("/admin/hotfix/") {
        return hotfix_operation_response(request, peer, process_name, state, hotfix_operations)
            .await;
    }
    let (status, content_type, body) = probe_response(&request.path, process_name, state);
    HttpResponse {
        status,
        content_type,
        body,
    }
}

async fn hotfix_operation_response(
    request: &HttpRequest,
    peer: SocketAddr,
    process_name: &str,
    state: &ProcessHealthState,
    hotfix_operations: Option<&HotfixOperationsRuntime>,
) -> HttpResponse {
    let Some(operations) = hotfix_operations else {
        return json_response(
            "404 Not Found",
            json!({ "status": "disabled", "process": process_name }),
        );
    };
    if !peer.ip().is_loopback() {
        return json_response(
            "403 Forbidden",
            json!({ "status": "forbidden", "process": process_name }),
        );
    }
    let expected = format!("Bearer {}", operations.token);
    if !request
        .authorization
        .as_deref()
        .is_some_and(|actual| constant_time_equal(actual.as_bytes(), expected.as_bytes()))
    {
        return json_response(
            "401 Unauthorized",
            json!({ "status": "unauthorized", "process": process_name }),
        );
    }
    if request.method == "GET" && request.path == "/admin/hotfix/status" {
        return json_response("200 OK", state.hotfix_status_json(process_name));
    }
    let kind = match (request.method.as_str(), request.path.as_str()) {
        ("POST", "/admin/hotfix/apply") => "applying",
        ("POST", "/admin/hotfix/rollback") => "rolling-back",
        _ => {
            return json_response(
                "404 Not Found",
                json!({ "status": "not-found", "process": process_name }),
            );
        }
    };
    if !state.is_ready() {
        return json_response(
            "503 Service Unavailable",
            json!({ "status": "not-ready", "process": process_name }),
        );
    }
    let parsed: HotfixOperationRequest = match serde_json::from_slice(&request.body) {
        Ok(value) => value,
        Err(error) => {
            return json_response(
                "400 Bad Request",
                json!({ "status": "invalid-request", "process": process_name, "error": error.to_string() }),
            );
        }
    };
    if !valid_operation_id(&parsed.operation_id) {
        return json_response(
            "400 Bad Request",
            json!({ "status": "invalid-request", "process": process_name, "error": "operationId must contain 1..=128 ASCII letters, digits, '.', '_', or '-'" }),
        );
    }
    let candidate_directory = if kind == "applying" {
        match parsed.candidate_directory.as_deref() {
            Some(value) if !value.trim().is_empty() => PathBuf::from(value),
            _ => {
                return json_response(
                    "400 Bad Request",
                    json!({ "status": "invalid-request", "process": process_name, "error": "candidateDirectory is required" }),
                );
            }
        }
    } else {
        match state.previous_hotfix_candidate() {
            Some(value) => value,
            None => {
                return json_response(
                    "409 Conflict",
                    json!({ "status": "rollback-unavailable", "process": process_name, "operationId": parsed.operation_id }),
                );
            }
        }
    };
    if let Err(error) = state.begin_hotfix_operation(&parsed.operation_id, kind) {
        return json_response(
            "409 Conflict",
            json!({ "status": "busy", "process": process_name, "operationId": parsed.operation_id, "error": error }),
        );
    }

    tracing::info!(
        target: "tiangz::hotfix::operations",
        process = process_name,
        operation_id = %parsed.operation_id,
        operation = kind,
        candidate = %candidate_directory.display(),
        "Hotfix operation accepted"
    );
    let (response, completed) = tokio::sync::oneshot::channel();
    let send_result = operations
        .runtime_control
        .send(RuntimeControl::ReloadHotfix {
            candidate_directory,
            requested_at: Instant::now(),
            response,
        });
    let result = if send_result.is_err() {
        Err("V8 runtime control channel is stopped".to_string())
    } else {
        match tokio::time::timeout(operations.timeout, completed).await {
            Ok(Ok(value)) => value,
            Ok(Err(_)) => Err("Hotfix operation response was dropped during shutdown".to_string()),
            Err(_) => Err("Hotfix operation timed out; query status before retrying".to_string()),
        }
    };
    match result {
        Ok(report) => {
            state.finish_hotfix_operation(None);
            tracing::info!(
                target: "tiangz::hotfix::operations",
                process = process_name,
                operation_id = %parsed.operation_id,
                operation = kind,
                generation = report.generation,
                bundle_version = %report.bundle_version,
                "Hotfix operation completed"
            );
            json_response(
                "200 OK",
                json!({
                    "status": if kind == "applying" { "applied" } else { "rolled-back" },
                    "process": process_name,
                    "operationId": parsed.operation_id,
                    "report": report,
                }),
            )
        }
        Err(error) => {
            state.finish_hotfix_operation(Some(error.clone()));
            tracing::error!(
                target: "tiangz::hotfix::operations",
                process = process_name,
                operation_id = %parsed.operation_id,
                operation = kind,
                %error,
                "Hotfix operation failed; active generation preserved"
            );
            json_response(
                "422 Unprocessable Entity",
                json!({ "status": "rejected", "process": process_name, "operationId": parsed.operation_id, "error": error }),
            )
        }
    }
}

fn valid_operation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    let mut different = left.len() ^ right.len();
    for index in 0..left.len().max(right.len()) {
        different |= usize::from(
            left.get(index).copied().unwrap_or_default()
                ^ right.get(index).copied().unwrap_or_default(),
        );
    }
    different == 0
}

fn json_response(status: &'static str, body: Value) -> HttpResponse {
    HttpResponse {
        status,
        content_type: "application/json",
        body: body.to_string(),
    }
}

fn probe_response(
    path: &str,
    process_name: &str,
    state: &ProcessHealthState,
) -> (&'static str, &'static str, String) {
    match path {
        "/runtime-identity" => (
            if state.is_ready() {
                "200 OK"
            } else {
                "503 Service Unavailable"
            },
            "application/json",
            json!({
                "formatVersion": 1,
                "process": process_name,
                "status": if state.is_ready() { "ready" } else { "not-ready" },
                "environment": state.environment.get().map(|environment| environment.as_str()),
                "dataPacks": state.runtime_data_packs.get().map(Vec::as_slice).unwrap_or(&[]),
            })
            .to_string(),
        ),
        "/live" if state.is_live() => (
            "200 OK",
            "application/json",
            json!({ "status": "live", "process": process_name }).to_string(),
        ),
        "/live" => (
            "503 Service Unavailable",
            "application/json",
            json!({ "status": "stopped", "process": process_name }).to_string(),
        ),
        "/ready" if state.is_ready() => (
            "200 OK",
            "application/json",
            json!({ "status": "ready", "process": process_name }).to_string(),
        ),
        "/ready" => (
            "503 Service Unavailable",
            "application/json",
            json!({ "status": "not-ready", "process": process_name }).to_string(),
        ),
        "/metrics" => (
            "200 OK",
            "text/plain; version=0.0.4",
            format_prometheus_metrics(process_name, state),
        ),
        _ => (
            "404 Not Found",
            "application/json",
            json!({ "status": "not-found", "process": process_name }).to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn dropping_health_owner_reclaims_partial_http_connections_and_port() {
        let reserved = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = reserved.local_addr().unwrap();
        drop(reserved);
        let config = HealthObservabilityConfig {
            ip: "127.0.0.1".into(),
            port: address.port(),
            stale_after_ms: 1000,
        };
        let state = Arc::new(ProcessHealthState::starting(Duration::from_secs(1)));
        let (runtime_control, _receiver) = mpsc::channel();
        let server = HealthServer::start(
            &config,
            None,
            1000,
            "fixture".into(),
            state,
            runtime_control,
        )
        .await
        .unwrap();
        let mut client = TcpStream::connect(address).await.unwrap();
        client.write_all(b"GET /").await.unwrap();
        tokio::task::yield_now().await;
        drop(server);
        let result = tokio::time::timeout(Duration::from_secs(1), client.read(&mut [0u8]))
            .await
            .unwrap();
        assert!(
            matches!(result, Ok(0))
                || matches!(result, Err(ref error) if error.kind() == std::io::ErrorKind::ConnectionReset)
        );
        let _rebound = std::net::TcpListener::bind(address).unwrap();
    }

    #[test]
    fn runtime_identity_is_startup_owned_and_respects_readiness() {
        let state = ProcessHealthState::starting(Duration::from_secs(15));
        state
            .runtime_data_packs
            .set(vec![RuntimeDataPackIdentity {
                id: "org.example.content".to_owned(),
                owner_module_id: "org.example".to_owned(),
                file_hash: "a".repeat(64),
            }])
            .unwrap();
        assert!(
            probe_response("/runtime-identity", "fixture", &state)
                .0
                .starts_with("503")
        );
        state.mark_runtime_ready();
        state.mark_endpoints_ready();
        let response = probe_response("/runtime-identity", "fixture", &state);
        assert!(response.0.starts_with("200"));
        let body: Value = serde_json::from_str(&response.2).unwrap();
        assert_eq!(body["dataPacks"][0]["fileHash"], "a".repeat(64));
        assert_eq!(body["dataPacks"][0].as_object().unwrap().len(), 3);
        assert!(body["environment"].is_null());
        assert!(state.runtime_data_packs.set(vec![]).is_err());
        state.set_process_environment(ProcessEnvironment::Staging);
        let body: Value =
            serde_json::from_str(&probe_response("/runtime-identity", "fixture", &state).2)
                .unwrap();
        assert_eq!(body["environment"], "staging");
    }

    #[test]
    fn readiness_requires_runtime_endpoints_and_non_stopping_state() {
        let state = ProcessHealthState::starting(Duration::from_secs(15));
        assert!(probe_response("/live", "test", &state).0.starts_with("200"));
        assert!(
            probe_response("/ready", "test", &state)
                .0
                .starts_with("503")
        );
        state.mark_runtime_ready();
        state.mark_endpoints_ready();
        assert!(
            probe_response("/ready", "test", &state)
                .0
                .starts_with("200")
        );
        state.mark_stopping();
        assert!(
            probe_response("/ready", "test", &state)
                .0
                .starts_with("503")
        );
        assert!(probe_response("/live", "test", &state).0.starts_with("200"));
        state.mark_runtime_stopped();
        assert!(probe_response("/live", "test", &state).0.starts_with("503"));
    }

    #[test]
    fn metrics_is_prometheus_text() {
        let state = ProcessHealthState::starting(Duration::from_secs(15));
        state.mark_runtime_ready();
        state.mark_endpoints_ready();

        let response = probe_response("/metrics", "map-demo", &state);
        assert!(response.0.starts_with("200"));
        assert_eq!(response.1, "text/plain; version=0.0.4");
        assert!(response.2.contains("# TYPE tiangz_process_live gauge"));
        assert!(response.2.contains("tiangz_process_uptime_seconds"));
        assert!(
            response
                .2
                .contains("tiangz_process_runtime_heartbeat_age_seconds")
        );
        assert!(response.2.contains("process=\"map-demo\""));
        assert!(
            response
                .2
                .contains("tiangz_hotfix_active_generation{process=\"map-demo\"} 1")
        );
    }

    #[test]
    fn process_queue_stage_metrics_use_bounded_stage_labels() {
        let state = ProcessHealthState::starting(Duration::from_secs(15));
        state.set_observability_snapshot(ProcessObservabilitySnapshot {
            sample_timestamp_ms: 1,
            host_event_batch_limit_bytes: 67108864,
            max_host_event_batch_bytes: 12345,
            host_event_batch_splits: 4,
            host_backing_store: crate::host::event_buffer::HostBackingStoreSnapshot {
                bytes: 4096,
                max_bytes: 8192,
                buffers: 2,
                created_total: 7,
            },
            queue_stages: vec![ProcessQueueStageObservabilitySnapshot {
                stage: "frame".to_string(),
                depth: 7,
                max_depth: 11,
                backpressure_waits: 3,
                backpressure_wait_ms: 4.5,
                max_backpressure_wait_ms: 2.25,
            }],
            ..ProcessObservabilitySnapshot::default()
        });

        let body = format_prometheus_metrics("map1", &state);
        assert!(
            body.contains("tiangz_process_host_event_batch_limit_bytes{process=\"map1\"} 67108864")
        );
        assert!(body.contains("tiangz_process_host_event_batch_max_bytes{process=\"map1\"} 12345"));
        assert!(body.contains("tiangz_process_host_event_batch_splits_total{process=\"map1\"} 4"));
        for (suffix, value, kind) in [
            ("bytes", 4096, "gauge"),
            ("max_bytes", 8192, "gauge"),
            ("buffers", 2, "gauge"),
            ("created_total", 7, "counter"),
        ] {
            let name = format!("tiangz_process_host_backing_store_{suffix}");
            assert!(body.contains(&format!("# TYPE {name} {kind}")));
            let rows: Vec<_> = body
                .lines()
                .filter(|line| line.starts_with(&format!("{name}{{")))
                .collect();
            assert_eq!(rows, vec![format!("{name}{{process=\"map1\"}} {value}")]);
        }
        assert!(
            body.contains("tiangz_process_queue_stage_depth{process=\"map1\",stage=\"frame\"} 7")
        );
        assert!(body.contains(
            "tiangz_process_queue_stage_backpressure_waits_total{process=\"map1\",stage=\"frame\"} 3"
        ));
        assert!(body.contains(
            "tiangz_process_queue_stage_backpressure_wait_ms_total{process=\"map1\",stage=\"frame\"} 4.500"
        ));
    }

    #[test]
    fn process_admission_metrics_distinguish_handshakes_and_connections_with_fixed_labels() {
        let state = ProcessHealthState::starting(Duration::from_secs(15));
        state.set_observability_snapshot(ProcessObservabilitySnapshot {
            sample_timestamp_ms: 1,
            admission: crate::transport_backend::admission::AdmissionSnapshot {
                connections: 2,
                handshakes: 1,
                connection_limit: 8,
                handshake_limit: 3,
                connection_rejections: 5,
                handshake_rejections: 7,
            },
            outbound_buffers: tiangz_transport::buffer_budget::BufferBudgetSnapshot {
                used_bytes: 12,
                limit_bytes: 64,
                rejections: 3,
            },
            ingress_buffers: tiangz_transport::buffer_budget::BufferBudgetSnapshot {
                used_bytes: 17,
                limit_bytes: 32,
                rejections: 5,
            },
            kcp_buffers: tiangz_transport::buffer_budget::BufferBudgetSnapshot {
                used_bytes: 19,
                limit_bytes: 48,
                rejections: 7,
            },
            ..ProcessObservabilitySnapshot::default()
        });
        let body = format_prometheus_metrics("worker", &state);
        for (metric, kind, expected) in [
            ("in_use", "connection", 2),
            ("in_use", "handshake", 1),
            ("limit", "connection", 8),
            ("limit", "handshake", 3),
            ("rejections_total", "connection", 5),
            ("rejections_total", "handshake", 7),
        ] {
            assert!(body.contains(&format!("tiangz_transport_admission_{metric}{{process=\"worker\",kind=\"{kind}\"}} {expected}")));
        }
        assert_eq!(
            body.lines()
                .filter(|line| line.starts_with("tiangz_transport_admission_"))
                .count(),
            6
        );
        for (metric, expected) in [("bytes", 12), ("limit_bytes", 64), ("rejections_total", 3)] {
            assert!(body.contains(&format!("tiangz_transport_buffer_{metric}{{process=\"worker\",kind=\"outbound\"}} {expected}")));
        }
        for (metric, expected) in [("bytes", 17), ("limit_bytes", 32), ("rejections_total", 5)] {
            assert!(body.contains(&format!(
                "tiangz_transport_buffer_{metric}{{process=\"worker\",kind=\"ingress\"}} {expected}"
            )));
            assert_eq!(
                body.lines()
                    .filter(|line| line
                        .starts_with(&format!("# HELP tiangz_transport_buffer_{metric} ")))
                    .count(),
                1
            );
        }
        assert_eq!(
            body.lines()
                .filter(|line| line.starts_with("tiangz_transport_buffer_"))
                .count(),
            9
        );
        for (metric, expected) in [("bytes", 19), ("limit_bytes", 48), ("rejections_total", 7)] {
            assert!(body.contains(&format!(
                "tiangz_transport_buffer_{metric}{{process=\"worker\",kind=\"kcp\"}} {expected}"
            )));
        }
    }

    #[test]
    fn inner_transport_diagnostic_metrics_export_route_labels() {
        let state = ProcessHealthState::starting(Duration::from_secs(15));
        state.set_observability_snapshot(ProcessObservabilitySnapshot {
            sample_timestamp_ms: 1,
            remote_transport_diagnostics: vec![TransportDiagnosticObservabilitySnapshot {
                msgcode: 1001,
                source: "gate-1\"edge".to_string(),
                target: "map-1".to_string(),
                traffic: "call".to_string(),
                stage: "manager_queue".to_string(),
                overloads: 3,
                timeouts: 2,
            }],
            ..ProcessObservabilitySnapshot::default()
        });

        let body = format_prometheus_metrics("process-1", &state);
        assert!(body.contains(
            "tiangz_transport_inner_overload_rejections_by_route_total{process=\"process-1\",msgcode=\"1001\",source=\"gate-1\\\"edge\",target=\"map-1\",traffic=\"call\",stage=\"manager_queue\"} 3"
        ));
        assert!(body.contains(
            "tiangz_transport_inner_timeouts_by_route_total{process=\"process-1\",msgcode=\"1001\",source=\"gate-1\\\"edge\",target=\"map-1\",traffic=\"call\",stage=\"manager_queue\"} 2"
        ));
    }

    #[test]
    fn process_spawn_metrics_keep_retired_tasks_and_have_only_process_labels() {
        let state = ProcessHealthState::starting(Duration::from_secs(15));
        state.set_observability_snapshot(ProcessObservabilitySnapshot {
            game: Some(GameObservabilitySnapshot {
                scene_task_in_flight: 17,
                scene_task_capacity: 4096,
                scene_task_max_in_flight: 4096,
                scene_task_rejections: 3,
                ..GameObservabilitySnapshot::default()
            }),
            ..ProcessObservabilitySnapshot::default()
        });
        let body = format_prometheus_metrics("worker", &state);
        for (suffix, value) in [
            ("in_flight", 17),
            ("capacity", 4096),
            ("max_in_flight", 4096),
            ("rejected_total", 3),
        ] {
            let prefix = format!("tiangz_scene_tasks_{suffix}{{");
            let lines: Vec<_> = body
                .lines()
                .filter(|line| line.starts_with(&prefix))
                .collect();
            assert_eq!(lines, [format!("{prefix}process=\"worker\"}} {value}")]);
        }
        assert!(body.contains("# TYPE tiangz_scene_tasks_rejected_total counter"));
        assert!(body.contains("# TYPE tiangz_scene_tasks_in_flight gauge"));
    }

    #[test]
    fn process_actor_task_quota_has_only_process_labels_and_separate_rejections() {
        let state = ProcessHealthState::starting(Duration::from_secs(15));
        state.set_observability_snapshot(ProcessObservabilitySnapshot {
            game: Some(GameObservabilitySnapshot {
                actor_mailbox_in_flight: 21,
                actor_mailbox_capacity: 16384,
                actor_mailbox_per_actor_capacity: 4096,
                actor_mailbox_max_in_flight: 16384,
                actor_mailbox_actor_rejections: 4,
                actor_mailbox_process_rejections: 5,
                ..GameObservabilitySnapshot::default()
            }),
            ..ProcessObservabilitySnapshot::default()
        });
        let body = format_prometheus_metrics("worker", &state);
        for (suffix, value, kind) in [
            ("in_flight", 21, "gauge"),
            ("capacity", 16384, "gauge"),
            ("per_actor_capacity", 4096, "gauge"),
            ("max_in_flight", 16384, "gauge"),
            ("actor_rejected_total", 4, "counter"),
            ("process_rejected_total", 5, "counter"),
        ] {
            let name = format!("tiangz_process_actor_mailbox_tasks_{suffix}");
            let lines: Vec<_> = body
                .lines()
                .filter(|line| line.starts_with(&format!("{name}{{")))
                .collect();
            assert_eq!(lines, [format!("{name}{{process=\"worker\"}} {value}")]);
            assert!(body.contains(&format!("# TYPE {name} {kind}")));
        }
    }

    #[test]
    fn process_local_scene_quota_counts_only_local_calls_without_scene_series() {
        let state = ProcessHealthState::starting(Duration::from_secs(15));
        state.set_observability_snapshot(ProcessObservabilitySnapshot {
            game: Some(GameObservabilitySnapshot {
                local_scene_mailbox_in_flight: 29,
                local_scene_mailbox_capacity: 16384,
                local_scene_mailbox_per_scene_capacity: 4096,
                local_scene_mailbox_max_in_flight: 16384,
                local_scene_mailbox_scene_rejections: 6,
                local_scene_mailbox_process_rejections: 7,
                ..GameObservabilitySnapshot::default()
            }),
            ..ProcessObservabilitySnapshot::default()
        });
        let body = format_prometheus_metrics("worker", &state);
        for (suffix, value, kind) in [
            ("in_flight", 29, "gauge"),
            ("capacity", 16384, "gauge"),
            ("per_scene_capacity", 4096, "gauge"),
            ("max_in_flight", 16384, "gauge"),
            ("scene_rejected_total", 6, "counter"),
            ("process_rejected_total", 7, "counter"),
        ] {
            let name = format!("tiangz_local_scene_mailbox_tasks_{suffix}");
            let lines: Vec<_> = body
                .lines()
                .filter(|line| line.starts_with(&format!("{name}{{")))
                .collect();
            assert_eq!(lines, [format!("{name}{{process=\"worker\"}} {value}")]);
            assert!(body.contains(&format!("# TYPE {name} {kind}")));
        }
    }

    #[test]
    fn host_scene_operation_metrics_separate_queued_cost_from_reply_waiters() {
        let state = ProcessHealthState::starting(Duration::from_secs(15));
        state.set_observability_snapshot(ProcessObservabilitySnapshot {
            sample_timestamp_ms: 1,
            control_admission: crate::process::control_ingress::ControlAdmissionSnapshot {
                reserved: 2,
                capacity: 65536,
                peak: 8,
                rejections: 3,
                waits: 4,
            },
            host_scene_batches: crate::host::scene_operations::BatchAdmissionSnapshot {
                reserved_slots: 256,
                max_reserved_slots: 512,
                capacity: 65536,
                rejections: 7,
            },
            game: Some(GameObservabilitySnapshot {
                host_scene_queued_operations: 3,
                host_scene_queued_bytes: 59,
                host_scene_pending_replies: 2,
                host_scene_queue_capacity: 65536,
                host_scene_queue_byte_capacity: 67108864,
                host_scene_pending_capacity: 65536,
                host_scene_queue_rejections: 10,
                host_scene_byte_rejections: 20,
                host_scene_pending_rejections: 30,
                host_scene_invalid_frames: 40,
                host_scene_submit_failures: 50,
                host_scene_queue_timeouts: 60,
                ..GameObservabilitySnapshot::default()
            }),
            ..ProcessObservabilitySnapshot::default()
        });
        let body = format_prometheus_metrics("worker", &state);
        for (suffix, value, kind) in [
            ("reserved", 2, "gauge"),
            ("capacity", 65536, "gauge"),
            ("max_reserved", 8, "gauge"),
            ("rejections_total", 3, "counter"),
            ("waits_total", 4, "counter"),
        ] {
            let name = format!("tiangz_control_ingress_{suffix}");
            let lines: Vec<_> = body
                .lines()
                .filter(|line| line.starts_with(&format!("{name}{{")))
                .collect();
            assert_eq!(lines, [format!("{name}{{process=\"worker\"}} {value}")]);
            assert!(body.contains(&format!("# TYPE {name} {kind}")));
        }
        for (suffix, value, kind) in [
            ("reserved_slots", 256, "gauge"),
            ("max_reserved_slots", 512, "gauge"),
            ("slot_capacity", 65536, "gauge"),
            ("rejections_total", 7, "counter"),
        ] {
            let name = format!("tiangz_host_scene_batch_{suffix}");
            let lines: Vec<_> = body
                .lines()
                .filter(|line| line.starts_with(&format!("{name}{{")))
                .collect();
            assert_eq!(lines, [format!("{name}{{process=\"worker\"}} {value}")]);
            assert!(body.contains(&format!("# TYPE {name} {kind}")));
        }
        for (suffix, value, kind) in [
            ("queued", 3, "gauge"),
            ("queued_bytes", 59, "gauge"),
            ("pending_replies", 2, "gauge"),
            ("queue_capacity", 65536, "gauge"),
            ("queue_byte_capacity", 67108864, "gauge"),
            ("pending_capacity", 65536, "gauge"),
            ("queue_count_rejected_total", 10, "counter"),
            ("queue_bytes_rejected_total", 20, "counter"),
            ("pending_rejected_total", 30, "counter"),
            ("invalid_frames_total", 40, "counter"),
            ("submit_failures_total", 50, "counter"),
            ("queue_timeouts_total", 60, "counter"),
        ] {
            let name = format!("tiangz_host_scene_operations_{suffix}");
            let lines: Vec<_> = body
                .lines()
                .filter(|line| line.starts_with(&format!("{name}{{")))
                .collect();
            assert_eq!(lines, [format!("{name}{{process=\"worker\"}} {value}")]);
            assert!(body.contains(&format!("# TYPE {name} {kind}")));
        }
    }

    #[test]
    fn process_actor_mailbox_metrics_are_exported_without_scene_duplication() {
        let state = ProcessHealthState::starting(Duration::from_secs(15));
        state.set_observability_snapshot(ProcessObservabilitySnapshot {
            sample_timestamp_ms: 1,
            actor_mailbox: MailboxObservabilitySnapshot {
                queued_calls: 7,
                one_way_queued_calls: 3,
                queued_depth: 2,
                max_queued_depth: 11,
                ..MailboxObservabilitySnapshot::default()
            },
            scenes: vec![SceneObservabilitySnapshot {
                scene: "map_1".to_string(),
                scene_type: "MapHost".to_string(),
                last_ingress_pump_frames: 17,
                last_ingress_pump_cost_ms: 4.5,
                mailbox: MailboxObservabilitySnapshot {
                    queued_calls: 5,
                    max_queued_depth: 9,
                    ..MailboxObservabilitySnapshot::default()
                },
                ..SceneObservabilitySnapshot::default()
            }],
            ..ProcessObservabilitySnapshot::default()
        });

        let body = format_prometheus_metrics("process-1", &state);
        assert!(
            body.contains(
                "tiangz_process_actor_mailbox_queued_calls_total{process=\"process-1\"} 7"
            )
        );
        assert!(body.contains(
            "tiangz_process_actor_mailbox_one_way_queued_calls_total{process=\"process-1\"} 3"
        ));
        assert!(
            body.contains(
                "tiangz_process_actor_mailbox_max_queued_depth{process=\"process-1\"} 11"
            )
        );
        assert!(body.contains(
            "tiangz_scene_mailbox_queued_calls_total{process=\"process-1\",scene=\"map_1\",scene_type=\"MapHost\"} 5"
        ));
        assert!(body.contains(
            "tiangz_scene_last_ingress_pump_frames{process=\"process-1\",scene=\"map_1\",scene_type=\"MapHost\"} 17"
        ));
    }

    #[test]
    fn hotfix_metrics_preserve_active_generation_after_failure() {
        let state = ProcessHealthState::starting(Duration::from_secs(15));
        state.record_initial_hotfix("v1".to_string(), "dist".to_string(), json!({}));
        state.record_hotfix_success(
            2,
            "v2".to_string(),
            "candidate-v2".to_string(),
            1.0,
            2.0,
            3.0,
            4.0,
            5.0,
            15.0,
        );
        state.record_hotfix_failure();

        let body = format_prometheus_metrics("map1", &state);
        assert!(body.contains("tiangz_hotfix_active_generation{process=\"map1\"} 2"));
        assert!(body.contains("tiangz_hotfix_reload_successes_total{process=\"map1\"} 1"));
        assert!(body.contains("tiangz_hotfix_reload_failures_total{process=\"map1\"} 1"));
        assert!(body.contains("bundle_version=\"v2\""));
        assert!(body.contains("tiangz_hotfix_reload_total_ms{process=\"map1\"} 15.000000"));
    }

    #[test]
    fn game_config_metrics_preserve_active_fingerprint_after_failure() {
        let state = ProcessHealthState::starting(Duration::from_secs(15));
        state.record_initial_game_config("data-v1".to_string());
        state.record_game_config_success("data-v2".to_string(), 1.5, 2.5);
        state.record_game_config_failure();

        let body = format_prometheus_metrics("map1", &state);
        assert!(body.contains("tiangz_game_config_reload_successes_total{process=\"map1\"} 1"));
        assert!(body.contains("tiangz_game_config_reload_failures_total{process=\"map1\"} 1"));
        assert!(body.contains("data_fingerprint=\"data-v2\""));
        assert!(body.contains("tiangz_game_config_commit_ms{process=\"map1\"} 1.500000"));
        assert!(body.contains("tiangz_game_config_reload_total_ms{process=\"map1\"} 2.500000"));
    }

    #[test]
    fn latency_is_exported_as_aggregatable_histogram() {
        let state = ProcessHealthState::starting(Duration::from_secs(15));
        state.set_observability_snapshot(ProcessObservabilitySnapshot {
            sample_timestamp_ms: 1,
            scenes: vec![SceneObservabilitySnapshot {
                scene: "map_1".to_string(),
                scene_type: "MapHost".to_string(),
                latencies: vec![LatencyObservabilitySnapshot {
                    name: "frame.total".to_string(),
                    msgcode: Some("10001".to_string()),
                    count: 4,
                    sum_ms: 7.5,
                    bounds_ms: vec![1.0, 5.0],
                    bucket_counts: vec![1, 2, 1],
                }],
                ..SceneObservabilitySnapshot::default()
            }],
            ..ProcessObservabilitySnapshot::default()
        });

        let body = format_prometheus_metrics("map1", &state);
        assert!(body.contains("# TYPE tiangz_scene_latency_ms histogram"));
        assert!(body.contains("le=\"1\"} 1"));
        assert!(body.contains("le=\"5\"} 3"));
        assert!(body.contains("le=\"+Inf\"} 4"));
        assert!(body.contains("tiangz_scene_latency_ms_count"));
        assert!(body.contains("tiangz_scene_latency_ms_sum"));
    }

    #[test]
    fn stale_runtime_withdraws_readiness_without_failing_liveness() {
        let state = ProcessHealthState::starting(Duration::from_millis(1));
        state.mark_runtime_ready();
        state.mark_endpoints_ready();
        std::thread::sleep(Duration::from_millis(5));

        assert!(probe_response("/live", "test", &state).0.starts_with("200"));
        assert!(
            probe_response("/ready", "test", &state)
                .0
                .starts_with("503")
        );
        let metrics = format_prometheus_metrics("test", &state);
        assert!(metrics.contains("tiangz_process_runtime_fresh{process=\"test\"} 0"));
    }

    #[test]
    fn custom_metrics_preserve_counter_and_gauge_semantics() {
        let state = ProcessHealthState::starting(Duration::from_secs(15));
        state.set_observability_snapshot(ProcessObservabilitySnapshot {
            sample_timestamp_ms: 1,
            scenes: vec![SceneObservabilitySnapshot {
                scene: "map_1".to_string(),
                scene_type: "MapHost".to_string(),
                custom_metrics: vec![SceneCustomMetricSnapshot {
                    name: "map_broadcast".to_string(),
                    labels: BTreeMap::from([("map_id".to_string(), "1".to_string())]),
                    values: BTreeMap::from([
                        ("pending_units".to_string(), 3.0),
                        ("sent_frames_total".to_string(), 9.0),
                    ]),
                    kinds: BTreeMap::from([(
                        "sent_frames_total".to_string(),
                        SceneCustomMetricKind::Counter,
                    )]),
                }],
                ..SceneObservabilitySnapshot::default()
            }],
            ..ProcessObservabilitySnapshot::default()
        });

        let body = format_prometheus_metrics("map1", &state);
        assert!(body.contains("# TYPE tiangz_scene_custom_metric_gauge gauge"));
        assert!(body.contains("# TYPE tiangz_scene_custom_metric_total counter"));
        assert!(body.contains("tiangz_scene_custom_metric_gauge{"));
        assert!(body.contains("tiangz_scene_custom_metric_total{"));
        assert!(body.contains("map_id=\"1\""));
    }

    #[test]
    fn custom_metric_labels_create_distinct_series_and_cannot_replace_reserved_labels() {
        let state = ProcessHealthState::starting(Duration::from_secs(15));
        let metric = |map_id: &str| SceneCustomMetricSnapshot {
            name: "map_broadcast".to_string(),
            labels: BTreeMap::from([
                ("map_id".to_string(), map_id.to_string()),
                ("process".to_string(), "spoofed".to_string()),
                ("invalid-label".to_string(), "ignored".to_string()),
            ]),
            values: BTreeMap::from([("pending_units".to_string(), 0.0)]),
            kinds: BTreeMap::new(),
        };
        state.set_observability_snapshot(ProcessObservabilitySnapshot {
            sample_timestamp_ms: 1,
            scenes: vec![SceneObservabilitySnapshot {
                scene: "map_host".to_string(),
                scene_type: "MapHost".to_string(),
                custom_metrics: vec![metric("1"), metric("100")],
                ..SceneObservabilitySnapshot::default()
            }],
            ..ProcessObservabilitySnapshot::default()
        });

        let body = format_prometheus_metrics("map2", &state);
        let series = body
            .lines()
            .filter(|line| line.starts_with("tiangz_scene_custom_metric_gauge{"))
            .collect::<Vec<_>>();
        assert_eq!(series.len(), 2);
        assert!(series.iter().any(|line| line.contains("map_id=\"1\"")));
        assert!(series.iter().any(|line| line.contains("map_id=\"100\"")));
        assert!(series.iter().all(|line| line.contains("process=\"map2\"")));
        assert!(series.iter().all(|line| !line.contains("invalid-label")));
        assert_ne!(
            series[0].split_whitespace().next(),
            series[1].split_whitespace().next()
        );
    }

    #[test]
    fn dbproxy_client_metrics_export_bounded_endpoint_and_failover_labels() {
        let state = ProcessHealthState::starting(Duration::from_secs(15));
        state.set_observability_snapshot(ProcessObservabilitySnapshot {
            sample_timestamp_ms: 1,
            dbproxy: Some(DbProxyClientObservabilitySnapshot {
                endpoints: vec![DbProxyEndpointObservabilitySnapshot {
                    endpoint: "127.0.0.1:7800".to_string(),
                    selected: true,
                    connection_attempts: 2,
                    connection_failures: 1,
                    connection_duration_seconds: 0.25,
                    request_attempts: 9,
                    request_failures: 1,
                    request_duration_seconds: 0.5,
                    request_latencies: vec![LatencyObservabilitySnapshot {
                        name: "connection_queue".to_string(),
                        count: 4,
                        sum_ms: 100.0,
                        bounds_ms: vec![1.0, 5.0],
                        bucket_counts: vec![1, 2],
                        ..Default::default()
                    }],
                }],
                failovers: vec![DbProxyFailoverObservabilitySnapshot {
                    from_endpoint: "127.0.0.1:7800".to_string(),
                    to_endpoint: "127.0.0.1:7801".to_string(),
                    count: 1,
                }],
            }),
            ..ProcessObservabilitySnapshot::default()
        });

        let body = format_prometheus_metrics("map-1", &state);
        let latency_labels =
            "process=\"map-1\",endpoint=\"127.0.0.1:7800\",stage=\"connection_queue\"";
        for (bound, count) in [("1", 1), ("5", 3), ("+Inf", 4)] {
            assert!(body.contains(&format!(
                "tiangz_dbproxy_request_stage_ms_bucket{{{latency_labels},le=\"{bound}\"}} {count}"
            )));
        }
        assert!(body.contains(&format!(
            "tiangz_dbproxy_request_stage_ms_count{{{latency_labels}}} 4"
        )));
        assert!(body.contains(&format!(
            "tiangz_dbproxy_request_stage_ms_sum{{{latency_labels}}} 100.000"
        )));
        assert!(body.contains(
            "tiangz_dbproxy_endpoint_selected{process=\"map-1\",endpoint=\"127.0.0.1:7800\"} 1"
        ));
        assert!(body.contains(
            "tiangz_dbproxy_endpoint_connection_failures_total{process=\"map-1\",endpoint=\"127.0.0.1:7800\"} 1"
        ));
        assert!(body.contains(
            "tiangz_dbproxy_endpoint_failovers_total{process=\"map-1\",from_endpoint=\"127.0.0.1:7800\",to_endpoint=\"127.0.0.1:7801\"} 1"
        ));
    }
}
