import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const resultDir = path.join(root, "perf", "results");
const runner = path.join(root, "perf", "map_capacity", "run_map_capacity_perf.mjs");
const forwarded = process.argv.slice(2);
const modes = ["attach-only", "new-observer-only", "existing-observers-only", "full"];

const defaults = [];
addDefault("--players", "1000");
addDefault("--gates", "8");
addDefault("--client", "rust");
addDefault("--spawn-layout", "single-grid");
addDefault("--setup-concurrency", "16");
addDefault("--post-setup-settle", "5");
addDefault("--warmup", "0");
addDefault("--duration", "5");
addDefault("--rounds", "1");
addDefault("--probe-rate", "0.2");
addDefault("--timeout", "120000");
if (!forwarded.includes("--probe-only")) defaults.push("--probe-only");

mkdirSync(resultDir, { recursive: true });
const results = [];
for (const mode of modes) {
  console.log(`\n[map-entry-stages] mode=${mode}`);
  const child = spawnSync(
    process.execPath,
    [runner, ...defaults, ...forwarded, "--entry-sync-mode", mode, "--skip-rust-build"],
    { cwd: root, stdio: "inherit" },
  );
  if (child.status !== 0) {
    throw new Error(`map entry stage ${mode} failed with code ${child.status}`);
  }
  const report = JSON.parse(
    readFileSync(path.join(resultDir, "map_capacity_latest.json"), "utf8"),
  );
  if (report.parameters?.entrySyncMode !== mode) {
    throw new Error(`map entry stage result mismatch: expected ${mode}`);
  }
  const value = report.cases?.[0]?.median;
  const setup = report.rounds?.[0]?.setup;
  if (!value || !setup) throw new Error(`map entry stage ${mode} returned no case data`);
  results.push({ mode, runId: report.runId, players: report.cases[0].players, setup, value });
}
assertStageSemantics(results);

const generatedAt = new Date().toISOString();
const stamp = generatedAt.replace(/[-:TZ.]/g, "").slice(0, 14);
const output = {
  generatedAt,
  semanticAssertions: "passed",
  parameters: { defaults, forwarded },
  stages: results,
};
const json = JSON.stringify(output, null, 2) + "\n";
const markdown = renderMarkdown(output);
for (const [name, content] of [
  [`map_entry_stages_${stamp}.json`, json],
  [`map_entry_stages_${stamp}.md`, markdown],
  ["map_entry_stages_latest.json", json],
  ["map_entry_stages_latest.md", markdown],
]) {
  writeFileSync(path.join(resultDir, name), content, "utf8");
}
console.log(`\n[map-entry-stages] report: ${path.join(resultDir, "map_entry_stages_latest.md")}`);
console.log(markdown);

function addDefault(name, value) {
  if (!forwarded.includes(name)) defaults.push(name, value);
}

function assertStageSemantics(stages) {
  const expectations = new Map([
    ["attach-only", { snapshot: false, existingEnter: false }],
    ["new-observer-only", { snapshot: true, existingEnter: false }],
    ["existing-observers-only", { snapshot: false, existingEnter: true }],
    ["full", { snapshot: true, existingEnter: true }],
  ]);

  for (const stage of stages) {
    const expected = expectations.get(stage.mode);
    if (!expected) throw new Error(`unexpected map entry stage: ${stage.mode}`);
    assertZero(stage, "mapEntryFailures");
    assertZero(stage, "playerEntryFailures");
    assertEnabled(stage, "playerEntrySnapshotCalls", expected.snapshot);
    if (!expected.snapshot) assertZero(stage, "playerEntrySnapshotItems");

    const requiresExistingObserverDelivery = expected.existingEnter && stage.players > 1;
    assertEnabled(stage, "aoiDeltaEnterItems", requiresExistingObserverDelivery);
    assertEnabled(stage, "aoiDeltaDeliveries", requiresExistingObserverDelivery);
  }
  console.log("[map-entry-stages] semantic assertions passed");
}

function assertEnabled(stage, field, enabled) {
  const value = Number(stage.value[field] ?? 0);
  if (enabled ? value <= 0 : value !== 0) {
    throw new Error(
      `map entry stage ${stage.mode} expected ${field} ${enabled ? "> 0" : "= 0"}, got ${value}`,
    );
  }
}

function assertZero(stage, field) {
  assertEnabled(stage, field, false);
}

function renderMarkdown(report) {
  const lines = [
    "# 地图进图阶段A/B报告",
    "",
    `- 时间：${report.generatedAt}`,
    "- 顺序：Attach Only -> 新玩家快照 -> 老玩家Enter -> 完整语义",
    "- 诊断模式只用于拆分成本；只有`full`具备可上线的完整进图语义。",
    "- 四阶段语义断言：通过。禁用路径为0，启用路径在多人场景产生对应数据，且进图无失败。",
    "",
    "## 客户端Setup",
    "",
    "| 模式 | 玩家 | setup耗时 | setup/s | p50 | p95 | p99 | max |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const stage of report.stages) {
    lines.push(
      `| ${stage.mode} | ${stage.players} | ${number(stage.setup.elapsedSeconds, 2)}s | ` +
      `${number(stage.setup.perSecond, 1)} | ${number(stage.setup.p50Ms, 2)}ms | ` +
      `${number(stage.setup.p95Ms, 2)}ms | ${number(stage.setup.p99Ms, 2)}ms | ` +
      `${number(stage.setup.maxMs, 2)}ms |`,
    );
  }
  lines.push(
    "",
    "## MapHost与Admission",
    "",
    "| 模式 | max in-flight | Enter avg/max | 排队 avg/max | Attach avg/max | 可见变化 |",
    "|---|---:|---:|---:|---:|---:|",
  );
  for (const { mode, value } of report.stages) {
    lines.push(
      `| ${mode} | ${number(value.mapEntryMaxInFlight)} | ` +
      `${number(value.mapEntryAverageDurationMs, 2)}/${number(value.mapEntryMaxDurationMs, 2)}ms | ` +
      `${number(value.playerEntryQueueWaitAverageMs, 2)}/${number(value.playerEntryQueueWaitMaxMs, 2)}ms | ` +
      `${number(value.playerEntryAttachAverageMs, 3)}/${number(value.playerEntryAttachMaxMs, 3)}ms | ` +
      `${number(value.playerEntryVisibilityChanges)} |`,
    );
  }
  lines.push(
    "",
    "## 初始状态与下行",
    "",
    "| 模式 | Snapshot calls/items(avg) | 实际构造/物化 | 受众复用/Unit复用 | Snapshot avg/max | Enter items | recipients | deliveries | Map写入 | Gate逻辑下行 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const { mode, value } of report.stages) {
    lines.push(
      `| ${mode} | ${number(value.playerEntrySnapshotCalls)}/${number(value.playerEntrySnapshotItems)}(${number(value.playerEntrySnapshotAverageItems, 1)}) | ` +
      `${number(value.playerEntrySnapshotBuilds)}/${number(value.playerEntrySnapshotMaterializedItems)} | ` +
      `${number(value.playerEntrySnapshotAudienceReuseHits)}/${number(value.playerEntrySnapshotUnitReuseHits)} | ` +
      `${number(value.playerEntrySnapshotAverageMs, 3)}/${number(value.playerEntrySnapshotMaxMs, 3)}ms | ` +
      `${number(value.aoiDeltaEnterItems)} | ${number(value.aoiDeltaRecipients)} | ` +
      `${number(value.aoiDeltaDeliveries)} | ${bytes(value.mapLifecycleTransportWriteBytes)} | ` +
      `${bytes(value.gateLifecycleOutboundLogicalBytes)} |`,
    );
  }
  lines.push(
    "",
    "## 判断方法",
    "",
    "- `new-observer-only - attach-only`主要反映给新玩家构造并返回全量视图的成本。",
    "- `existing-observers-only - attach-only`主要反映给已有玩家发布新Subject的成本。",
    "- `full`是最终权威结果；异步批处理和共享编码使它不一定等于前三项简单相加。",
    "",
  );
  return lines.join("\n");
}

function number(value, digits = 0) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric.toFixed(digits) : "0";
}

function bytes(value) {
  const numeric = Number(value ?? 0);
  if (numeric >= 1024 ** 3) return `${number(numeric / 1024 ** 3, 2)}GB`;
  if (numeric >= 1024 ** 2) return `${number(numeric / 1024 ** 2, 2)}MB`;
  if (numeric >= 1024) return `${number(numeric / 1024, 2)}KB`;
  return `${number(numeric)}B`;
}
