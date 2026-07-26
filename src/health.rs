//! 提供独立于业务端点的进程存活与就绪探针。 / Provides process liveness and readiness probes independently from business endpoints.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use crate::config::HealthObservabilityConfig;

pub(crate) struct ProcessHealthState {
    live: AtomicBool,
    runtime_ready: AtomicBool,
    endpoints_ready: AtomicBool,
    stopping: AtomicBool,
    started_at: Instant,
    runtime_heartbeat_at: Mutex<Instant>,
    runtime_stale_after: Duration,
    observability_snapshot: Mutex<ProcessObservabilitySnapshot>,
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
    pub(crate) queue_depth: u64,
    pub(crate) queue_capacity: u64,
    pub(crate) queue_max_depth: u64,
    pub(crate) scenes: Vec<SceneObservabilitySnapshot>,
    pub(crate) game: Option<GameObservabilitySnapshot>,
    pub(crate) native_data: Option<NativeDataObservabilitySnapshot>,
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
    pub(crate) async_in_flight: u64,
    pub(crate) max_async_in_flight: u64,
    pub(crate) last_update_cost_ms: f64,
    pub(crate) last_handler_cost_ms: f64,
    pub(crate) max_handler_cost_ms: f64,
    pub(crate) total_handler_cost_ms: f64,
    pub(crate) latencies: Vec<LatencyObservabilitySnapshot>,
    pub(crate) custom_metrics: Vec<SceneCustomMetricSnapshot>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct SceneCustomMetricSnapshot {
    pub(crate) name: String,
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
}

#[derive(Debug, Clone, Default)]
pub(crate) struct NativeDataObservabilitySnapshot {
    pub(crate) scalar_gets: u64,
    pub(crate) scalar_sets: u64,
    pub(crate) batch_calls: u64,
    pub(crate) live_entities: u64,
    pub(crate) live_units: u64,
    pub(crate) encoded_frames: u64,
    pub(crate) encoded_items: u64,
    pub(crate) encoded_bytes: u64,
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

impl HealthServer {
    /// 绑定健康检查端口并启动轻量 HTTP 循环；绑定失败会中止进程启动。
    ///
    /// Binds the health endpoint and starts a lightweight HTTP loop. Bind failure aborts process
    /// startup instead of silently disabling observability.
    pub(crate) async fn start(
        config: &HealthObservabilityConfig,
        process_name: String,
        state: Arc<ProcessHealthState>,
    ) -> Result<Self> {
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
                            Ok((stream, _)) => {
                                let state = Arc::clone(&state);
                                let process_name = process_name.clone();
                                tokio::spawn(async move {
                                    if let Err(error) = serve_connection(stream, &process_name, &state).await {
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
    process_name: &str,
    state: &ProcessHealthState,
) -> Result<()> {
    let mut request = [0_u8; 1024];
    let length = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut request))
        .await
        .context("health request timed out")??;
    let path = std::str::from_utf8(&request[..length])
        .ok()
        .and_then(|text| text.lines().next())
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("");
    let (status, content_type, body) = probe_response(path, process_name, state);
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len(),
    );
    stream.write_all(response.as_bytes()).await?;
    stream.shutdown().await?;
    Ok(())
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

    output
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
    }
}
