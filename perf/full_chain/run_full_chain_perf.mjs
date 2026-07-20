import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const options = parseOptions(process.argv.slice(2));
const runId = timestamp();
const resultDir = path.join(root, "perf", "results");
const logDir = path.join(resultDir, "logs", runId);
mkdirSync(logDir, { recursive: true });

const executable = path.join(
  root,
  "target",
  options.debugRuntime ? "debug" : "release",
  process.platform === "win32" ? "TiangZ.exe" : "TiangZ",
);
const gameClient = path.join(root, "dist", "full_chain_load_test.cjs");
const rawResults = [];

await main();

async function main() {
  const deployments = options.remote
    ? [options.label ?? "remote"]
    : options.mode === "both"
      ? ["all", "split"]
      : [options.mode];

  for (const deployment of deployments) {
    for (const players of options.players) {
      for (const moveRate of options.moveRates) {
        for (let round = 1; round <= options.rounds; round += 1) {
          const result = await runCase(deployment, players, moveRate, round);
          rawResults.push(result);
          writeJson(path.join(resultDir, `full_chain_${runId}_raw.json`), rawResults);
        }
      }
    }
  }

  const cases = aggregateCases(rawResults);
  const report = {
    generatedAt: new Date().toISOString(),
    runId,
    parameters: options,
    loadGeneratorMachine: machineInfo(),
    server: {
      host: options.host,
      independentlyDeployed: options.remote,
      note: options.remote
        ? "服务端进程指标需由服务端日志中的 [process-metrics] 另行汇入"
        : "服务端与压测端在同一台机器，资源竞争会影响结果",
    },
    cases,
    rounds: rawResults,
  };
  const jsonPath = path.join(resultDir, `full_chain_${runId}.json`);
  const markdownPath = path.join(resultDir, `full_chain_${runId}.md`);
  writeJson(jsonPath, report);
  writeJson(path.join(resultDir, "full_chain_latest.json"), report);
  const markdown = renderMarkdown(report);
  writeFileSync(markdownPath, markdown, "utf8");
  writeFileSync(path.join(resultDir, "full_chain_latest.md"), markdown, "utf8");
  console.log(`[full-chain] report: ${markdownPath}`);
  console.log(markdown);
}

async function runCase(deployment, players, moveRate, round) {
  const workload = moveRate > 0 ? `${moveRate}hz` : "saturation";
  const caseName = `${deployment}_${players}_${workload}_r${round}`;
  console.log(`[full-chain] ${caseName}`);
  const runtimes = [];
  let clientResult;
  try {
    if (!options.remote) {
      const configs = deployment === "all"
        ? ["all"]
        : ["log", "mgr", "login1", "login2", "gate1", "map1"];
      for (const config of configs) {
        runtimes.push(startRuntime(config, `${caseName}_${config}`));
      }
      for (const port of [7000, 7001, 7002, 7100, 7201, 7301]) {
        await waitPort("127.0.0.1", port, 20_000);
      }
    } else {
      await waitPort(options.host, options.managerPort, 20_000);
    }

    const output = await runCommand(process.execPath, [
      gameClient,
      "--host", options.host,
      "--manager-port", String(options.managerPort),
      "--players", String(players),
      "--setup-concurrency", String(options.setupConcurrency),
      "--duration", String(options.duration),
      "--warmup", String(options.warmup),
      "--move-rate", String(moveRate),
      "--label", deployment,
    ]);
    process.stdout.write(output);
    const line = output.split(/\r?\n/).findLast((item) => item.startsWith("RESULT_JSON "));
    if (!line) throw new Error("gameplay client did not return RESULT_JSON");
    clientResult = JSON.parse(line.slice("RESULT_JSON ".length));
  } finally {
    await stopRuntimes(runtimes);
  }
  return {
    ...clientResult,
    round,
    serverResources: options.remote ? undefined : collectRuntimeResources(runtimes),
    logDirectory: logDir,
  };
}

function startRuntime(configName, logName) {
  const stdoutPath = path.join(logDir, `${logName}_stdout.log`);
  const stderrPath = path.join(logDir, `${logName}_stderr.log`);
  const child = spawn(executable, [`configs/local/${configName}.json`], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.pipe(createWriteStream(stdoutPath));
  child.stderr.pipe(createWriteStream(stderrPath));
  return { child, name: configName, stdoutPath, stderrPath };
}

async function stopRuntimes(runtimes) {
  for (const runtime of runtimes) {
    if (runtime.child.exitCode !== null) continue;
    runtime.child.kill("SIGTERM");
  }
  await Promise.all(runtimes.map(async (runtime) => {
    if (runtime.child.exitCode !== null) return;
    await Promise.race([onceExit(runtime.child), sleep(2_000)]);
    if (runtime.child.exitCode === null) runtime.child.kill("SIGKILL");
  }));
}

function collectRuntimeResources(runtimes) {
  const processes = runtimes.map((runtime) => {
    let text = "";
    try { text = readFileSync(runtime.stdoutPath, "utf8"); } catch {}
    const samples = [...text.matchAll(
      /\[process-metrics\] process=(\S+) cpu_percent=([0-9.]+) cpu_time_ms=(\d+) rss_bytes=(\d+) v8_heap_used_bytes=(\d+) v8_heap_total_bytes=(\d+) v8_gc_count=(\d+) v8_gc_ms=([0-9.]+)/g,
    )].map((match) => ({
      process: match[1],
      cpuPercent: Number(match[2]),
      cpuTimeMs: Number(match[3]),
      rssBytes: Number(match[4]),
      v8HeapUsedBytes: Number(match[5]),
      v8HeapTotalBytes: Number(match[6]),
      v8GcCount: Number(match[7]),
      v8GcMs: Number(match[8]),
    }));
    const last = samples.at(-1);
    return {
      process: last?.process ?? runtime.name,
      samples: samples.length,
      peakCpuPercent: max(samples.map((item) => item.cpuPercent)),
      peakRssBytes: max(samples.map((item) => item.rssBytes)),
      peakV8HeapUsedBytes: max(samples.map((item) => item.v8HeapUsedBytes)),
      cpuTimeMs: last?.cpuTimeMs ?? 0,
      v8GcCount: last?.v8GcCount ?? 0,
      v8GcMs: last?.v8GcMs ?? 0,
    };
  });
  return {
    processes,
    peakCpuPercentSum: sum(processes.map((item) => item.peakCpuPercent)),
    peakRssBytesSum: sum(processes.map((item) => item.peakRssBytes)),
    peakV8HeapUsedBytesSum: sum(processes.map((item) => item.peakV8HeapUsedBytes)),
    cpuTimeMsSum: sum(processes.map((item) => item.cpuTimeMs)),
    v8GcCountSum: sum(processes.map((item) => item.v8GcCount)),
    v8GcMsSum: sum(processes.map((item) => item.v8GcMs)),
  };
}

function aggregateCases(rounds) {
  const groups = new Map();
  for (const round of rounds) {
    const key = `${round.label}:${round.players}:${round.workload}`;
    const group = groups.get(key) ?? [];
    group.push(round);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    label: group[0].label,
    players: group[0].players,
    workload: group[0].workload,
    roundCount: group.length,
    median: {
      setupPerSecond: median(group.map((item) => item.setup.perSecond)),
      setupP95Ms: median(group.map((item) => item.setup.p95Ms)),
      movesPerSecond: median(group.map((item) => item.movement.perSecond)),
      pushesPerSecond: median(group.map((item) => item.movement.pushesPerSecond)),
      moveP50Ms: median(group.map((item) => item.movement.p50Ms)),
      moveP95Ms: median(group.map((item) => item.movement.p95Ms)),
      moveP99Ms: median(group.map((item) => item.movement.p99Ms)),
      stalled: median(group.map((item) => item.movement.errors)),
      serverPeakCpuPercentSum: median(group.map((item) => item.serverResources?.peakCpuPercentSum ?? 0)),
      serverPeakRssBytesSum: median(group.map((item) => item.serverResources?.peakRssBytesSum ?? 0)),
      serverGcCount: median(group.map((item) => item.serverResources?.v8GcCountSum ?? 0)),
      serverGcMs: median(group.map((item) => item.serverResources?.v8GcMsSum ?? 0)),
      loadCpuMs: median(group.map((item) => item.loadGenerator.cpuUserMs + item.loadGenerator.cpuSystemMs)),
      loadPeakRssBytes: median(group.map((item) => item.loadGenerator.maxRssBytes)),
      loadGcCount: median(group.map((item) => item.loadGenerator.gcCount)),
      loadGcMs: median(group.map((item) => item.loadGenerator.gcDurationMs)),
    },
  }));
}

function renderMarkdown(report) {
  const lines = [
    "# 全链路性能测试报告",
    "",
    `- 时间：${report.generatedAt}`,
    `- 正式测试：${options.duration}s；预热：${options.warmup}s；轮数：${options.rounds}`,
    `- 服务端：${options.host}；独立部署：${options.remote ? "是" : "否"}`,
    `- 压测机：${report.loadGeneratorMachine.cpu} / ${report.loadGeneratorMachine.logicalCpus} 逻辑核 / ${formatBytes(report.loadGeneratorMachine.memoryBytes)}`,
    "",
    `## ${options.rounds} 轮中位数`,
    "",
    "| 部署 | 负载 | 玩家 | move/s | push/s | p50 ms | p95 ms | p99 ms | stalled | Server CPU% | Server RSS | Server GC ms | Load CPU ms | Load RSS |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const item of report.cases) {
    const value = item.median;
    lines.push(`| ${item.label} | ${item.workload} | ${item.players} | ${round(value.movesPerSecond)} | ${round(value.pushesPerSecond)} | ${round(value.moveP50Ms, 2)} | ${round(value.moveP95Ms, 2)} | ${round(value.moveP99Ms, 2)} | ${value.stalled} | ${options.remote ? "N/A" : round(value.serverPeakCpuPercentSum, 1)} | ${options.remote ? "N/A" : formatBytes(value.serverPeakRssBytesSum)} | ${options.remote ? "N/A" : round(value.serverGcMs, 2)} | ${round(value.loadCpuMs)} | ${formatBytes(value.loadPeakRssBytes)} |`);
  }
  lines.push(
    "",
    "## 指标口径",
    "",
    "- `move/s` 是客户端发送移动到收到自身权威位置 Push 的闭环吞吐。",
    "- `push/s` 是所有客户端实际收到的 EntityMove 数；当前仍为同地图全量可见，尚未启用 AOI。",
    "- Server CPU/RSS/GC 来自各 Runtime 的 `[process-metrics]`；split 模式按进程汇总。",
    "- Load CPU/RSS/GC 只代表压测客户端，独立压测机模式用于排除它与服务端争抢资源。",
    "- MapHost 按 Gate 聚合移动广播；一次跨进程 `M2G_EntityMove` 可携带多个目标 Unit。",
    "",
  );
  return lines.join("\n");
}

function parseOptions(args) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item.startsWith("--")) continue;
    if (index + 1 >= args.length || args[index + 1].startsWith("--")) flags.add(item);
    else values.set(item, args[++index]);
  }
  const mode = values.get("--mode") ?? "both";
  if (!["all", "split", "both"].includes(mode)) throw new Error(`invalid --mode: ${mode}`);
  return {
    mode,
    players: csvNumbers(values.get("--players") ?? "10,50,100"),
    moveRates: csvNumbers(values.get("--move-rates") ?? "10,0"),
    duration: positive(values.get("--duration") ?? "60", "--duration"),
    warmup: nonNegative(values.get("--warmup") ?? "10", "--warmup"),
    rounds: positive(values.get("--rounds") ?? "3", "--rounds"),
    setupConcurrency: positive(values.get("--setup-concurrency") ?? "16", "--setup-concurrency"),
    host: values.get("--host") ?? "127.0.0.1",
    managerPort: positive(values.get("--manager-port") ?? "7000", "--manager-port"),
    remote: flags.has("--remote"),
    label: values.get("--label"),
    debugRuntime: flags.has("--debug-runtime"),
  };
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} failed with code=${code} signal=${signal}\n${output}`));
    });
  });
}

async function waitPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(host, port)) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${host}:${port}`);
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(250);
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function onceExit(child) { return new Promise((resolve) => child.once("exit", resolve)); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function sum(values) { return values.reduce((total, value) => total + value, 0); }
function max(values) { return values.length === 0 ? 0 : Math.max(...values); }
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
function csvNumbers(value) { return value.split(",").map((item) => Number(item.trim())); }
function positive(value, name) { const number = Number(value); if (!(number > 0)) throw new Error(`${name} must be > 0`); return number; }
function nonNegative(value, name) { const number = Number(value); if (!(number >= 0)) throw new Error(`${name} must be >= 0`); return number; }
function round(value, digits = 0) { const scale = 10 ** digits; return Math.round(value * scale) / scale; }
function formatBytes(value) { return `${(value / 1024 / 1024).toFixed(1)}MB`; }
function timestamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_"); }
function machineInfo() {
  return { cpu: os.cpus()[0]?.model ?? "unknown", logicalCpus: os.cpus().length, memoryBytes: os.totalmem(), os: `${os.platform()} ${os.release()}` };
}
function writeJson(file, value) { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
