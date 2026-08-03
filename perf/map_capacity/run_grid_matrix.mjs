import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const values = parseArgs(process.argv.slice(2));
const options = {
  players: positive(values.get("--players") ?? "3000", "--players"),
  gates: positive(values.get("--gates") ?? "16", "--gates"),
  duration: positive(values.get("--duration") ?? "30", "--duration"),
  warmup: nonNegative(values.get("--warmup") ?? "10", "--warmup"),
  setupConcurrency: positive(
    values.get("--setup-concurrency") ?? "512",
    "--setup-concurrency",
  ),
  // 稀疏地图的初始快照更小，Bench后置RPC更容易集中释放；矩阵固定低并发隔离稳态密度。
  mapEntryConcurrency: positive(
    values.get("--map-entry-concurrency") ?? "8",
    "--map-entry-concurrency",
  ),
  targetMapCpu: positive(values.get("--target-map-cpu") ?? "80", "--target-map-cpu"),
  reportRuns: values.get("--report-runs")?.split(",").filter(Boolean) ?? [],
};

if (options.reportRuns.length !== 0 && options.reportRuns.length !== 3) {
  throw new Error("--report-runs requires three comma-separated run ids for 10x10,15x15,20x20");
}

const reports = [];
for (const [index, worldGrids] of [10, 15, 20].entries()) {
  if (options.reportRuns.length === 0) {
    console.log(`[map-capacity-grid-matrix] running ${worldGrids}x${worldGrids}`);
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "perf", "map_capacity", "run_map_capacity_perf.mjs"),
        "--players", String(options.players),
        "--gates", String(options.gates),
        "--client", "rust",
        "--spawn-layout", "grid-uniform",
        "--world-grids", String(worldGrids),
        "--move-rate", "2",
        "--probe-rate", "0.2",
        "--setup-concurrency", String(options.setupConcurrency),
        "--map-entry-concurrency", String(options.mapEntryConcurrency),
        "--duration", String(options.duration),
        "--warmup", String(options.warmup),
        "--target-map-cpu", String(options.targetMapCpu),
        "--skip-rust-build",
      ],
      { cwd: root, stdio: "inherit" },
    );
    if (result.status !== 0) {
      throw new Error(`${worldGrids}x${worldGrids} capacity run failed with code ${result.status}`);
    }
  }
  reports.push(summarizeReport(worldGrids, options.reportRuns[index]));
}

const generatedAt = new Date().toISOString();
const output = { generatedAt, options, reports };
const resultDir = path.join(root, "perf", "results");
writeFileSync(
  path.join(resultDir, "map_capacity_grid_matrix_latest.json"),
  `${JSON.stringify(output, null, 2)}\n`,
);
writeFileSync(
  path.join(resultDir, "map_capacity_grid_matrix_latest.md"),
  renderMarkdown(generatedAt, options, reports),
);
console.log("[map-capacity-grid-matrix] report: perf/results/map_capacity_grid_matrix_latest.md");

function summarizeReport(worldGrids, runId) {
  const fileName = runId ? `map_capacity_${runId}.json` : "map_capacity_latest.json";
  const payload = JSON.parse(
    readFileSync(path.join(root, "perf", "results", fileName), "utf8"),
  );
  const round = payload.rounds?.[0];
  if (!round || round.worldGrids !== worldGrids || round.players !== options.players) {
    throw new Error(`latest report does not match ${worldGrids}x${worldGrids}`);
  }
  const parameters = payload.parameters ?? {};
  for (const [name, actual, expected] of [
    ["gates", parameters.gates, options.gates],
    ["duration", parameters.duration, options.duration],
    ["warmup", parameters.warmup, options.warmup],
    ["setupConcurrency", parameters.setupConcurrency, options.setupConcurrency],
    ["mapEntryConcurrency", parameters.mapEntryConcurrency, options.mapEntryConcurrency],
  ]) {
    if (Number(actual) !== Number(expected)) {
      throw new Error(`${fileName} ${name}=${actual} does not match requested ${expected}`);
    }
  }
  const map = round.serverResources.map;
  const processes = round.serverResources.processes ?? [];
  const sumProcessCounter = (name) =>
    processes.reduce((total, process) => total + Number(process[name] ?? 0), 0);
  return {
    worldGrids,
    densityPerGrid: options.players / (worldGrids * worldGrids),
    sourceReport: `map_capacity_${payload.runId}.md`,
    mapEntryConcurrency: round.mapEntryConcurrency,
    mapCpuAveragePercent: map.averageCpuPercent,
    mapCpuP90Percent: map.p90CpuPercent,
    mapCpuPeakPercent: map.peakCpuPercent,
    gateMaxAverageCpuPercent: round.serverResources.gateMaxAverageCpuPercent,
    gateMaxPeakCpuPercent: round.serverResources.gateMaxPeakCpuPercent,
    movePerSecond: round.movement.perSecond,
    movementPushesPerSecond: round.movement.pushesPerSecond,
    probePerSecond: round.probe.perSecond,
    probeP50Ms: round.probe.p50Ms,
    probeP95Ms: round.probe.p95Ms,
    probeP99Ms: round.probe.p99Ms,
    aoiCandidateRelations: map.nativeData.aoiCandidateRelations,
    aoiVisibleRelations: map.nativeData.aoiVisibleRelations,
    gridCrossingsPerSecond: map.nativeData.aoiRelocationsPerSecond,
    visibilityChangesPerSecond: map.nativeData.aoiVisibilityChangesPerSecond,
    movementErrors: round.movement.errors,
    probeErrors: round.probe.errors,
    innerOverloads: sumProcessCounter("innerOverloads"),
    innerTimeouts: sumProcessCounter("innerTimeouts"),
    backpressure: sumProcessCounter("backpressure"),
    slowDisconnects: sumProcessCounter("slowDisconnects"),
  };
}

function renderMarkdown(generatedAt, matrixOptions, rows) {
  const lines = [
    "# 3000人AOI Grid密度矩阵",
    "",
    `- 时间：${generatedAt}`,
    `- 拓扑：1 MapHost / ${matrixOptions.gates} Gate / Rust客户端`,
    `- 玩家：${matrixOptions.players}，均匀分布到全部Grid`,
    "- 行为：每玩家2Hz Move、0.2Hz MapProbe；80%在Grid内移动，20%每2秒跨一次Grid",
    `- 进图：连接并发${matrixOptions.setupConcurrency}，Map Enter并发${matrixOptions.mapEntryConcurrency}`,
    `- 正式窗口：预热${matrixOptions.warmup}s，测量${matrixOptions.duration}s`,
    "",
    "| 世界 | 平均人/Grid | candidate/visible | Move/s | Push/s | 跨Grid/s | Map CPU avg/p90/peak | Gate max avg/peak | Probe p50/p95/p99 | 错误/过载/超时/背压/慢连接 |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rows.map((row) =>
      `| ${row.worldGrids}x${row.worldGrids} | ${format(row.densityPerGrid, 2)} | ${integer(row.aoiCandidateRelations)}/${integer(row.aoiVisibleRelations)} | ${integer(row.movePerSecond)} | ${integer(row.movementPushesPerSecond)} | ${format(row.gridCrossingsPerSecond, 1)} | ${format(row.mapCpuAveragePercent, 1)}/${format(row.mapCpuP90Percent, 1)}/${format(row.mapCpuPeakPercent, 1)}% | ${format(row.gateMaxAverageCpuPercent, 1)}/${format(row.gateMaxPeakCpuPercent, 1)}% | ${format(row.probeP50Ms, 2)}/${format(row.probeP95Ms, 2)}/${format(row.probeP99Ms, 2)}ms | ${row.movementErrors + row.probeErrors}/${row.innerOverloads}/${row.innerTimeouts}/${row.backpressure}/${row.slowDisconnects} |`,
    ),
    "",
    "## 原始报告",
    "",
    ...rows.map((row) => `- ${row.worldGrids}x${row.worldGrids}：[${row.sourceReport}](${row.sourceReport})`),
    "",
    "矩阵只比较所有玩家完成进图后的稳态窗口。Map Enter使用固定低并发，避免初始快照大小改变Bench后置RPC的释放节奏，从而污染空间密度结论。",
    "",
  ];
  return lines.join("\n");
}

function parseArgs(args) {
  const result = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith("--") || index + 1 >= args.length) throw new Error(`invalid argument: ${key}`);
    result.set(key, args[++index]);
  }
  return result;
}

function positive(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be greater than zero`);
  return parsed;
}

function nonNegative(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be non-negative`);
  return parsed;
}

function format(value, digits) {
  return Number(value).toFixed(digits).replace(/\.0+$/, "");
}

function integer(value) {
  return Math.round(Number(value)).toLocaleString("en-US");
}
