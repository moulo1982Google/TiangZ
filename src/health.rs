//! 提供独立于业务端点的进程存活与就绪探针。 / Provides process liveness and readiness probes independently from business endpoints.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use crate::config::{HealthObservabilityConfig, HotfixOperationsConfig};
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
        }
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
            loop {
                tokio::select! {
                    changed = shutdown_rx.changed() => {
                        if changed.is_err() || *shutdown_rx.borrow() { break; }
                    }
                    accepted = listener.accept() => {
                        match accepted {
                            Ok((stream, peer)) => {
                                let state = Arc::clone(&state);
                                let process_name = process_name.clone();
                                let hotfix_operations = hotfix_operations.clone();
                                tokio::spawn(async move {
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
        });
        tracing::info!(target: "tiangz::health", %address, "process health endpoint listening");
        Ok(Self { shutdown, task })
    }

    /// 关闭监听并等待 accept 循环退出，不会终止已经进入写回阶段的短连接。
    ///
    /// Closes the listener and waits for the accept loop. Short connections already writing a
    /// response are not forcefully aborted.
    pub(crate) async fn stop(self) {
        let _ = self.shutdown.send(true);
        let _ = self.task.await;
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

fn format_prometheus_metrics(process_name: &str, state: &ProcessHealthState) -> String {
    let safe_process_name = process_name.replace('\\', "\\\\").replace('"', "\\\"");
    let live = if state.is_live() { 1 } else { 0 };
    let ready = if state.is_ready() { 1 } else { 0 };
    let runtime_fresh = if state.is_runtime_fresh() { 1 } else { 0 };
    let runtime_heartbeat_age_seconds = state.runtime_heartbeat_age().as_secs_f64();
    let uptime_seconds = state.started_at.elapsed().as_secs_f64();
    let snapshot = state.observability_snapshot();
    let hotfix = state
        .hotfix_snapshot
        .lock()
        .expect("Hotfix observability lock poisoned")
        .clone();
    let game_config = state
        .game_config_snapshot
        .lock()
        .expect("game config observability lock poisoned")
        .clone();
    let mut output = String::new();

    writeln!(
        output,
        "# HELP tiangz_process_live Process liveness from health observer, 1 means running"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_process_live gauge").expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_live{{process=\"{}\"}} {}",
        safe_process_name, live
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_ready Process readiness from health observer, 1 means ready"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_process_ready gauge").expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_ready{{process=\"{}\"}} {}",
        safe_process_name, ready
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_uptime_seconds Seconds since process health state created"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_process_uptime_seconds gauge").expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_uptime_seconds{{process=\"{}\"}} {:.3}",
        safe_process_name, uptime_seconds
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_runtime_fresh V8 runtime heartbeat freshness, 1 means within staleAfterMs"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_process_runtime_fresh gauge").expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_runtime_fresh{{process=\"{}\"}} {}",
        safe_process_name, runtime_fresh
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_runtime_heartbeat_age_seconds Seconds since the V8 runtime last published a heartbeat"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_process_runtime_heartbeat_age_seconds gauge"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_runtime_heartbeat_age_seconds{{process=\"{}\"}} {:.3}",
        safe_process_name, runtime_heartbeat_age_seconds
    )
    .expect("formatting metric");

    if snapshot.sample_timestamp_ms > 0 {
        append_process_metrics_prometheus(&mut output, &safe_process_name, &snapshot);
        append_actor_mailbox_metrics_prometheus(
            &mut output,
            &safe_process_name,
            &snapshot.actor_mailbox,
        );
    }

    if !snapshot.scenes.is_empty() {
        append_scene_metrics_prometheus(&mut output, &safe_process_name, &snapshot.scenes);
    }
    if let Some(game) = &snapshot.game {
        append_game_metrics_prometheus(&mut output, &safe_process_name, game);
    }
    if let Some(native) = &snapshot.native_data {
        append_native_data_metrics_prometheus(&mut output, &safe_process_name, native);
    }
    if let Some(dbproxy) = &snapshot.dbproxy {
        append_dbproxy_client_metrics_prometheus(&mut output, &safe_process_name, dbproxy);
    }
    append_hotfix_metrics_prometheus(&mut output, &safe_process_name, &hotfix);
    append_game_config_metrics_prometheus(&mut output, &safe_process_name, &game_config);

    output
}

fn append_dbproxy_client_metrics_prometheus(
    output: &mut String,
    process_name: &str,
    snapshot: &DbProxyClientObservabilitySnapshot,
) {
    for (name, help, kind) in [
        (
            "tiangz_dbproxy_endpoint_selected",
            "Last successfully connected DBProxy endpoint for this Process",
            "gauge",
        ),
        (
            "tiangz_dbproxy_endpoint_connection_attempts_total",
            "DBProxy connection attempts by endpoint",
            "counter",
        ),
        (
            "tiangz_dbproxy_endpoint_connection_failures_total",
            "DBProxy failed connection attempts by endpoint",
            "counter",
        ),
        (
            "tiangz_dbproxy_endpoint_connection_duration_seconds_total",
            "Cumulative DBProxy connection attempt duration by endpoint",
            "counter",
        ),
        (
            "tiangz_dbproxy_endpoint_request_attempts_total",
            "DBProxy request attempts by endpoint",
            "counter",
        ),
        (
            "tiangz_dbproxy_endpoint_request_failures_total",
            "DBProxy failed request attempts by endpoint",
            "counter",
        ),
        (
            "tiangz_dbproxy_endpoint_request_duration_seconds_total",
            "Cumulative DBProxy request duration including connection serialization wait",
            "counter",
        ),
        (
            "tiangz_dbproxy_endpoint_failovers_total",
            "DBProxy client endpoint switches after reconnectable failures",
            "counter",
        ),
    ] {
        writeln!(output, "# HELP {name} {help}").expect("formatting metric help");
        writeln!(output, "# TYPE {name} {kind}").expect("formatting metric type");
    }

    for endpoint in &snapshot.endpoints {
        let endpoint_name = escape_prometheus_label(&endpoint.endpoint);
        let labels = format!("process=\"{process_name}\",endpoint=\"{endpoint_name}\"");
        writeln!(
            output,
            "tiangz_dbproxy_endpoint_selected{{{labels}}} {}",
            u8::from(endpoint.selected)
        )
        .expect("formatting DBProxy metric");
        writeln!(
            output,
            "tiangz_dbproxy_endpoint_connection_attempts_total{{{labels}}} {}",
            endpoint.connection_attempts
        )
        .expect("formatting DBProxy metric");
        writeln!(
            output,
            "tiangz_dbproxy_endpoint_connection_failures_total{{{labels}}} {}",
            endpoint.connection_failures
        )
        .expect("formatting DBProxy metric");
        writeln!(
            output,
            "tiangz_dbproxy_endpoint_connection_duration_seconds_total{{{labels}}} {:.6}",
            endpoint.connection_duration_seconds
        )
        .expect("formatting DBProxy metric");
        writeln!(
            output,
            "tiangz_dbproxy_endpoint_request_attempts_total{{{labels}}} {}",
            endpoint.request_attempts
        )
        .expect("formatting DBProxy metric");
        writeln!(
            output,
            "tiangz_dbproxy_endpoint_request_failures_total{{{labels}}} {}",
            endpoint.request_failures
        )
        .expect("formatting DBProxy metric");
        writeln!(
            output,
            "tiangz_dbproxy_endpoint_request_duration_seconds_total{{{labels}}} {:.6}",
            endpoint.request_duration_seconds
        )
        .expect("formatting DBProxy metric");
    }
    for failover in &snapshot.failovers {
        writeln!(
            output,
            "tiangz_dbproxy_endpoint_failovers_total{{process=\"{}\",from_endpoint=\"{}\",to_endpoint=\"{}\"}} {}",
            process_name,
            escape_prometheus_label(&failover.from_endpoint),
            escape_prometheus_label(&failover.to_endpoint),
            failover.count
        )
        .expect("formatting DBProxy failover metric");
    }
}

fn append_actor_mailbox_metrics_prometheus(
    output: &mut String,
    process_name: &str,
    mailbox: &MailboxObservabilitySnapshot,
) {
    for (name, help, metric_type, value) in [
        (
            "tiangz_process_actor_mailbox_fast_path_calls_total",
            "Process-wide Actor mailbox fast-path calls",
            "counter",
            mailbox.fast_path_calls as f64,
        ),
        (
            "tiangz_process_actor_mailbox_queued_calls_total",
            "Process-wide Actor mailbox queued calls",
            "counter",
            mailbox.queued_calls as f64,
        ),
        (
            "tiangz_process_actor_mailbox_async_calls_total",
            "Process-wide Actor mailbox asynchronous calls",
            "counter",
            mailbox.async_calls as f64,
        ),
        (
            "tiangz_process_actor_mailbox_one_way_fast_path_calls_total",
            "Process-wide Actor mailbox one-way fast-path calls",
            "counter",
            mailbox.one_way_fast_path_calls as f64,
        ),
        (
            "tiangz_process_actor_mailbox_one_way_queued_calls_total",
            "Process-wide Actor mailbox one-way queued calls",
            "counter",
            mailbox.one_way_queued_calls as f64,
        ),
        (
            "tiangz_process_actor_mailbox_one_way_async_calls_total",
            "Process-wide Actor mailbox one-way asynchronous calls",
            "counter",
            mailbox.one_way_async_calls as f64,
        ),
        (
            "tiangz_process_actor_mailbox_queued_depth",
            "Current process-wide Actor mailbox queued depth",
            "gauge",
            mailbox.queued_depth as f64,
        ),
        (
            "tiangz_process_actor_mailbox_max_queued_depth",
            "Peak process-wide Actor mailbox queued depth",
            "gauge",
            mailbox.max_queued_depth as f64,
        ),
    ] {
        writeln!(output, "# HELP {name} {help}").expect("formatting Actor mailbox metric help");
        writeln!(output, "# TYPE {name} {metric_type}")
            .expect("formatting Actor mailbox metric type");
        writeln!(output, "{name}{{process=\"{process_name}\"}} {value}")
            .expect("formatting Actor mailbox metric");
    }
}

fn append_game_config_metrics_prometheus(
    output: &mut String,
    process_name: &str,
    snapshot: &GameConfigObservabilitySnapshot,
) {
    for (name, help, metric_type, value) in [
        (
            "tiangz_game_config_reload_successes_total",
            "Successful game config data reloads",
            "counter",
            snapshot.successes as f64,
        ),
        (
            "tiangz_game_config_reload_failures_total",
            "Rejected game config data reloads",
            "counter",
            snapshot.failures as f64,
        ),
        (
            "tiangz_game_config_commit_ms",
            "Last game config V8 snapshot commit milliseconds",
            "gauge",
            snapshot.commit_ms,
        ),
        (
            "tiangz_game_config_reload_total_ms",
            "Last game config reload total milliseconds",
            "gauge",
            snapshot.reload_total_ms,
        ),
    ] {
        writeln!(output, "# HELP {name} {help}").expect("formatting game config metric help");
        writeln!(output, "# TYPE {name} {metric_type}")
            .expect("formatting game config metric type");
        writeln!(output, "{name}{{process=\"{process_name}\"}} {value:.6}")
            .expect("formatting game config metric");
    }
    let fingerprint = snapshot
        .data_fingerprint
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    writeln!(
        output,
        "# HELP tiangz_game_config_info Active game config data information"
    )
    .expect("formatting game config metric help");
    writeln!(output, "# TYPE tiangz_game_config_info gauge")
        .expect("formatting game config metric type");
    writeln!(
        output,
        "tiangz_game_config_info{{process=\"{process_name}\",data_fingerprint=\"{fingerprint}\"}} 1"
    )
    .expect("formatting game config metric");
}

fn append_hotfix_metrics_prometheus(
    output: &mut String,
    process_name: &str,
    snapshot: &HotfixObservabilitySnapshot,
) {
    let bundle = snapshot
        .bundle_version
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    for (name, help, metric_type, value) in [
        (
            "tiangz_hotfix_active_generation",
            "Active Hotfix generation",
            "gauge",
            snapshot.active_generation as f64,
        ),
        (
            "tiangz_hotfix_reload_successes_total",
            "Successful Hotfix reloads",
            "counter",
            snapshot.successes as f64,
        ),
        (
            "tiangz_hotfix_reload_failures_total",
            "Rejected Hotfix reloads",
            "counter",
            snapshot.failures as f64,
        ),
        (
            "tiangz_hotfix_validation_ms",
            "Last Hotfix candidate validation milliseconds",
            "gauge",
            snapshot.validation_ms,
        ),
        (
            "tiangz_hotfix_preflight_ms",
            "Last Hotfix isolated preflight milliseconds",
            "gauge",
            snapshot.preflight_ms,
        ),
        (
            "tiangz_hotfix_barrier_wait_ms",
            "Last Hotfix barrier wait milliseconds",
            "gauge",
            snapshot.barrier_wait_ms,
        ),
        (
            "tiangz_hotfix_candidate_eval_ms",
            "Last Hotfix serving V8 evaluation milliseconds",
            "gauge",
            snapshot.candidate_eval_ms,
        ),
        (
            "tiangz_hotfix_commit_ms",
            "Last Hotfix transaction commit milliseconds",
            "gauge",
            snapshot.commit_ms,
        ),
        (
            "tiangz_hotfix_reload_total_ms",
            "Last Hotfix reload total milliseconds",
            "gauge",
            snapshot.reload_total_ms,
        ),
    ] {
        writeln!(output, "# HELP {name} {help}").expect("formatting Hotfix metric help");
        writeln!(output, "# TYPE {name} {metric_type}").expect("formatting Hotfix metric type");
        writeln!(output, "{name}{{process=\"{process_name}\"}} {value:.6}")
            .expect("formatting Hotfix metric");
    }
    writeln!(
        output,
        "# HELP tiangz_hotfix_bundle_info Active Hotfix bundle information"
    )
    .expect("formatting Hotfix metric help");
    writeln!(output, "# TYPE tiangz_hotfix_bundle_info gauge")
        .expect("formatting Hotfix metric type");
    writeln!(
        output,
        "tiangz_hotfix_bundle_info{{process=\"{process_name}\",bundle_version=\"{bundle}\"}} 1"
    )
    .expect("formatting Hotfix metric");
}

fn append_process_metrics_prometheus(
    output: &mut String,
    process_name: &str,
    snapshot: &ProcessObservabilitySnapshot,
) {
    writeln!(
        output,
        "# HELP tiangz_process_cpu_percent Process CPU usage percentage sampled over 5s window"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_process_cpu_percent gauge").expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_cpu_percent{{process=\"{}\"}} {:.3}",
        process_name, snapshot.cpu_percent
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_cpu_time_ms Cumulative process cpu time"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_process_cpu_time_ms counter").expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_cpu_time_ms{{process=\"{}\"}} {}",
        process_name, snapshot.cpu_time_ms
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_rss_bytes Resident set size in bytes"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_process_rss_bytes gauge").expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_rss_bytes{{process=\"{}\"}} {}",
        process_name, snapshot.rss_bytes
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_v8_heap_used_bytes V8 used heap size in bytes"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_process_v8_heap_used_bytes gauge")
        .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_v8_heap_used_bytes{{process=\"{}\"}} {}",
        process_name, snapshot.v8_heap_used_bytes
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_v8_heap_total_bytes V8 total heap size in bytes"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_process_v8_heap_total_bytes gauge")
        .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_v8_heap_total_bytes{{process=\"{}\"}} {}",
        process_name, snapshot.v8_heap_total_bytes
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_v8_gc_count_total V8 garbage collection count"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_process_v8_gc_count_total counter")
        .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_v8_gc_count_total{{process=\"{}\"}} {}",
        process_name, snapshot.v8_gc_count
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_v8_gc_ms_total Total V8 gc time in ms"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_process_v8_gc_ms_total counter")
        .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_v8_gc_ms_total{{process=\"{}\"}} {:.3}",
        process_name, snapshot.v8_gc_ms
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_metrics_timestamp_ms Process metrics sample wall-clock in unix ms"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_process_metrics_timestamp_ms gauge")
        .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_metrics_timestamp_ms{{process=\"{}\"}} {}",
        process_name, snapshot.sample_timestamp_ms
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_dropped_logs_total Log lines dropped by host logger queue"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_process_dropped_logs_total counter")
        .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_dropped_logs_total{{process=\"{}\"}} {}",
        process_name, snapshot.dropped_logs
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_inbound_frames_total Frames entered process queue (cumulative)"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_process_inbound_frames_total counter")
        .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_inbound_frames_total{{process=\"{}\"}} {}",
        process_name, snapshot.inbound_frames
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_host_completions_total Host completions posted into event loop"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_process_host_completions_total counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_host_completions_total{{process=\"{}\"}} {}",
        process_name, snapshot.host_completions
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_runtime_updates_total V8 runtime pump loops"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_process_runtime_updates_total counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_runtime_updates_total{{process=\"{}\"}} {}",
        process_name, snapshot.runtime_updates
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_runtime_events_total Frames drained per runtime update (cumulative)"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_process_runtime_events_total counter")
        .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_runtime_events_total{{process=\"{}\"}} {}",
        process_name, snapshot.runtime_events
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_max_runtime_batch Max frame batch size at runtime update (latest)"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_process_max_runtime_batch gauge")
        .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_max_runtime_batch{{process=\"{}\"}} {}",
        process_name, snapshot.max_runtime_batch
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_rust_queue_depth Current Rust event queue depth"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_process_rust_queue_depth gauge")
        .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_rust_queue_depth{{process=\"{}\"}} {}",
        process_name, snapshot.queue_depth
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_rust_queue_capacity Event queue capacity"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_process_rust_queue_capacity gauge")
        .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_rust_queue_capacity{{process=\"{}\"}} {}",
        process_name, snapshot.queue_capacity
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_rust_queue_max_depth Max queue depth since boot"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_process_rust_queue_max_depth gauge")
        .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_rust_queue_max_depth{{process=\"{}\"}} {}",
        process_name, snapshot.queue_max_depth
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_backpressure_waits_total Backpressure wait events"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_process_backpressure_waits_total counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_backpressure_waits_total{{process=\"{}\"}} {}",
        process_name, snapshot.backpressure_waits
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_queue_stage_depth Current process ingress queue depth by event stage"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_process_queue_stage_depth gauge")
        .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_process_queue_stage_max_depth Max process ingress queue depth by event stage since boot"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_process_queue_stage_max_depth gauge")
        .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_process_queue_stage_backpressure_waits_total Backpressure events by process ingress event stage"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_process_queue_stage_backpressure_waits_total counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_process_queue_stage_backpressure_wait_ms_total Time spent waiting for process ingress capacity by event stage"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_process_queue_stage_backpressure_wait_ms_total counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_process_queue_stage_backpressure_wait_ms_max Max time spent waiting for process ingress capacity by event stage"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_process_queue_stage_backpressure_wait_ms_max gauge"
    )
    .expect("formatting metric type");
    for stage in &snapshot.queue_stages {
        let stage_name = escape_prometheus_label(&stage.stage);
        writeln!(
            output,
            "tiangz_process_queue_stage_depth{{process=\"{}\",stage=\"{}\"}} {}",
            process_name, stage_name, stage.depth
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_process_queue_stage_max_depth{{process=\"{}\",stage=\"{}\"}} {}",
            process_name, stage_name, stage.max_depth
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_process_queue_stage_backpressure_waits_total{{process=\"{}\",stage=\"{}\"}} {}",
            process_name, stage_name, stage.backpressure_waits
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_process_queue_stage_backpressure_wait_ms_total{{process=\"{}\",stage=\"{}\"}} {:.3}",
            process_name, stage_name, stage.backpressure_wait_ms
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_process_queue_stage_backpressure_wait_ms_max{{process=\"{}\",stage=\"{}\"}} {:.3}",
            process_name, stage_name, stage.max_backpressure_wait_ms
        )
        .expect("formatting metric");
    }
    writeln!(
        output,
        "# HELP tiangz_process_slow_disconnects_total Slow clients disconnected due to backlog"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_process_slow_disconnects_total counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_slow_disconnects_total{{process=\"{}\"}} {}",
        process_name, snapshot.slow_client_disconnects
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_disconnects_total Client disconnections"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_process_disconnects_total counter")
        .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_disconnects_total{{process=\"{}\"}} {}",
        process_name, snapshot.disconnects
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_outbound_batches_total Outbound transport batch count"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_process_outbound_batches_total counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_outbound_batches_total{{process=\"{}\"}} {}",
        process_name, snapshot.outbound_batches
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_outbound_recipients_total Outbound recipient count"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_process_outbound_recipients_total counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_outbound_recipients_total{{process=\"{}\"}} {}",
        process_name, snapshot.outbound_recipients
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_outbound_bridge_bytes_total Bytes sent by Rust bridge layer"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_process_outbound_bridge_bytes_total counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_outbound_bridge_bytes_total{{process=\"{}\"}} {}",
        process_name, snapshot.outbound_bridge_bytes
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_outbound_logical_bytes_total Logical payload bytes sent"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_process_outbound_logical_bytes_total counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_outbound_logical_bytes_total{{process=\"{}\"}} {}",
        process_name, snapshot.outbound_logical_bytes
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_transport_read_ops_total Transport read operations"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_process_transport_read_ops_total counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_transport_read_ops_total{{process=\"{}\"}} {}",
        process_name, snapshot.transport_read_ops
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_transport_read_frames_total Transport read frame count"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_process_transport_read_frames_total counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_transport_read_frames_total{{process=\"{}\"}} {}",
        process_name, snapshot.transport_read_frames
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_transport_read_bytes_total Transport read bytes"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_process_transport_read_bytes_total counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_transport_read_bytes_total{{process=\"{}\"}} {}",
        process_name, snapshot.transport_read_bytes
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_transport_write_ops_total Transport write operations"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_process_transport_write_ops_total counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_transport_write_ops_total{{process=\"{}\"}} {}",
        process_name, snapshot.transport_write_ops
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_transport_write_frames_total Transport write frame count"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_process_transport_write_frames_total counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_transport_write_frames_total{{process=\"{}\"}} {}",
        process_name, snapshot.transport_write_frames
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_transport_write_bytes_total Transport write bytes"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_process_transport_write_bytes_total counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_transport_write_bytes_total{{process=\"{}\"}} {}",
        process_name, snapshot.transport_write_bytes
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_process_active_connections Total active client connections"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_process_active_connections gauge")
        .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_process_active_connections{{process=\"{}\"}} {}",
        process_name, snapshot.active_connections
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_transport_inner_active_connections Active inner transport connections"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_transport_inner_active_connections gauge"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_transport_inner_active_connections{{process=\"{}\"}} {}",
        process_name, snapshot.remote_transport_active_connections
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_transport_inner_opened_connections Total inner transport connections opened"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_transport_inner_opened_connections counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_transport_inner_opened_connections{{process=\"{}\"}} {}",
        process_name, snapshot.remote_transport_opened_connections
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_transport_inner_pending_calls Currently pending inner scene RPC calls"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_transport_inner_pending_calls gauge")
        .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_transport_inner_pending_calls{{process=\"{}\"}} {}",
        process_name, snapshot.remote_transport_pending_calls
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_transport_inner_max_pending_calls Max pending inner scene RPC calls"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_transport_inner_max_pending_calls gauge"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_transport_inner_max_pending_calls{{process=\"{}\"}} {}",
        process_name, snapshot.remote_transport_max_pending_calls
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_transport_inner_overload_rejections Total inner transport overload rejections"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_transport_inner_overload_rejections counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_transport_inner_overload_rejections{{process=\"{}\"}} {}",
        process_name, snapshot.remote_transport_overload_rejections
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_transport_inner_overload_stage_rejections_total Inner transport overload rejections by bounded queue stage"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_transport_inner_overload_stage_rejections_total counter"
    )
    .expect("formatting metric type");
    for stage in &snapshot.remote_transport_overload_stages {
        writeln!(
            output,
            "tiangz_transport_inner_overload_stage_rejections_total{{process=\"{}\",stage=\"{}\"}} {}",
            process_name,
            escape_prometheus_label(&stage.stage),
            stage.rejections
        )
        .expect("formatting metric");
    }
    writeln!(
        output,
        "# HELP tiangz_transport_inner_overload_rejections_by_route_total Inner transport overload rejections by msgcode, source, target, traffic class, and queue stage"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_transport_inner_overload_rejections_by_route_total counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_transport_inner_timeouts_by_route_total Inner transport timeouts by msgcode, source, target, traffic class, and queue stage"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_transport_inner_timeouts_by_route_total counter"
    )
    .expect("formatting metric type");
    for diagnostic in &snapshot.remote_transport_diagnostics {
        let labels = format!(
            "process=\"{}\",msgcode=\"{}\",source=\"{}\",target=\"{}\",traffic=\"{}\",stage=\"{}\"",
            process_name,
            diagnostic.msgcode,
            escape_prometheus_label(&diagnostic.source),
            escape_prometheus_label(&diagnostic.target),
            escape_prometheus_label(&diagnostic.traffic),
            escape_prometheus_label(&diagnostic.stage),
        );
        writeln!(
            output,
            "tiangz_transport_inner_overload_rejections_by_route_total{{{labels}}} {}",
            diagnostic.overloads
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_transport_inner_timeouts_by_route_total{{{labels}}} {}",
            diagnostic.timeouts
        )
        .expect("formatting metric");
    }
    writeln!(
        output,
        "# HELP tiangz_transport_inner_timed_out_calls Total timed out inner scene RPC calls"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_transport_inner_timed_out_calls counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_transport_inner_timed_out_calls{{process=\"{}\"}} {}",
        process_name, snapshot.remote_transport_timed_out_calls
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_transport_inner_disconnected_calls Inner scene calls dropped due to disconnects"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_transport_inner_disconnected_calls counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_transport_inner_disconnected_calls{{process=\"{}\"}} {}",
        process_name, snapshot.remote_transport_disconnected_calls
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_transport_inner_late_responses Late inner scene responses after waiter completion"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_transport_inner_late_responses counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_transport_inner_late_responses{{process=\"{}\"}} {}",
        process_name, snapshot.remote_transport_late_responses
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_transport_inner_idle_closes Total inner transport connections closed by idle timeout"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_transport_inner_idle_closes counter")
        .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_transport_inner_idle_closes{{process=\"{}\"}} {}",
        process_name, snapshot.remote_transport_idle_closes
    )
    .expect("formatting metric");
}

fn append_scene_metrics_prometheus(
    output: &mut String,
    process_name: &str,
    scenes: &[SceneObservabilitySnapshot],
) {
    writeln!(
        output,
        "# HELP tiangz_scene_processed_frames_total Processed frames by scene"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_scene_processed_frames_total counter")
        .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_scene_failed_frames_total Failed frames by scene"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_scene_failed_frames_total counter")
        .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_scene_protocol_successes_total Protocol success count by scene"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_scene_protocol_successes_total counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_scene_business_errors_total Business reject count by scene"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_scene_business_errors_total counter")
        .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_scene_system_errors_total Framework error count by scene"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_scene_system_errors_total counter")
        .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_scene_decode_errors_total Decode error count by scene"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_scene_decode_errors_total counter")
        .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_scene_handler_not_found_total Missing handler count by scene"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_scene_handler_not_found_total counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_scene_message_handler_failures_total Message handler failure count by scene"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_scene_message_handler_failures_total counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_scene_ingress_queue_length Frames waiting in scene queue"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_scene_ingress_queue_length gauge")
        .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_scene_ingress_queue_max_length Scene ingress queue peak"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_scene_ingress_queue_max_length gauge")
        .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_scene_async_in_flight Async RPC count in scene"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_scene_async_in_flight gauge").expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_scene_async_in_flight_max Scene async in-flight peak"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_scene_async_in_flight_max gauge")
        .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_scene_mailbox_fast_path_calls_total Mailbox calls completed on the immediate path"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_scene_mailbox_fast_path_calls_total counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_scene_mailbox_queued_calls_total Mailbox RPC calls queued behind an ordered call"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_scene_mailbox_queued_calls_total counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_scene_mailbox_async_calls_total Mailbox calls that returned an asynchronous result"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_scene_mailbox_async_calls_total counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_scene_mailbox_one_way_fast_path_calls_total One-way mailbox calls completed on the immediate path"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_scene_mailbox_one_way_fast_path_calls_total counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_scene_mailbox_one_way_queued_calls_total One-way mailbox calls queued without a response Promise"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_scene_mailbox_one_way_queued_calls_total counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_scene_mailbox_one_way_async_calls_total One-way mailbox calls that returned an asynchronous result"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_scene_mailbox_one_way_async_calls_total counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_scene_mailbox_queued_depth Current queued mailbox calls"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_scene_mailbox_queued_depth gauge")
        .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_scene_mailbox_max_queued_depth Mailbox queue peak"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_scene_mailbox_max_queued_depth gauge")
        .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_scene_last_ingress_pump_frames Frames consumed by the latest Scene ingress pump"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_scene_last_ingress_pump_frames gauge")
        .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_scene_last_ingress_pump_cost_ms Latest Scene ingress pump cost ms"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_scene_last_ingress_pump_cost_ms gauge"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_scene_last_update_cost_ms Latest scene update cost ms"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_scene_last_update_cost_ms gauge")
        .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_scene_last_handler_cost_ms Latest handler cost ms"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_scene_last_handler_cost_ms gauge")
        .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_scene_max_handler_cost_ms Max handler cost ms"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_scene_max_handler_cost_ms gauge")
        .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_scene_total_handler_cost_ms Sum handler cost ms"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_scene_total_handler_cost_ms counter")
        .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_scene_latency_ms Sampled latency by stage in milliseconds"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_scene_latency_ms histogram").expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_scene_custom_metric_gauge Custom scene instantaneous metric"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_scene_custom_metric_gauge gauge")
        .expect("formatting metric type");
    writeln!(
        output,
        "# HELP tiangz_scene_custom_metric_total Custom scene cumulative metric"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_scene_custom_metric_total counter")
        .expect("formatting metric type");

    for snapshot in scenes {
        let labels = scene_labels(process_name, snapshot);
        writeln!(
            output,
            "tiangz_scene_processed_frames_total{{{}}} {}",
            labels, snapshot.processed_frames
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_scene_failed_frames_total{{{}}} {}",
            labels, snapshot.failed_frames
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_scene_protocol_successes_total{{{}}} {}",
            labels, snapshot.protocol_successes
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_scene_business_errors_total{{{}}} {}",
            labels, snapshot.business_errors
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_scene_system_errors_total{{{}}} {}",
            labels, snapshot.system_errors
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_scene_decode_errors_total{{{}}} {}",
            labels, snapshot.decode_errors
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_scene_handler_not_found_total{{{}}} {}",
            labels, snapshot.handler_not_found
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_scene_message_handler_failures_total{{{}}} {}",
            labels, snapshot.message_handler_failures
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_scene_ingress_queue_length{{{}}} {}",
            labels, snapshot.ingress_queue_length
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_scene_ingress_queue_max_length{{{}}} {}",
            labels, snapshot.max_ingress_queue_length
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_scene_async_in_flight{{{}}} {}",
            labels, snapshot.async_in_flight
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_scene_async_in_flight_max{{{}}} {}",
            labels, snapshot.max_async_in_flight
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_scene_mailbox_fast_path_calls_total{{{}}} {}",
            labels, snapshot.mailbox.fast_path_calls
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_scene_mailbox_queued_calls_total{{{}}} {}",
            labels, snapshot.mailbox.queued_calls
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_scene_mailbox_async_calls_total{{{}}} {}",
            labels, snapshot.mailbox.async_calls
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_scene_mailbox_one_way_fast_path_calls_total{{{}}} {}",
            labels, snapshot.mailbox.one_way_fast_path_calls
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_scene_mailbox_one_way_queued_calls_total{{{}}} {}",
            labels, snapshot.mailbox.one_way_queued_calls
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_scene_mailbox_one_way_async_calls_total{{{}}} {}",
            labels, snapshot.mailbox.one_way_async_calls
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_scene_mailbox_queued_depth{{{}}} {}",
            labels, snapshot.mailbox.queued_depth
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_scene_mailbox_max_queued_depth{{{}}} {}",
            labels, snapshot.mailbox.max_queued_depth
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_scene_last_ingress_pump_frames{{{}}} {}",
            labels, snapshot.last_ingress_pump_frames
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_scene_last_ingress_pump_cost_ms{{{}}} {:.3}",
            labels, snapshot.last_ingress_pump_cost_ms
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_scene_last_update_cost_ms{{{}}} {:.3}",
            labels, snapshot.last_update_cost_ms
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_scene_last_handler_cost_ms{{{}}} {:.3}",
            labels, snapshot.last_handler_cost_ms
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_scene_max_handler_cost_ms{{{}}} {:.3}",
            labels, snapshot.max_handler_cost_ms
        )
        .expect("formatting metric");
        writeln!(
            output,
            "tiangz_scene_total_handler_cost_ms{{{}}} {:.3}",
            labels, snapshot.total_handler_cost_ms
        )
        .expect("formatting metric");

        for latency in &snapshot.latencies {
            let mut latency_labels: BTreeMap<&str, &str> = BTreeMap::new();
            latency_labels.insert("process", process_name);
            latency_labels.insert("scene", snapshot.scene.as_str());
            latency_labels.insert("scene_type", snapshot.scene_type.as_str());
            latency_labels.insert("stage", latency.name.as_str());
            latency_labels.insert("msgcode", latency.msgcode.as_deref().unwrap_or("-"));
            let rendered = render_prometheus_labels(&latency_labels);
            let mut cumulative = 0_u64;
            for (index, bound) in latency.bounds_ms.iter().enumerate() {
                cumulative = cumulative.saturating_add(
                    latency
                        .bucket_counts
                        .get(index)
                        .copied()
                        .unwrap_or_default(),
                );
                writeln!(
                    output,
                    "tiangz_scene_latency_ms_bucket{{{},le=\"{}\"}} {}",
                    rendered, bound, cumulative
                )
                .expect("formatting metric");
            }
            writeln!(
                output,
                "tiangz_scene_latency_ms_bucket{{{},le=\"+Inf\"}} {}",
                rendered, latency.count
            )
            .expect("formatting metric");
            writeln!(
                output,
                "tiangz_scene_latency_ms_count{{{}}} {}",
                rendered, latency.count
            )
            .expect("formatting metric");
            writeln!(
                output,
                "tiangz_scene_latency_ms_sum{{{}}} {:.3}",
                rendered, latency.sum_ms
            )
            .expect("formatting metric");
        }

        for metric in &snapshot.custom_metrics {
            for (key, value) in &metric.values {
                let mut custom_labels: BTreeMap<&str, &str> = BTreeMap::new();
                custom_labels.insert("process", process_name);
                custom_labels.insert("scene", snapshot.scene.as_str());
                custom_labels.insert("scene_type", snapshot.scene_type.as_str());
                custom_labels.insert("name", metric.name.as_str());
                custom_labels.insert("key", key.as_str());
                for (name, value) in &metric.labels {
                    if is_prometheus_label_name(name) && !custom_labels.contains_key(name.as_str())
                    {
                        custom_labels.insert(name.as_str(), value.as_str());
                    }
                }
                let rendered = render_prometheus_labels(&custom_labels);
                let family = match metric.kinds.get(key).copied().unwrap_or_default() {
                    SceneCustomMetricKind::Counter => "tiangz_scene_custom_metric_total",
                    SceneCustomMetricKind::Gauge => "tiangz_scene_custom_metric_gauge",
                };
                writeln!(output, "{}{{{}}} {:.3}", family, rendered, value)
                    .expect("formatting metric");
            }
        }
    }
}

fn append_game_metrics_prometheus(
    output: &mut String,
    process_name: &str,
    snapshot: &GameObservabilitySnapshot,
) {
    writeln!(
        output,
        "# HELP tiangz_game_fixed_update_ms Configured fixed update interval in ms"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_game_fixed_update_ms gauge").expect("formatting metric type");
    writeln!(
        output,
        "tiangz_game_fixed_update_ms{{process=\"{}\"}} {}",
        process_name, snapshot.fixed_update_ms
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_game_frame_count_total Cumulative frame count"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_game_frame_count_total counter")
        .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_game_frame_count_total{{process=\"{}\"}} {}",
        process_name, snapshot.frame_count
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_game_skipped_fixed_updates_total Skipped update count"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_game_skipped_fixed_updates_total counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_game_skipped_fixed_updates_total{{process=\"{}\"}} {}",
        process_name, snapshot.skipped_fixed_updates
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_game_update_targets Gauge of update targets"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_game_update_targets gauge").expect("formatting metric type");
    writeln!(
        output,
        "tiangz_game_update_targets{{process=\"{}\"}} {}",
        process_name, snapshot.update_targets
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_game_update_calls_total Total Update calls"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_game_update_calls_total counter")
        .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_game_update_calls_total{{process=\"{}\"}} {}",
        process_name, snapshot.update_calls
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_game_update_failures_total Total Update failures"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_game_update_failures_total counter")
        .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_game_update_failures_total{{process=\"{}\"}} {}",
        process_name, snapshot.update_failures
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_game_timers_total Timers tracked by game loop"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_game_timers_total gauge").expect("formatting metric type");
    writeln!(
        output,
        "tiangz_game_timers_total{{process=\"{}\"}} {}",
        process_name, snapshot.timers
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_coroutine_lock_waiters Current Process-local coroutine lock waiters"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_coroutine_lock_waiters gauge").expect("formatting metric type");
    writeln!(
        output,
        "tiangz_coroutine_lock_waiters{{process=\"{}\"}} {}",
        process_name, snapshot.coroutine_lock_waiters
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_coroutine_lock_timeouts_total Total Process-local coroutine lock wait timeouts"
    )
    .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_coroutine_lock_timeouts_total counter"
    )
    .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_coroutine_lock_timeouts_total{{process=\"{}\"}} {}",
        process_name, snapshot.coroutine_lock_timeouts
    )
    .expect("formatting metric");
}

fn append_native_data_metrics_prometheus(
    output: &mut String,
    process_name: &str,
    snapshot: &NativeDataObservabilitySnapshot,
) {
    writeln!(
        output,
        "# HELP tiangz_native_scalar_gets_total Native scalar read calls"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_native_scalar_gets_total counter")
        .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_native_scalar_gets_total{{process=\"{}\"}} {}",
        process_name, snapshot.scalar_gets
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_native_scalar_sets_total Native scalar write calls"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_native_scalar_sets_total counter")
        .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_native_scalar_sets_total{{process=\"{}\"}} {}",
        process_name, snapshot.scalar_sets
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_native_batch_calls_total Native batch op call count"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_native_batch_calls_total counter")
        .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_native_batch_calls_total{{process=\"{}\"}} {}",
        process_name, snapshot.batch_calls
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_native_live_entities Live entities in native arena"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_native_live_entities gauge").expect("formatting metric type");
    writeln!(
        output,
        "tiangz_native_live_entities{{process=\"{}\"}} {}",
        process_name, snapshot.live_entities
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_native_live_units Live units in native arena"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_native_live_units gauge").expect("formatting metric type");
    writeln!(
        output,
        "tiangz_native_live_units{{process=\"{}\"}} {}",
        process_name, snapshot.live_units
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_native_live_items Live items in native typed pools"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_native_live_items gauge").expect("formatting metric type");
    writeln!(
        output,
        "tiangz_native_live_items{{process=\"{}\"}} {}",
        process_name, snapshot.live_items
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_native_pool_capacity_bytes Reserved capacity of native typed pools"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_native_pool_capacity_bytes gauge")
        .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_native_pool_capacity_bytes{{process=\"{}\"}} {}",
        process_name, snapshot.pool_capacity_bytes
    )
    .expect("formatting metric");
    writeln!(output, "# HELP tiangz_native_scratch_capacity_bytes Reserved capacity of reusable frame scratch buffers")
        .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_native_scratch_capacity_bytes gauge")
        .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_native_scratch_capacity_bytes{{process=\"{}\"}} {}",
        process_name, snapshot.scratch_capacity_bytes
    )
    .expect("formatting metric");
    writeln!(output, "# HELP tiangz_native_scratch_growths_total Reallocations caused by reusable frame scratch growth")
        .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_native_scratch_growths_total counter")
        .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_native_scratch_growths_total{{process=\"{}\"}} {}",
        process_name, snapshot.scratch_growths
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_native_refs Live TypeScript NativeRef objects"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_native_refs gauge").expect("formatting metric type");
    for (entity_type, count) in &snapshot.native_refs {
        writeln!(
            output,
            "tiangz_native_refs{{process=\"{}\",entity_type=\"{}\"}} {}",
            process_name,
            escape_prometheus_label(entity_type),
            count
        )
        .expect("formatting metric");
    }
    writeln!(
        output,
        "# HELP tiangz_native_encoded_frames_total Native encoded frames"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_native_encoded_frames_total counter")
        .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_native_encoded_frames_total{{process=\"{}\"}} {}",
        process_name, snapshot.encoded_frames
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_native_encoded_items_total Native encoded items"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_native_encoded_items_total counter")
        .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_native_encoded_items_total{{process=\"{}\"}} {}",
        process_name, snapshot.encoded_items
    )
    .expect("formatting metric");
    writeln!(
        output,
        "# HELP tiangz_native_encoded_bytes_total Native encoded bytes"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_native_encoded_bytes_total counter")
        .expect("formatting metric type");
    writeln!(
        output,
        "tiangz_native_encoded_bytes_total{{process=\"{}\"}} {}",
        process_name, snapshot.encoded_bytes
    )
    .expect("formatting metric");
    for (name, help) in [
        (
            "tiangz_native_numeric_changes_total",
            "Numeric value changes by Numeric type",
        ),
        (
            "tiangz_native_numeric_encoded_records_total",
            "Numeric records encoded into final audience groups by Numeric type",
        ),
        (
            "tiangz_native_numeric_recipient_deliveries_total",
            "Logical Numeric recipient deliveries by Numeric type",
        ),
        (
            "tiangz_native_numeric_logical_bytes_total",
            "Logical delivered Numeric item bytes by Numeric type excluding Gate envelopes",
        ),
    ] {
        writeln!(output, "# HELP {name} {help}").expect("formatting metric help");
        writeln!(output, "# TYPE {name} counter").expect("formatting metric type");
    }
    for item in &snapshot.numeric_replication {
        for (name, value) in [
            ("tiangz_native_numeric_changes_total", item.changes),
            (
                "tiangz_native_numeric_encoded_records_total",
                item.encoded_records,
            ),
            (
                "tiangz_native_numeric_recipient_deliveries_total",
                item.recipient_deliveries,
            ),
            (
                "tiangz_native_numeric_logical_bytes_total",
                item.logical_bytes,
            ),
        ] {
            writeln!(
                output,
                "{name}{{process=\"{}\",numeric_type=\"{}\"}} {value}",
                process_name, item.numeric_type
            )
            .expect("formatting metric");
        }
    }
    for (name, help, metric_type, value) in [
        (
            "tiangz_aoi_worlds",
            "Live map-instance AOI worlds",
            "gauge",
            snapshot.aoi_worlds,
        ),
        (
            "tiangz_navigation_assets",
            "Shared immutable NavMesh assets",
            "gauge",
            snapshot.navigation_assets,
        ),
        (
            "tiangz_navigation_worlds",
            "Live MapInstance NavMesh query contexts",
            "gauge",
            snapshot.navigation_worlds,
        ),
        (
            "tiangz_aoi_entries",
            "Entities attached to AOI",
            "gauge",
            snapshot.aoi_entries,
        ),
        (
            "tiangz_aoi_grids",
            "Occupied flat AOI grids",
            "gauge",
            snapshot.aoi_grids,
        ),
        (
            "tiangz_aoi_candidate_relations",
            "Spatial candidate visibility relations",
            "gauge",
            snapshot.aoi_candidate_relations,
        ),
        (
            "tiangz_aoi_visible_relations",
            "Final visible relations after business filters",
            "gauge",
            snapshot.aoi_visible_relations,
        ),
        (
            "tiangz_aoi_lingering_relations",
            "Visible relations retained only by the AOI detach hysteresis band",
            "gauge",
            snapshot.aoi_lingering_relations,
        ),
        (
            "tiangz_aoi_rejected_relations",
            "Spatial relations rejected by business visibility filters",
            "gauge",
            snapshot.aoi_rejected_relations,
        ),
        (
            "tiangz_aoi_relocations_total",
            "AOI Grid crossings",
            "counter",
            snapshot.aoi_relocations,
        ),
        (
            "tiangz_aoi_visibility_changes_total",
            "Final AOI relation changes",
            "counter",
            snapshot.aoi_visibility_changes,
        ),
        (
            "tiangz_aoi_filter_overrides_total",
            "Business visibility filter overrides",
            "counter",
            snapshot.aoi_filter_overrides,
        ),
    ] {
        writeln!(output, "# HELP {name} {help}").expect("formatting metric help");
        writeln!(output, "# TYPE {name} {metric_type}").expect("formatting metric type");
        writeln!(output, "{name}{{process=\"{process_name}\"}} {value}")
            .expect("formatting metric");
    }
}

fn scene_labels(process_name: &str, scene: &SceneObservabilitySnapshot) -> String {
    let mut labels = BTreeMap::new();
    labels.insert("process", process_name);
    labels.insert("scene", scene.scene.as_str());
    labels.insert("scene_type", scene.scene_type.as_str());
    render_prometheus_labels(&labels)
}

fn render_prometheus_labels(labels: &BTreeMap<&str, &str>) -> String {
    labels
        .iter()
        .map(|(name, value)| format!("{}=\"{}\"", name, escape_prometheus_label(value)))
        .collect::<Vec<_>>()
        .join(",")
}

fn is_prometheus_label_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    matches!(bytes.next(), Some(b'a'..=b'z' | b'A'..=b'Z' | b'_'))
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn escape_prometheus_label(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}

#[cfg(test)]
mod tests {
    use super::*;

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
