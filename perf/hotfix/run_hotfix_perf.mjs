import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SanitizePerformanceReport } from "../lib/sanitize_report.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = parseArgs(process.argv.slice(2));
const resultDir = path.join(root, "perf", "results");
const normalCandidate = path.join(root, "dist", "hotfix-candidates", "perf-normal");
const invertedCandidate = path.join(root, "dist", "hotfix-candidates", "perf-inverted");
mkdirSync(resultDir, { recursive: true });

await prepare();
const previous = args.reloadOnly
  ? JSON.parse(readFileSync(path.join(resultDir, "hotfix_latest.json"), "utf8"))
  : undefined;
const baseline = previous?.baseline?.report ?? await runMode("baseline");
if (!args.reloadOnly) await sleep(2_000);
const reload = await runMode("reload");
const report = createReport(baseline, reload);
const stamp = timestamp();
const jsonPath = path.join(resultDir, `hotfix_${stamp}.json`);
const markdownPath = path.join(resultDir, `hotfix_${stamp}.md`);
writeJson(jsonPath, report);
writeJson(path.join(resultDir, "hotfix_latest.json"), report);
const markdown = renderMarkdown(report);
writeFileSync(markdownPath, markdown, "utf8");
writeFileSync(path.join(resultDir, "hotfix_latest.md"), markdown, "utf8");
console.log(`[hotfix-perf] report: ${markdownPath}`);
console.log(markdown);

async function prepare() {
  if (args.skipBuild) return;
  await run("npm", ["run", "build:bench"]);
  await run("npm", ["run", "build:perf:full-chain"]);
  await run(process.execPath, [
    "tools/build_runtime_bundles.mjs", "--bench", "--hotfix-only",
    "--hotfix-out", path.relative(root, normalCandidate),
  ]);
  await run(process.execPath, [
    "tools/build_runtime_bundles.mjs", "--bench", "--hotfix-only",
    "--hotfix-entry", "perf/hotfix/fixtures/inverted.ts",
    "--hotfix-out", path.relative(root, invertedCandidate),
  ]);
  await run("cargo", ["build", "--release", "--locked", "--bin", "TiangZ", "--bin", "map_probe_load"]);
}

async function runMode(mode) {
  console.log(`[hotfix-perf] starting ${mode}`);
  await run(process.execPath, [
    "perf/map_capacity/run_map_capacity_perf.mjs",
    "--skip-rust-build",
    "--client", "rust",
    "--gates", String(args.gates),
    "--players", String(args.players),
    "--move-rate", String(args.moveRate),
    "--movement-hold-messages", String(args.movementHoldMessages),
    "--probe-rate", String(args.probeRate),
    "--probe-concurrency", "1",
    "--setup-concurrency", String(args.setupConcurrency),
    "--warmup", String(args.warmup),
    "--duration", String(args.duration),
    "--rounds", String(args.rounds),
    "--target-map-cpu", String(args.targetMapCpu),
    "--manager-port", mode === "baseline" ? "13000" : "16000",
    "--login-port", mode === "baseline" ? "13001" : "16001",
    "--gate-base-port", mode === "baseline" ? "13201" : "16201",
    "--map-port", mode === "baseline" ? "13301" : "16301",
    "--health-base-port", mode === "baseline" ? "13800" : "16800",
    "--source-ip-base", mode === "baseline" ? "2" : String(args.reloadSourceIpBase),
    "--hotfix-mode", mode,
    "--hotfix-interval-ms", String(args.hotfixIntervalMs),
    "--hotfix-candidates", `${normalCandidate},${invertedCandidate}`,
  ]);
  return JSON.parse(readFileSync(path.join(resultDir, "map_capacity_latest.json"), "utf8"));
}

function createReport(baseline, reload) {
  const baselineMedian = baseline.cases[0].median;
  const reloadMedian = reload.cases[0].median;
  const reloadSamples = reload.rounds.flatMap((round) => round.hotfix?.samples ?? []);
  const completedSamples = reloadSamples.filter((sample) => sample.completed);
  const mapTimings = completedSamples.map((sample) => sample.map);
  return {
    generatedAt: new Date().toISOString(),
    parameters: args,
    machine: {
      cpu: os.cpus()[0]?.model ?? "unknown",
      logicalCpus: os.cpus().length,
      memoryBytes: os.totalmem(),
      os: `${os.platform()} ${os.release()}`,
    },
    baseline: { report: baseline, median: baselineMedian },
    reload: { report: reload, median: reloadMedian },
    comparison: {
      movesPerSecondPercent: percentChange(baselineMedian.movesPerSecond, reloadMedian.movesPerSecond),
      probeP50Percent: percentChange(baselineMedian.probeP50Ms, reloadMedian.probeP50Ms),
      probeP95Percent: percentChange(baselineMedian.probeP95Ms, reloadMedian.probeP95Ms),
      probeP99Percent: percentChange(baselineMedian.probeP99Ms, reloadMedian.probeP99Ms),
      mapCpuPercent: percentChange(baselineMedian.mapCpuAverage, reloadMedian.mapCpuAverage),
      gateCpuPercent: percentChange(baselineMedian.gateMaxCpuAverage, reloadMedian.gateMaxCpuAverage),
      serverRssPercent: percentChange(baselineMedian.serverRssBytes, reloadMedian.serverRssBytes),
    },
    hotfix: {
      formalWindowAttempts: sum(reload.rounds.map((round) => round.hotfix?.formalWindowAttempts ?? 0)),
      formalWindowCompleted: sum(reload.rounds.map((round) => round.hotfix?.formalWindowCompleted ?? 0)),
      formalWindowMissed: sum(reload.rounds.map((round) => round.hotfix?.formalWindowMissed ?? 0)),
      mapPreflightP50Ms: percentile(mapTimings.map((item) => item.preflightMs), 0.50),
      mapPreflightP95Ms: percentile(mapTimings.map((item) => item.preflightMs), 0.95),
      mapBarrierP50Ms: percentile(mapTimings.map((item) => item.barrierWaitMs), 0.50),
      mapBarrierP95Ms: percentile(mapTimings.map((item) => item.barrierWaitMs), 0.95),
      mapEvalP50Ms: percentile(mapTimings.map((item) => item.candidateEvalMs), 0.50),
      mapEvalP95Ms: percentile(mapTimings.map((item) => item.candidateEvalMs), 0.95),
      mapCommitP50Ms: percentile(mapTimings.map((item) => item.commitMs), 0.50),
      mapCommitP95Ms: percentile(mapTimings.map((item) => item.commitMs), 0.95),
      mapTotalP50Ms: percentile(mapTimings.map((item) => item.reloadTotalMs), 0.50),
      mapTotalP95Ms: percentile(mapTimings.map((item) => item.reloadTotalMs), 0.95),
    },
  };
}

function renderMarkdown(report) {
  const b = report.baseline.median;
  const r = report.reload.median;
  const d = report.comparison;
  const h = report.hotfix;
  return [
    `# ${args.players} 人在线 Hotfix A/B 性能报告`,
    "",
    `- 时间：${report.generatedAt}`,
    `- 拓扑：1 MapHost / ${args.gates} Gate / 1 Login / 1 LoginMgr`,
    `- 负载：${args.players} 玩家，Move ${args.moveRate}Hz，Probe ${args.probeRate}Hz`,
    `- 正式窗口：${args.duration}s x ${args.rounds} 轮；Reload 周期 ${args.hotfixIntervalMs}ms`,
    "",
    "| 指标 | 不 Reload | 每秒 Reload | 变化 |",
    "|---|---:|---:|---:|",
    row("Move/s", b.movesPerSecond, r.movesPerSecond, d.movesPerSecondPercent),
    row("Probe p50 ms", b.probeP50Ms, r.probeP50Ms, d.probeP50Percent),
    row("Probe p95 ms", b.probeP95Ms, r.probeP95Ms, d.probeP95Percent),
    row("Probe p99 ms", b.probeP99Ms, r.probeP99Ms, d.probeP99Percent),
    row("Map CPU %", b.mapCpuAverage, r.mapCpuAverage, d.mapCpuPercent),
    row("最忙 Gate CPU %", b.gateMaxCpuAverage, r.gateMaxCpuAverage, d.gateCpuPercent),
    row("服务端 RSS MB", b.serverRssBytes / 1024 / 1024, r.serverRssBytes / 1024 / 1024, d.serverRssPercent),
    "",
    "## Reload 结果",
    "",
    `- 正式窗口请求/完成/未在周期内完成：${h.formalWindowAttempts}/${h.formalWindowCompleted}/${h.formalWindowMissed}`,
    `- Map preflight p50/p95：${fixed(h.mapPreflightP50Ms)}/${fixed(h.mapPreflightP95Ms)} ms`,
    `- Map barrier p50/p95：${fixed(h.mapBarrierP50Ms)}/${fixed(h.mapBarrierP95Ms)} ms`,
    `- Map eval p50/p95：${fixed(h.mapEvalP50Ms)}/${fixed(h.mapEvalP95Ms)} ms`,
    `- Map commit p50/p95：${fixed(h.mapCommitP50Ms)}/${fixed(h.mapCommitP95Ms)} ms`,
    `- Map total p50/p95：${fixed(h.mapTotalP50Ms)}/${fixed(h.mapTotalP95Ms)} ms`,
    "",
    "## 硬性正确性",
    "",
    `- 基线 Move/Probe 错误：${b.moveErrors}/${b.probeErrors}`,
    `- Reload Move/Probe 错误：${r.moveErrors}/${r.probeErrors}`,
    `- Reload 内部 overload/timeout/slow disconnect：${r.innerOverloads}/${r.innerTimeouts}/${r.slowDisconnects}`,
    "",
  ].join("\n");
}

function parseArgs(values) {
  const map = new Map();
  const flags = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item.startsWith("--")) continue;
    if (index + 1 >= values.length || values[index + 1].startsWith("--")) flags.add(item);
    else map.set(item, values[++index]);
  }
  return {
    players: positive(map.get("--players") ?? 3000),
    gates: positive(map.get("--gates") ?? 16),
    moveRate: positive(map.get("--move-rate") ?? 2),
    movementHoldMessages: positive(map.get("--movement-hold-messages") ?? 2),
    probeRate: positive(map.get("--probe-rate") ?? 0.2),
    setupConcurrency: positive(map.get("--setup-concurrency") ?? 4),
    warmup: nonNegative(map.get("--warmup") ?? 10),
    duration: positive(map.get("--duration") ?? 30),
    rounds: positive(map.get("--rounds") ?? 3),
    targetMapCpu: positive(map.get("--target-map-cpu") ?? 80),
    hotfixIntervalMs: positive(map.get("--hotfix-interval-ms") ?? 1000),
    skipBuild: flags.has("--skip-build"),
    reloadOnly: flags.has("--reload-only"),
    reloadSourceIpBase: positive(map.get("--reload-source-ip-base") ?? 20),
  };
}

function run(command, values) {
  return new Promise((resolve, reject) => {
    console.log(`[hotfix-perf] ${command} ${values.join(" ")}`);
    const child = spawn(command, values, { cwd: root, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolve()
      : reject(new Error(`${command} failed with code=${code} signal=${signal}`)));
  });
}

function row(name, baseline, reload, change) {
  return `| ${name} | ${fixed(baseline)} | ${fixed(reload)} | ${signed(change)}% |`;
}
function percentChange(baseline, value) { return baseline === 0 ? 0 : (value - baseline) / baseline * 100; }
function percentile(values, ratio) { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]; }
function sum(values) { return values.reduce((total, value) => total + value, 0); }
function positive(value) { const number = Number(value); if (!(number > 0)) throw new Error(`expected positive number, got ${value}`); return number; }
function nonNegative(value) { const number = Number(value); if (!(number >= 0)) throw new Error(`expected non-negative number, got ${value}`); return number; }
function fixed(value) { return Number(value ?? 0).toFixed(2); }
function signed(value) { return `${value >= 0 ? "+" : ""}${fixed(value)}`; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function timestamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_"); }
function writeJson(file, value) {
  const portable = SanitizePerformanceReport(value, root);
  writeFileSync(file, `${JSON.stringify(portable, null, 2)}\n`, "utf8");
}
