#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const datasource = { type: "prometheus", uid: "prometheus" };
const selector = 'env=~"$env",machine=~"$machine",process=~"$process"';
const panels = [];

add("Process 就绪状态", "short", [
  query(`tiangz_process_ready{${selector}}`, "{{process}} ready"),
  query(`tiangz_process_runtime_fresh{${selector}}`, "{{process}} runtime fresh"),
], "none");
add("Prometheus 抓取健康", "short", [
  query(`up{job="tiangz-process-metrics",${selector}}`, "{{process}} scrape"),
], "none", { min: 0, max: 1 });
add("Runtime 心跳年龄", "short", [
  query(`tiangz_process_runtime_heartbeat_age_seconds{${selector}}`, "{{process}}"),
], "s");
add("Process CPU", "short", [
  query(`tiangz_process_cpu_percent{${selector}}`, "{{process}}"),
], "percent");
add("内存与 V8 Heap", "short", [
  query(`tiangz_process_rss_bytes{${selector}}`, "{{process}} RSS"),
  query(`tiangz_process_v8_heap_used_bytes{${selector}}`, "{{process}} V8 used"),
], "bytes");

add("当前连接数", "short", [
  query(`tiangz_process_active_connections{${selector}}`, "{{process}} client"),
  query(`tiangz_transport_inner_active_connections{${selector}}`, "{{process}} inner"),
], "none");
add("Scene 吞吐", "short", [
  query(`sum by (process, scene_type) (rate(tiangz_scene_processed_frames_total{${selector}}[1m]))`, "{{process}}/{{scene_type}} success"),
  query(`sum by (process, scene_type) (rate(tiangz_scene_failed_frames_total{${selector}}[1m]))`, "{{process}}/{{scene_type}} failed"),
], "reqps");
add("端到端阶段延迟", "short", [
  quantile(0.50),
  quantile(0.95),
  quantile(0.99),
], "ms");
add("协议 Handler P99", "short", [
  query(
    `histogram_quantile(0.99, sum by (le, process, scene, msgcode) (rate(tiangz_scene_latency_ms_bucket{${selector},stage="protocol.handler",msgcode!="-"}[1m])))`,
    "{{process}}/{{scene}} msg={{msgcode}}",
  ),
], "ms");

add("Rust 队列占用率", "short", [
  query(`100 * tiangz_process_rust_queue_depth{${selector}} / clamp_min(tiangz_process_rust_queue_capacity{${selector}}, 1)`, "{{process}}"),
], "percent", { min: 0, max: 100 });
add("Scene Mailbox 与异步在途", "short", [
  query(`tiangz_scene_ingress_queue_length{${selector}}`, "{{process}}/{{scene}} mailbox"),
  query(`tiangz_scene_async_in_flight{${selector}}`, "{{process}}/{{scene}} async"),
], "none");
add("Scene 错误分类", "short", [
  query(`sum by (process, scene) (rate(tiangz_scene_system_errors_total{${selector}}[1m]))`, "{{process}}/{{scene}} system"),
  query(`sum by (process, scene) (rate(tiangz_scene_business_errors_total{${selector}}[1m]))`, "{{process}}/{{scene}} business"),
  query(`sum by (process, scene) (rate(tiangz_scene_handler_not_found_total{${selector}}[1m]))`, "{{process}}/{{scene}} missing handler"),
  query(`sum by (process, scene) (rate(tiangz_scene_decode_errors_total{${selector}}[1m]))`, "{{process}}/{{scene}} decode"),
], "ops");
add("背压与慢连接", "short", [
  query(`rate(tiangz_process_backpressure_waits_total{${selector}}[1m])`, "{{process}} backpressure"),
  query(`rate(tiangz_process_slow_disconnects_total{${selector}}[1m])`, "{{process}} slow disconnect"),
], "ops");

add("Inner RPC 等待", "short", [
  query(`tiangz_transport_inner_pending_calls{${selector}}`, "{{process}} pending"),
  query(`tiangz_transport_inner_max_pending_calls{${selector}}`, "{{process}} boot max"),
], "none");
add("Inner RPC 错误率", "short", [
  query(`rate(tiangz_transport_inner_overload_rejections{${selector}}[1m])`, "{{process}} overload"),
  query(`rate(tiangz_transport_inner_timed_out_calls{${selector}}[1m])`, "{{process}} timeout"),
  query(`rate(tiangz_transport_inner_disconnected_calls{${selector}}[1m])`, "{{process}} disconnected"),
  query(`rate(tiangz_transport_inner_late_responses{${selector}}[1m])`, "{{process}} late"),
], "ops");
add("Game.Update 健康度", "short", [
  query(`tiangz_scene_last_update_cost_ms{${selector}}`, "{{process}}/{{scene}} update"),
  query(`rate(tiangz_game_skipped_fixed_updates_total{${selector}}[1m])`, "{{process}} skipped/s"),
], "none");

add("网络吞吐", "short", [
  query(`rate(tiangz_process_transport_read_bytes_total{${selector}}[1m])`, "{{process}} read"),
  query(`rate(tiangz_process_transport_write_bytes_total{${selector}}[1m])`, "{{process}} write"),
], "Bps");
add("V8 GC", "short", [
  query(`rate(tiangz_process_v8_gc_ms_total{${selector}}[1m])`, "{{process}} GC ms/s"),
  query(`rate(tiangz_process_v8_gc_count_total{${selector}}[1m])`, "{{process}} GC/s"),
], "none");
add("Native 编码吞吐", "short", [
  query(`rate(tiangz_native_encoded_bytes_total{${selector}}[1m])`, "{{process}} bytes/s"),
  query(`rate(tiangz_native_encoded_items_total{${selector}}[1m])`, "{{process}} items/s"),
], "none");

add("Map 广播队列", "short", [
  query(`tiangz_scene_custom_metric_gauge{${selector},name="map_broadcast",key="pending_units"}`, "{{process}} pending"),
  query(`tiangz_scene_custom_metric_gauge{${selector},name="map_broadcast",key="in_flight_units"}`, "{{process}} in-flight"),
], "none");
add("Map 广播耗时", "short", [
  query(`tiangz_scene_custom_metric_gauge{${selector},name="map_broadcast",key="last_duration_ms"}`, "{{process}} duration"),
  query(`tiangz_scene_custom_metric_gauge{${selector},name="map_broadcast",key="last_queue_wait_ms"}`, "{{process}} queue wait"),
], "ms");
add("在线 Native Unit", "short", [
  query(`tiangz_native_live_units{${selector}}`, "{{process}}"),
], "none");
add("AOI 空间规模", "short", [
  query(`tiangz_aoi_entries{${selector}}`, "{{process}} entries"),
  query(`tiangz_aoi_grids{${selector}}`, "{{process}} grids"),
  query(`tiangz_aoi_visible_relations{${selector}}`, "{{process}} visible"),
  query(`tiangz_aoi_candidate_relations{${selector}}`, "{{process}} candidates"),
], "none");
add("AOI 关系变化", "short", [
  query(`rate(tiangz_aoi_relocations_total{${selector}}[1m])`, "{{process}} grid crossings/s"),
  query(`rate(tiangz_aoi_visibility_changes_total{${selector}}[1m])`, "{{process}} visibility/s"),
  query(`rate(tiangz_aoi_filter_overrides_total{${selector}}[1m])`, "{{process}} filter overrides/s"),
], "ops");

const dashboard = {
  annotations: { list: [] },
  editable: true,
  fiscalYearStartMonth: 0,
  graphTooltip: 1,
  id: null,
  links: [],
  panels,
  refresh: "5s",
  schemaVersion: 39,
  tags: ["tiangz", "runtime"],
  templating: {
    list: [
      variable("env", "环境", "label_values(tiangz_process_uptime_seconds, env)"),
      variable("machine", "机器", 'label_values(tiangz_process_uptime_seconds{env=~"$env"}, machine)'),
      variable("process", "Process", 'label_values(tiangz_process_uptime_seconds{env=~"$env",machine=~"$machine"}, process)'),
    ],
  },
  time: { from: "now-15m", to: "now" },
  timezone: "browser",
  title: "TiangZ Runtime Overview",
  uid: "tiangz-process-overview",
  version: 1,
};

const output = path.resolve(process.cwd(), outputArgument());
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(dashboard, null, 2)}\n`, "utf8");
console.log(`[grafana] wrote ${panels.length} panels to ${path.relative(process.cwd(), output)}`);

/** 添加一个稳定尺寸的时序面板。 / Adds one fixed-grid time-series panel. */
function add(title, _description, targets, unit, bounds = {}) {
  const index = panels.length;
  panels.push({
    datasource,
    fieldConfig: {
      defaults: {
        color: { mode: "palette-classic" },
        custom: {
          axisCenteredZero: false,
          axisColorMode: "text",
          axisLabel: "",
          axisPlacement: "auto",
          drawStyle: "line",
          fillOpacity: 8,
          gradientMode: "none",
          hideFrom: { legend: false, tooltip: false, viz: false },
          lineInterpolation: "linear",
          lineWidth: 1,
          pointSize: 3,
          scaleDistribution: { type: "linear" },
          showPoints: "never",
          spanNulls: true,
          stacking: { group: "A", mode: "none" },
        },
        min: bounds.min,
        max: bounds.max,
        thresholds: { mode: "absolute", steps: [{ color: "green", value: null }] },
        unit,
      },
      overrides: [],
    },
    gridPos: {
      h: 8,
      w: 8,
      x: (index % 3) * 8,
      y: Math.floor(index / 3) * 8,
    },
    id: index + 1,
    options: {
      legend: { calcs: ["lastNotNull", "max"], displayMode: "table", placement: "bottom", showLegend: true },
      tooltip: { mode: "multi", sort: "desc" },
    },
    targets: targets.map((target, targetIndex) => ({
      ...target,
      refId: String.fromCharCode(65 + targetIndex),
    })),
    title,
    type: "timeseries",
  });
}

/** 定义一条 PromQL 查询。 / Defines one PromQL target. */
function query(expr, legendFormat) {
  return {
    datasource,
    editorMode: "code",
    expr,
    legendFormat,
    range: true,
  };
}

/** 从可聚合 Histogram 中计算延迟分位。 / Calculates a latency quantile from aggregatable histogram buckets. */
function quantile(value) {
  return query(
    `histogram_quantile(${value}, sum by (le, process, stage) (rate(tiangz_scene_latency_ms_bucket{${selector}}[1m])))`,
    `{{process}} {{stage}} p${Math.round(value * 100)}`,
  );
}

/** 生成环境、机器或 Process 筛选变量。 / Builds an environment, machine, or process dashboard variable. */
function variable(name, label, definition) {
  return {
    allValue: ".*",
    current: { selected: false, text: "All", value: "$__all" },
    datasource,
    definition,
    hide: 0,
    includeAll: true,
    label,
    multi: true,
    name,
    options: [],
    query: { query: definition, refId: `variable-${name}` },
    refresh: 2,
    skipUrlSync: false,
    type: "query",
  };
}

function outputArgument() {
  const index = process.argv.indexOf("--output");
  if (index < 0) {
    return "tools/observability/grafana/provisioning/dashboards/files/tiangz-process-overview.json";
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error("--output requires a file path");
  return value;
}
