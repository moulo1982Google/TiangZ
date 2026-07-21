import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const options = parseOptions(process.argv.slice(2));
if (options.client === "rust" && !options.probeOnly) {
  throw new Error("--client rust currently supports --probe-only workloads only");
}
const runId = timestamp();
const resultDir = path.join(root, "perf", "results");
const logDir = path.join(resultDir, "logs", `map_capacity_${runId}`);
const configDir = path.join(resultDir, "runtime_configs", `map_capacity_${runId}`);
mkdirSync(logDir, { recursive: true });
mkdirSync(configDir, { recursive: true });

const executable = path.join(
  root,
  "target",
  options.debugRuntime ? "debug" : "release",
  process.platform === "win32" ? "TiangZ.exe" : "TiangZ",
);
const loadClient = path.join(root, "dist", "full_chain_load_test.cjs");
const rustLoadClient = path.join(
  root,
  "target",
  "release",
  process.platform === "win32" ? "map_probe_load.exe" : "map_probe_load",
);
const rawResults = [];

await main();

async function main() {
  for (const players of options.players) {
    for (let round = 1; round <= options.rounds; round += 1) {
      const result = await runCase(players, round);
      rawResults.push(result);
      writeJson(path.join(resultDir, `map_capacity_${runId}_raw.json`), rawResults);
    }
  }

  const cases = aggregateCases(rawResults);
  const capacityCandidate = [...cases]
    .filter((item) =>
      item.median.mapCpuAverage <= options.targetMapCpu &&
      item.median.moveTargetPercent >= 95 &&
      item.median.moveErrors === 0 &&
      item.median.probeErrors === 0 &&
      item.median.innerOverloads === 0
    )
    .sort((left, right) => right.players - left.players)[0];
  const nearestTarget = [...cases].sort(
    (left, right) =>
      Math.abs(left.median.mapCpuAverage - options.targetMapCpu) -
      Math.abs(right.median.mapCpuAverage - options.targetMapCpu),
  )[0];
  const report = {
    generatedAt: new Date().toISOString(),
    runId,
    parameters: options,
    machine: machineInfo(),
    capacityCandidate,
    nearestTarget,
    cases,
    rounds: rawResults,
  };
  const jsonPath = path.join(resultDir, `map_capacity_${runId}.json`);
  const markdownPath = path.join(resultDir, `map_capacity_${runId}.md`);
  writeJson(jsonPath, report);
  writeJson(path.join(resultDir, "map_capacity_latest.json"), report);
  const markdown = renderMarkdown(report);
  writeFileSync(markdownPath, markdown, "utf8");
  writeFileSync(path.join(resultDir, "map_capacity_latest.md"), markdown, "utf8");
  console.log(`[map-capacity] report: ${markdownPath}`);
  console.log(markdown);
}

async function runCase(players, round) {
  const caseName = `${players}p_${options.gates}g_r${round}`;
  console.log(`[map-capacity] ${caseName}`);
  const topology = writeTopologyConfigs(caseName);
  const runtimes = [];
  let clientResult;
  try {
    for (const runtime of topology.runtimes) {
      runtimes.push(startRuntime(runtime));
    }
    for (const port of topology.ports) {
      await waitPort("127.0.0.1", port, 30_000);
    }

    const useRustClient = options.client === "rust";
    const output = await runCommand(useRustClient ? rustLoadClient : process.execPath, [
      ...(useRustClient ? [] : [loadClient]),
      "--host", "127.0.0.1",
      "--manager-port", String(options.managerPort),
      "--players", String(players),
      "--setup-concurrency", String(options.setupConcurrency),
      "--duration", String(options.duration),
      "--warmup", String(options.warmup),
      "--move-rate", String(options.moveRate),
      "--probe-rate", String(options.probeRate),
      "--probe-concurrency", String(options.probeConcurrency),
      "--timeout", String(options.timeoutMs),
      "--movement-timeout", String(options.movementTimeoutMs),
      "--label", `${options.gates}g`,
      ...(!useRustClient && options.probeOnly ? ["--disable-move"] : []),
    ]);
    process.stdout.write(output);
    const line = output.split(/\r?\n/).findLast((item) => item.startsWith("RESULT_JSON "));
    if (!line) throw new Error("load client did not return RESULT_JSON");
    clientResult = JSON.parse(line.slice("RESULT_JSON ".length));
  } finally {
    await stopRuntimes(runtimes);
  }

  const resources = collectRuntimeResources(
    runtimes,
    clientResult?.measurementStartedAtUnixMs,
    clientResult?.measurementEndedAtUnixMs,
  );
  return {
    ...clientResult,
    gates: options.gates,
    round,
    serverResources: resources,
    transport: collectTransportMetrics(runtimes),
    logDirectory: logDir,
    configDirectory: configDir,
  };
}

function writeTopologyConfigs(caseName) {
  const caseDir = path.join(configDir, caseName);
  mkdirSync(caseDir, { recursive: true });
  const scene = (name, sceneType, port) => ({ name, sceneType, ip: "127.0.0.1", port });
  const logScene = scene("log", "Log", options.logPort);
  const managerScene = scene("login_mgr", "LoginMgr", options.managerPort);
  const loginScene = scene("login_1", "Login", options.loginPort);
  const mapScene = scene("map_1", "MapHost", options.mapPort);
  const gateScenes = Array.from(
    { length: options.gates },
    (_, index) => scene(`gate_${index + 1}`, "Gate", options.gateBasePort + index),
  );
  const configs = [
    runtimeConfig("log", [logScene], [logScene]),
    runtimeConfig("map1", [mapScene], [...gateScenes, logScene]),
    ...gateScenes.map((gate, index) =>
      runtimeConfig(`gate${index + 1}`, [gate], [mapScene, logScene])
    ),
    runtimeConfig("login1", [loginScene], [logScene, ...gateScenes]),
    runtimeConfig("mgr", [managerScene], [loginScene]),
  ];
  const runtimes = configs.map((config) => {
    const configPath = path.join(caseDir, `${config.process.name}.json`);
    writeJson(configPath, config);
    return { name: config.process.name, configPath, logName: `${caseName}_${config.process.name}` };
  });
  return {
    runtimes,
    ports: [
      options.managerPort,
      options.loginPort,
      options.logPort,
      options.mapPort,
      ...gateScenes.map((item) => item.port),
    ],
  };
}

function runtimeConfig(name, scenes, knownScenes) {
  return { process: { name }, scenes, knownScenes };
}

function startRuntime(runtime) {
  const stdoutPath = path.join(logDir, `${runtime.logName}_stdout.log`);
  const stderrPath = path.join(logDir, `${runtime.logName}_stderr.log`);
  const child = spawn(executable, [runtime.configPath], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.pipe(createWriteStream(stdoutPath));
  child.stderr.pipe(createWriteStream(stderrPath));
  return { child, name: runtime.name, stdoutPath, stderrPath };
}

async function stopRuntimes(runtimes) {
  for (const runtime of runtimes) {
    if (runtime.child.exitCode === null) runtime.child.kill("SIGTERM");
  }
  await Promise.all(runtimes.map(async (runtime) => {
    if (runtime.child.exitCode !== null) return;
    await Promise.race([onceExit(runtime.child), sleep(2_000)]);
    if (runtime.child.exitCode === null) runtime.child.kill("SIGKILL");
  }));
}

function collectRuntimeResources(runtimes, startedAt, endedAt) {
  const processes = runtimes.map((runtime) => {
    const text = readText(runtime.stdoutPath);
    const samples = text.split(/\r?\n/)
      .filter((line) => line.startsWith("[process-metrics] "))
      .map(parseMetricLine)
      .map((values) => ({
        process: values.process ?? runtime.name,
        cpuPercent: Number(values.cpu_percent ?? 0),
        cpuTimeMs: Number(values.cpu_time_ms ?? 0),
        rssBytes: Number(values.rss_bytes ?? 0),
        v8HeapUsedBytes: Number(values.v8_heap_used_bytes ?? 0),
        v8HeapTotalBytes: Number(values.v8_heap_total_bytes ?? 0),
        v8GcCount: Number(values.v8_gc_count ?? 0),
        v8GcMs: Number(values.v8_gc_ms ?? 0),
        timestampMs: Number(values.timestamp_ms ?? 0),
        outboundBatches: Number(values.outbound_batches ?? 0),
        outboundRecipients: Number(values.outbound_recipients ?? 0),
        outboundBridgeBytes: Number(values.outbound_bridge_bytes ?? 0),
        outboundLogicalBytes: Number(values.outbound_logical_bytes ?? 0),
      }));
    const completeWindowSamples = samples.filter((sample) =>
      startedAt && endedAt &&
      sample.timestampMs >= startedAt + 4_000 &&
      sample.timestampMs <= endedAt + 1_000
    );
    const selected = completeWindowSamples.length > 0
      ? completeWindowSamples
      : samples.slice(-Math.max(1, Math.floor(options.duration / 5)));
    return summarizeProcess(runtime.name, selected, samples.at(-1));
  });
  const map = processes.find((item) => item.process === "map1");
  const gates = processes.filter((item) => item.process.startsWith("gate"));
  return {
    processes,
    map,
    gates,
    gateMaxAverageCpuPercent: max(gates.map((item) => item.averageCpuPercent)),
    gateMaxPeakCpuPercent: max(gates.map((item) => item.peakCpuPercent)),
    gateOutboundBatchesPerSecond: sum(gates.map((item) => item.outboundBatchesPerSecond)),
    gateOutboundRecipientsPerSecond: sum(gates.map((item) => item.outboundRecipientsPerSecond)),
    gateOutboundBridgeBytesPerSecond: sum(gates.map((item) => item.outboundBridgeBytesPerSecond)),
    gateOutboundLogicalBytesPerSecond: sum(gates.map((item) => item.outboundLogicalBytesPerSecond)),
    totalPeakRssBytes: sum(processes.map((item) => item.peakRssBytes)),
  };
}

function parseMetricLine(line) {
  return Object.fromEntries(
    [...line.matchAll(/([a-zA-Z_]+)=([^\s]+)/g)].map((match) => [match[1], match[2]]),
  );
}

function summarizeProcess(fallbackName, samples, last) {
  const cpu = samples.map((item) => item.cpuPercent).sort(numberOrder);
  return {
    process: last?.process ?? fallbackName,
    samples: samples.length,
    averageCpuPercent: average(cpu),
    p90CpuPercent: percentile(cpu, 0.90),
    peakCpuPercent: max(cpu),
    peakRssBytes: max(samples.map((item) => item.rssBytes)),
    v8GcCount: last?.v8GcCount ?? 0,
    v8GcMs: last?.v8GcMs ?? 0,
    outboundBatchesPerSecond: counterRate(samples, "outboundBatches"),
    outboundRecipientsPerSecond: counterRate(samples, "outboundRecipients"),
    outboundBridgeBytesPerSecond: counterRate(samples, "outboundBridgeBytes"),
    outboundLogicalBytesPerSecond: counterRate(samples, "outboundLogicalBytes"),
  };
}

function collectTransportMetrics(runtimes) {
  const text = runtimes.map((runtime) => readText(runtime.stdoutPath)).join("\n");
  return {
    innerOverloads: maxMatches(text, /overloads=(\d+)/g),
    innerTimeouts: maxMatches(text, /timeouts=(\d+)/g),
    backpressure: maxMatches(text, /backpressure=(\d+)/g),
    slowDisconnects: maxMatches(text, /slow_disconnects=(\d+)/g),
  };
}

function aggregateCases(rounds) {
  const groups = new Map();
  for (const round of rounds) {
    const group = groups.get(round.players) ?? [];
    group.push(round);
    groups.set(round.players, group);
  }
  return [...groups.entries()].map(([players, group]) => ({
    players,
    roundCount: group.length,
    median: {
      mapCpuAverage: median(group.map((item) => item.serverResources.map?.averageCpuPercent ?? 0)),
      mapCpuP90: median(group.map((item) => item.serverResources.map?.p90CpuPercent ?? 0)),
      mapCpuPeak: median(group.map((item) => item.serverResources.map?.peakCpuPercent ?? 0)),
      gateMaxCpuAverage: median(group.map((item) => item.serverResources.gateMaxAverageCpuPercent)),
      gateMaxCpuPeak: median(group.map((item) => item.serverResources.gateMaxPeakCpuPercent)),
      gateOutboundBatchesPerSecond: median(group.map(
        (item) => item.serverResources.gateOutboundBatchesPerSecond,
      )),
      gateOutboundRecipientsPerSecond: median(group.map(
        (item) => item.serverResources.gateOutboundRecipientsPerSecond,
      )),
      gateOutboundBridgeBytesPerSecond: median(group.map(
        (item) => item.serverResources.gateOutboundBridgeBytesPerSecond,
      )),
      gateOutboundLogicalBytesPerSecond: median(group.map(
        (item) => item.serverResources.gateOutboundLogicalBytesPerSecond,
      )),
      movesPerSecond: median(group.map((item) => item.movement.perSecond)),
      moveTargetPercent: options.probeOnly || options.moveRate === 0
        ? 100
        : median(group.map(
          (item) => item.movement.perSecond / (item.players * options.moveRate) * 100,
        )),
      pushesPerSecond: median(group.map((item) => item.movement.pushesPerSecond)),
      moveErrors: median(group.map((item) => item.movement.errors)),
      probePerSecond: median(group.map((item) => item.probe.perSecond)),
      probeP50Ms: median(group.map((item) => item.probe.p50Ms)),
      probeP90Ms: median(group.map((item) => item.probe.p90Ms)),
      probeP95Ms: median(group.map((item) => item.probe.p95Ms)),
      probeP99Ms: median(group.map((item) => item.probe.p99Ms)),
      probeMaxMs: median(group.map((item) => item.probe.maxMs)),
      probeErrors: median(group.map((item) => item.probe.errors)),
      innerOverloads: median(group.map((item) => item.transport.innerOverloads)),
      backpressure: median(group.map((item) => item.transport.backpressure)),
      serverRssBytes: median(group.map((item) => item.serverResources.totalPeakRssBytes)),
    },
  }));
}

function renderMarkdown(report) {
  const lines = [
    "# 单 MapHost 同屏容量测试报告",
    "",
    `- 时间：${report.generatedAt}`,
    `- 拓扑：1 MapHost / ${options.gates} Gate / 1 Login / 1 LoginMgr`,
    `- 负载：${options.probeOnly ? "Probe Only，" : `每玩家 ${options.moveRate}Hz Move + `}每玩家 ${options.probeRate}Hz MapProbe`,
    `- Probe in-flight：每连接 ${options.probeConcurrency}`,
    `- 压测客户端：${options.client === "rust" ? "Rust" : "Node.js"}`,
    `- 正式测试：${options.duration}s；预热：${options.warmup}s；轮数：${options.rounds}`,
    `- Map CPU 目标：${options.targetMapCpu}%（100% 表示一个逻辑核）`,
    `- 机器：${report.machine.cpu} / ${report.machine.logicalCpus} 逻辑核 / ${formatBytes(report.machine.memoryBytes)}`,
    "",
    `## ${options.rounds} 轮中位数`,
    "",
    "| 玩家 | Map CPU avg/p90/peak | Gate max avg/peak | move/s | Move 达标率 | push/s | Probe/s | Probe p50 | p90 | p95 | p99 | max | move/probe errors | overload/backpressure | RSS |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const item of report.cases) {
    const value = item.median;
    lines.push(
      `| ${item.players} | ${round(value.mapCpuAverage, 1)}/${round(value.mapCpuP90, 1)}/${round(value.mapCpuPeak, 1)}% | ` +
      `${round(value.gateMaxCpuAverage, 1)}/${round(value.gateMaxCpuPeak, 1)}% | ${round(value.movesPerSecond)} | ` +
      `${round(value.moveTargetPercent, 1)}% | ${round(value.pushesPerSecond)} | ${round(value.probePerSecond)} | ${round(value.probeP50Ms, 2)}ms | ` +
      `${round(value.probeP90Ms, 2)}ms | ${round(value.probeP95Ms, 2)}ms | ${round(value.probeP99Ms, 2)}ms | ` +
      `${round(value.probeMaxMs, 2)}ms | ${value.moveErrors}/${value.probeErrors} | ` +
      `${value.innerOverloads}/${value.backpressure} | ${formatBytes(value.serverRssBytes)} |`,
    );
  }
  lines.push(
    "",
    "## 批量下行 Bridge",
    "",
    "| 玩家 | Gate batch/s | recipients/s | recipients/batch | Bridge copy | logical outbound |",
    "|---:|---:|---:|---:|---:|---:|",
  );
  for (const item of report.cases) {
    const value = item.median;
    const recipientsPerBatch = value.gateOutboundBatchesPerSecond > 0
      ? value.gateOutboundRecipientsPerSecond / value.gateOutboundBatchesPerSecond
      : 0;
    lines.push(
      `| ${item.players} | ${round(value.gateOutboundBatchesPerSecond)} | ` +
      `${round(value.gateOutboundRecipientsPerSecond)} | ${round(recipientsPerBatch, 2)} | ` +
      `${formatRate(value.gateOutboundBridgeBytesPerSecond)} | ` +
      `${formatRate(value.gateOutboundLogicalBytesPerSecond)} |`,
    );
  }
  const candidate = report.capacityCandidate;
  const nearest = report.nearestTarget;
  lines.push("", "## 容量判断", "");
  lines.push(candidate
    ? `- 保守容量点：${candidate.players} 玩家，Map CPU 平均 ${round(candidate.median.mapCpuAverage, 1)}%，Probe p95/p99 ${round(candidate.median.probeP95Ms, 2)}/${round(candidate.median.probeP99Ms, 2)}ms。`
    : "- 本轮没有同时满足 CPU 目标、零超时、零内部过载的容量点。");
  if (nearest) {
    lines.push(`- 最接近 ${options.targetMapCpu}% 的测试点：${nearest.players} 玩家，Map CPU 平均 ${round(nearest.median.mapCpuAverage, 1)}%。`);
  }
  lines.push(
    "",
    "## 指标口径",
    "",
    "- `MapProbe` 是 ActorLocation RPC，链路为客户端 -> Gate -> MapHost -> Gate -> 客户端，不产生 AOI 广播。",
    "- Map/Gate CPU 使用正式测试窗口内的 5 秒进程 CPU 样本；平均值用于容量判断。",
    options.probeOnly
      ? "- Probe Only 模式关闭 Move 和 AOI 广播，用于测 MapHost pingpong RPC 基线吞吐。"
      : "- 容量点要求实际 Move 吞吐至少达到设定频率的 95%，避免闭环变慢后 CPU 被动下降造成误判。",
    "- `push/s` 仍是全地图全量可见广播，代表最坏同屏 O(N^2) 场景。",
    "- Gate 数量用于分摊连接、编码和下行发送；MapHost 始终只有一个。",
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
  return {
    players: csvNumbers(values.get("--players") ?? "100,125,150,175,200"),
    gates: positive(values.get("--gates") ?? "4", "--gates"),
    // Demo 默认客户端输入上报频率是 5Hz；服务端 Game.Update 默认保持 20Hz。
    moveRate: nonNegative(values.get("--move-rate") ?? "5", "--move-rate"),
    probeRate: positive(values.get("--probe-rate") ?? "1", "--probe-rate"),
    probeConcurrency: positive(values.get("--probe-concurrency") ?? "1", "--probe-concurrency"),
    duration: positive(values.get("--duration") ?? "30", "--duration"),
    warmup: nonNegative(values.get("--warmup") ?? "10", "--warmup"),
    rounds: positive(values.get("--rounds") ?? "1", "--rounds"),
    setupConcurrency: positive(values.get("--setup-concurrency") ?? "16", "--setup-concurrency"),
    timeoutMs: positive(values.get("--timeout") ?? "60000", "--timeout"),
    movementTimeoutMs: positive(values.get("--movement-timeout") ?? "10000", "--movement-timeout"),
    targetMapCpu: positive(values.get("--target-map-cpu") ?? "85", "--target-map-cpu"),
    managerPort: positive(values.get("--manager-port") ?? "7000", "--manager-port"),
    loginPort: positive(values.get("--login-port") ?? "7001", "--login-port"),
    logPort: positive(values.get("--log-port") ?? "7100", "--log-port"),
    gateBasePort: positive(values.get("--gate-base-port") ?? "7201", "--gate-base-port"),
    mapPort: positive(values.get("--map-port") ?? "7301", "--map-port"),
    debugRuntime: flags.has("--debug-runtime"),
    probeOnly: flags.has("--probe-only"),
    client: enumValue(values.get("--client") ?? "node", ["node", "rust"], "--client"),
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

function readText(file) { try { return readFileSync(file, "utf8"); } catch { return ""; } }
function maxMatches(text, regex) { return max([...text.matchAll(regex)].map((match) => Number(match[1]))); }
function onceExit(child) { return new Promise((resolve) => child.once("exit", resolve)); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function sum(values) { return values.reduce((total, value) => total + value, 0); }
function max(values) { return values.length === 0 ? 0 : Math.max(...values); }
function average(values) { return values.length === 0 ? 0 : sum(values) / values.length; }
function counterRate(samples, field) {
  if (samples.length < 2) return 0;
  const first = samples[0];
  const last = samples.at(-1);
  const elapsedSeconds = (last.timestampMs - first.timestampMs) / 1000;
  return elapsedSeconds > 0 ? Math.max(0, last[field] - first[field]) / elapsedSeconds : 0;
}
function median(values) { return percentile([...values].sort(numberOrder), 0.50); }
function percentile(sorted, ratio) { return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]; }
function numberOrder(left, right) { return left - right; }
function csvNumbers(value) { return value.split(",").map((item) => positive(item.trim(), "--players")); }
function positive(value, name) { const number = Number(value); if (!(number > 0)) throw new Error(`${name} must be > 0`); return number; }
function nonNegative(value, name) { const number = Number(value); if (!(number >= 0)) throw new Error(`${name} must be >= 0`); return number; }
function enumValue(value, allowed, name) { if (!allowed.includes(value)) throw new Error(`${name} must be one of ${allowed.join(", ")}`); return value; }
function round(value, digits = 0) { const scale = 10 ** digits; return Math.round(value * scale) / scale; }
function formatBytes(value) { return `${(value / 1024 / 1024).toFixed(1)}MB`; }
function formatRate(value) { return `${(value / 1024 / 1024).toFixed(2)}MB/s`; }
function timestamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_"); }
function machineInfo() { return { cpu: os.cpus()[0]?.model ?? "unknown", logicalCpus: os.cpus().length, memoryBytes: os.totalmem(), os: `${os.platform()} ${os.release()}` }; }
function writeJson(file, value) { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
