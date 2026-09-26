//! 将健康快照格式化为 Prometheus 文本，标签转义与直方图约定保持集中。 / Formats health snapshots as Prometheus text, keeping label escaping and histogram conventions together.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use super::{
    DbProxyClientObservabilitySnapshot, GameConfigObservabilitySnapshot, GameObservabilitySnapshot,
    HotfixObservabilitySnapshot, MailboxObservabilitySnapshot, NativeDataObservabilitySnapshot,
    ProcessHealthState, ProcessObservabilitySnapshot, SceneCustomMetricKind,
    SceneObservabilitySnapshot,
};

pub(super) fn format_prometheus_metrics(process_name: &str, state: &ProcessHealthState) -> String {
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
        (
            "tiangz_dbproxy_request_stage_ms",
            "Completed DBProxy attempt stages; exchange includes network and server work, not SQL alone",
            "histogram",
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
        for latency in &endpoint.request_latencies {
            let stage = escape_prometheus_label(&latency.name);
            let labels = format!("{labels},stage=\"{stage}\"");
            let mut cumulative = 0_u64;
            for (bound, count) in latency.bounds_ms.iter().zip(&latency.bucket_counts) {
                cumulative += count;
                writeln!(
                    output,
                    "tiangz_dbproxy_request_stage_ms_bucket{{{labels},le=\"{bound}\"}} {cumulative}"
                )
                .expect("formatting DBProxy latency bucket");
            }
            writeln!(
                output,
                "tiangz_dbproxy_request_stage_ms_bucket{{{labels},le=\"+Inf\"}} {}",
                latency.count
            )
            .expect("formatting DBProxy latency infinity bucket");
            writeln!(
                output,
                "tiangz_dbproxy_request_stage_ms_count{{{labels}}} {}",
                latency.count
            )
            .expect("formatting DBProxy latency count");
            writeln!(
                output,
                "tiangz_dbproxy_request_stage_ms_sum{{{labels}}} {:.3}",
                latency.sum_ms
            )
            .expect("formatting DBProxy latency sum");
        }
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
    for (name, help, kind, value) in [
        (
            "tiangz_process_host_event_batch_limit_bytes",
            "Hard logical byte limit for each Rust to V8 event batch including headers",
            "gauge",
            snapshot.host_event_batch_limit_bytes,
        ),
        (
            "tiangz_process_host_event_batch_max_bytes",
            "Largest logical event batch handed to V8 including shutdown completions",
            "gauge",
            snapshot.max_host_event_batch_bytes,
        ),
        (
            "tiangz_process_host_event_batch_splits_total",
            "Batches ended early to preserve the event byte limit",
            "counter",
            snapshot.host_event_batch_splits,
        ),
    ] {
        writeln!(output, "# HELP {name} {help}\n# TYPE {name} {kind}\n{name}{{process=\"{process_name}\"}} {value}")
            .expect("formatting host event batch metric");
    }
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
        "# HELP tiangz_transport_admission_in_use Shared business listener admission slots in use"
    )
    .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_transport_admission_in_use gauge")
        .expect("formatting metric type");
    writeln!(output, "# HELP tiangz_transport_admission_limit Configured shared business listener admission limit")
        .expect("formatting metric help");
    writeln!(output, "# TYPE tiangz_transport_admission_limit gauge")
        .expect("formatting metric type");
    writeln!(output, "# HELP tiangz_transport_admission_rejections_total Business listener admissions rejected immediately at capacity")
        .expect("formatting metric help");
    writeln!(
        output,
        "# TYPE tiangz_transport_admission_rejections_total counter"
    )
    .expect("formatting metric type");
    for (kind, used, limit, rejected) in [
        (
            "connection",
            snapshot.admission.connections,
            snapshot.admission.connection_limit,
            snapshot.admission.connection_rejections,
        ),
        (
            "handshake",
            snapshot.admission.handshakes,
            snapshot.admission.handshake_limit,
            snapshot.admission.handshake_rejections,
        ),
    ] {
        for (metric, value) in [
            ("in_use", used),
            ("limit", limit),
            ("rejections_total", rejected),
        ] {
            writeln!(output, "tiangz_transport_admission_{metric}{{process=\"{process_name}\",kind=\"{kind}\"}} {value}")
                .expect("formatting admission metric");
        }
    }
    for (metric, kind, description, outbound, ingress, kcp) in [
        (
            "bytes",
            "gauge",
            "Reserved transport buffer bytes by kind, using conservative native bounds for KCP",
            snapshot.outbound_buffers.used_bytes,
            snapshot.ingress_buffers.used_bytes,
            snapshot.kcp_buffers.used_bytes,
        ),
        (
            "limit_bytes",
            "gauge",
            "Configured shared transport buffer byte limit by kind",
            snapshot.outbound_buffers.limit_bytes,
            snapshot.ingress_buffers.limit_bytes,
            snapshot.kcp_buffers.limit_bytes,
        ),
        (
            "rejections_total",
            "counter",
            "Transport buffer admissions rejected at the shared byte limit by kind",
            snapshot.outbound_buffers.rejections,
            snapshot.ingress_buffers.rejections,
            snapshot.kcp_buffers.rejections,
        ),
    ] {
        writeln!(
            output,
            "# HELP tiangz_transport_buffer_{metric} {description}"
        )
        .expect("formatting buffer help");
        writeln!(output, "# TYPE tiangz_transport_buffer_{metric} {kind}")
            .expect("formatting buffer type");
        for (buffer_kind, value) in [("outbound", outbound), ("ingress", ingress), ("kcp", kcp)] {
            writeln!(output, "tiangz_transport_buffer_{metric}{{process=\"{process_name}\",kind=\"{buffer_kind}\"}} {value}")
                .expect("formatting buffer metric");
        }
    }
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
    for (name, kind, help, value) in [
        (
            "tiangz_scene_tasks_in_flight",
            "gauge",
            "Accepted Spawn tasks including disposed owners until actual completion",
            snapshot.scene_task_in_flight,
        ),
        (
            "tiangz_scene_tasks_capacity",
            "gauge",
            "Process-wide Spawn task limit",
            snapshot.scene_task_capacity,
        ),
        (
            "tiangz_scene_tasks_max_in_flight",
            "gauge",
            "Maximum successfully admitted concurrent Spawn tasks",
            snapshot.scene_task_max_in_flight,
        ),
        (
            "tiangz_scene_tasks_rejected_total",
            "counter",
            "Spawn attempts rejected by the Process-wide limit, excluding Scope-local limits",
            snapshot.scene_task_rejections,
        ),
        (
            "tiangz_process_actor_mailbox_tasks_in_flight",
            "gauge",
            "Accepted queued and executing Actor calls, including disposed running owners",
            snapshot.actor_mailbox_in_flight,
        ),
        (
            "tiangz_process_actor_mailbox_tasks_capacity",
            "gauge",
            "Process-wide Actor mailbox task limit",
            snapshot.actor_mailbox_capacity,
        ),
        (
            "tiangz_process_actor_mailbox_tasks_per_actor_capacity",
            "gauge",
            "Task limit for each Actor mailbox",
            snapshot.actor_mailbox_per_actor_capacity,
        ),
        (
            "tiangz_process_actor_mailbox_tasks_max_in_flight",
            "gauge",
            "Maximum admitted concurrent Actor mailbox tasks",
            snapshot.actor_mailbox_max_in_flight,
        ),
        (
            "tiangz_process_actor_mailbox_tasks_actor_rejected_total",
            "counter",
            "Calls rejected by the per-Actor limit, checked before the Process limit",
            snapshot.actor_mailbox_actor_rejections,
        ),
        (
            "tiangz_process_actor_mailbox_tasks_process_rejected_total",
            "counter",
            "Calls rejected by the Process limit after passing the per-Actor limit",
            snapshot.actor_mailbox_process_rejections,
        ),
        (
            "tiangz_local_scene_mailbox_tasks_in_flight",
            "gauge",
            "Accepted local Scene calls until execution completes, including queued void work",
            snapshot.local_scene_mailbox_in_flight,
        ),
        (
            "tiangz_local_scene_mailbox_tasks_capacity",
            "gauge",
            "Process-wide local Scene call limit, excluding network ingress",
            snapshot.local_scene_mailbox_capacity,
        ),
        (
            "tiangz_local_scene_mailbox_tasks_per_scene_capacity",
            "gauge",
            "Local call limit for each EntryScene",
            snapshot.local_scene_mailbox_per_scene_capacity,
        ),
        (
            "tiangz_local_scene_mailbox_tasks_max_in_flight",
            "gauge",
            "Maximum admitted concurrent local Scene calls",
            snapshot.local_scene_mailbox_max_in_flight,
        ),
        (
            "tiangz_local_scene_mailbox_tasks_scene_rejected_total",
            "counter",
            "Local calls rejected by the per-Scene limit, checked before the Process limit",
            snapshot.local_scene_mailbox_scene_rejections,
        ),
        (
            "tiangz_local_scene_mailbox_tasks_process_rejected_total",
            "counter",
            "Local calls rejected by the Process limit after passing the per-Scene limit",
            snapshot.local_scene_mailbox_process_rejections,
        ),
    ] {
        writeln!(output, "# HELP {name} {help}").expect("formatting metric help");
        writeln!(output, "# TYPE {name} {kind}").expect("formatting metric type");
        writeln!(output, "{name}{{process=\"{process_name}\"}} {value}")
            .expect("formatting metric");
    }
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
