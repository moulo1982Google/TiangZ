//! 采样运行时资源并转换指标快照，不拥有调度队列、V8 回调或指针生命周期。 / Samples runtime resources and converts metric snapshots without owning scheduling queues, V8 callbacks or pointer lifetimes.

use std::collections::BTreeMap;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use sysinfo::{Pid, ProcessesToUpdate, System};

use super::{ProcessEventKind, ProcessIngressClass, ProcessQueueStats, V8GcMetrics};
use crate::health::{
    GameObservabilitySnapshot, LatencyObservabilitySnapshot, MailboxObservabilitySnapshot,
    NativeDataObservabilitySnapshot, ProcessHealthState, ProcessObservabilitySnapshot,
    ProcessQueueStageObservabilitySnapshot, SceneCustomMetricKind, SceneCustomMetricSnapshot,
    SceneObservabilitySnapshot, TransportDiagnosticObservabilitySnapshot,
    TransportOverloadStageObservabilitySnapshot,
};
use crate::transport::snapshot_remote_transport;
use crate::transport_backend::ConnectionWriters;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativeDataMetricsSnapshot {
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
pub(super) struct GameMetricsSnapshot {
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
    #[serde(default)]
    scene_task_in_flight: u64,
    #[serde(default)]
    scene_task_capacity: u64,
    #[serde(default)]
    scene_task_max_in_flight: u64,
    #[serde(default)]
    scene_task_rejections: u64,
    #[serde(default)]
    actor_mailbox_in_flight: u64,
    #[serde(default)]
    actor_mailbox_capacity: u64,
    #[serde(default)]
    actor_mailbox_per_actor_capacity: u64,
    #[serde(default)]
    actor_mailbox_max_in_flight: u64,
    #[serde(default)]
    actor_mailbox_actor_rejections: u64,
    #[serde(default)]
    actor_mailbox_process_rejections: u64,
    #[serde(default)]
    local_scene_mailbox_in_flight: u64,
    #[serde(default)]
    local_scene_mailbox_capacity: u64,
    #[serde(default)]
    local_scene_mailbox_per_scene_capacity: u64,
    #[serde(default)]
    local_scene_mailbox_max_in_flight: u64,
    #[serde(default)]
    local_scene_mailbox_scene_rejections: u64,
    #[serde(default)]
    local_scene_mailbox_process_rejections: u64,
    #[serde(default)]
    host_scene_queued_operations: u64,
    #[serde(default)]
    host_scene_queued_bytes: u64,
    #[serde(default)]
    host_scene_pending_replies: u64,
    #[serde(default)]
    host_scene_queue_capacity: u64,
    #[serde(default)]
    host_scene_queue_byte_capacity: u64,
    #[serde(default)]
    host_scene_pending_capacity: u64,
    #[serde(default)]
    host_scene_queue_rejections: u64,
    #[serde(default)]
    host_scene_byte_rejections: u64,
    #[serde(default)]
    host_scene_pending_rejections: u64,
    #[serde(default)]
    host_scene_invalid_frames: u64,
    #[serde(default)]
    host_scene_submit_failures: u64,
    #[serde(default)]
    host_scene_queue_timeouts: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SceneMetricsSnapshot {
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
pub(super) struct MailboxMetricsSnapshot {
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
    labels: BTreeMap<String, String>,
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

// Metrics are sampled from independent owners; a parameter object would be an
// allocation-oriented facade with no stronger invariant.
#[allow(clippy::too_many_arguments)]
pub(super) fn maybe_log_metrics(
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
            let fields = custom
                .labels
                .iter()
                .map(|(name, value)| format!("{name}={value}"))
                .chain(
                    custom
                        .values
                        .iter()
                        .map(|(name, value)| format!("{name}={value}")),
                )
                .collect::<Vec<_>>()
                .join(" ");
            tracing::info!(target: "tiangz::metrics",
                "[custom-metrics:{process_name}] scene={} type={} name={} timestamp_ms={} {}",
                metric.scene, metric.scene_type, custom.name, timestamp_ms, fields,
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
                    labels: item.labels.clone(),
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
        scene_task_in_flight: game.scene_task_in_flight,
        scene_task_capacity: game.scene_task_capacity,
        scene_task_max_in_flight: game.scene_task_max_in_flight,
        scene_task_rejections: game.scene_task_rejections,
        actor_mailbox_in_flight: game.actor_mailbox_in_flight,
        actor_mailbox_capacity: game.actor_mailbox_capacity,
        actor_mailbox_per_actor_capacity: game.actor_mailbox_per_actor_capacity,
        actor_mailbox_max_in_flight: game.actor_mailbox_max_in_flight,
        actor_mailbox_actor_rejections: game.actor_mailbox_actor_rejections,
        actor_mailbox_process_rejections: game.actor_mailbox_process_rejections,
        local_scene_mailbox_in_flight: game.local_scene_mailbox_in_flight,
        local_scene_mailbox_capacity: game.local_scene_mailbox_capacity,
        local_scene_mailbox_per_scene_capacity: game.local_scene_mailbox_per_scene_capacity,
        local_scene_mailbox_max_in_flight: game.local_scene_mailbox_max_in_flight,
        local_scene_mailbox_scene_rejections: game.local_scene_mailbox_scene_rejections,
        local_scene_mailbox_process_rejections: game.local_scene_mailbox_process_rejections,
        host_scene_queued_operations: game.host_scene_queued_operations,
        host_scene_queued_bytes: game.host_scene_queued_bytes,
        host_scene_pending_replies: game.host_scene_pending_replies,
        host_scene_queue_capacity: game.host_scene_queue_capacity,
        host_scene_queue_byte_capacity: game.host_scene_queue_byte_capacity,
        host_scene_pending_capacity: game.host_scene_pending_capacity,
        host_scene_queue_rejections: game.host_scene_queue_rejections,
        host_scene_byte_rejections: game.host_scene_byte_rejections,
        host_scene_pending_rejections: game.host_scene_pending_rejections,
        host_scene_invalid_frames: game.host_scene_invalid_frames,
        host_scene_submit_failures: game.host_scene_submit_failures,
        host_scene_queue_timeouts: game.host_scene_queue_timeouts,
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
        native_workers: runtime
            .op_state()
            .borrow()
            .borrow::<crate::native_worker::Registry>()
            .snapshot(),
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
        host_event_batch_limit_bytes: super::host_events::HOST_EVENT_BATCH_MAX_BYTES as u64,
        max_host_event_batch_bytes: queue_stats
            .max_host_event_batch_bytes
            .load(Ordering::Relaxed) as u64,
        host_event_batch_splits: queue_stats.host_event_batch_splits.load(Ordering::Relaxed),
        host_backing_store: queue_stats.host_backing_store.snapshot(),
        host_event_buffers: queue_stats.host_events.snapshot(),
        host_disconnect_buffers: queue_stats.host_events.disconnect_snapshot(),
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
        admission: queue_stats.admission.snapshot(),
        outbound_buffers: queue_stats.outbound_buffers.snapshot(),
        host_scene_batches: queue_stats.host_scene_batches.snapshot(),
        control_admission: queue_stats.control_admission.snapshot(),
        ingress_buffers: queue_stats.ingress_buffers.snapshot(),
        kcp_buffers: queue_stats.kcp_buffers.snapshot(),
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
        dbproxy: crate::dbproxy::metrics_snapshot(),
    });
}

#[cfg(test)]
mod tests {
    use super::super::UpdateResult;
    use super::*;

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
                    "coroutineLockTimeouts": 7,
                    "sceneTaskInFlight": 17,
                    "sceneTaskCapacity": 4096,
                    "sceneTaskMaxInFlight": 4096,
                    "sceneTaskRejections": 3,
                    "actorMailboxInFlight": 21,
                    "actorMailboxCapacity": 16384,
                    "actorMailboxPerActorCapacity": 4096,
                    "actorMailboxMaxInFlight": 16384,
                    "actorMailboxActorRejections": 4,
                    "actorMailboxProcessRejections": 5,
                    "localSceneMailboxInFlight": 29,
                    "localSceneMailboxCapacity": 16384,
                    "localSceneMailboxPerSceneCapacity": 4096,
                    "localSceneMailboxMaxInFlight": 16384,
                    "localSceneMailboxSceneRejections": 6,
                    "localSceneMailboxProcessRejections": 7,
                    "hostSceneQueuedOperations": 3,
                    "hostSceneQueuedBytes": 59,
                    "hostScenePendingReplies": 2,
                    "hostSceneQueueCapacity": 65536,
                    "hostSceneQueueByteCapacity": 67108864,
                    "hostScenePendingCapacity": 65536,
                    "hostSceneQueueRejections": 10,
                    "hostSceneByteRejections": 20,
                    "hostScenePendingRejections": 30,
                    "hostSceneInvalidFrames": 40,
                    "hostSceneSubmitFailures": 50,
                    "hostSceneQueueTimeouts": 60
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
        assert_eq!(game.scene_task_in_flight, 17);
        assert_eq!(game.scene_task_capacity, 4096);
        assert_eq!(game.scene_task_max_in_flight, 4096);
        assert_eq!(game.scene_task_rejections, 3);
        assert_eq!(game.actor_mailbox_in_flight, 21);
        assert_eq!(game.actor_mailbox_capacity, 16384);
        assert_eq!(game.actor_mailbox_per_actor_capacity, 4096);
        assert_eq!(game.actor_mailbox_max_in_flight, 16384);
        assert_eq!(game.actor_mailbox_actor_rejections, 4);
        assert_eq!(game.actor_mailbox_process_rejections, 5);
        assert_eq!(game.local_scene_mailbox_in_flight, 29);
        assert_eq!(game.local_scene_mailbox_capacity, 16384);
        assert_eq!(game.local_scene_mailbox_per_scene_capacity, 4096);
        assert_eq!(game.local_scene_mailbox_max_in_flight, 16384);
        assert_eq!(game.local_scene_mailbox_scene_rejections, 6);
        assert_eq!(game.local_scene_mailbox_process_rejections, 7);
        assert_eq!(game.host_scene_queued_operations, 3);
        assert_eq!(game.host_scene_queued_bytes, 59);
        assert_eq!(game.host_scene_pending_replies, 2);
        assert_eq!(game.host_scene_queue_capacity, 65536);
        assert_eq!(game.host_scene_queue_byte_capacity, 67108864);
        assert_eq!(game.host_scene_pending_capacity, 65536);
        assert_eq!(game.host_scene_queue_rejections, 10);
        assert_eq!(game.host_scene_byte_rejections, 20);
        assert_eq!(game.host_scene_pending_rejections, 30);
        assert_eq!(game.host_scene_invalid_frames, 40);
        assert_eq!(game.host_scene_submit_failures, 50);
        assert_eq!(game.host_scene_queue_timeouts, 60);
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
