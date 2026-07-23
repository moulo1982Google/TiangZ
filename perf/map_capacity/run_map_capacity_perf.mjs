import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliArgs = process.argv.slice(2);
if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
  console.log(`用法：npm run perf:map-capacity -- [options]

主要参数：
  --players 100,150,200       玩家数量列表
  --gates 4                   Gate 数量
  --move-rate 5               每玩家每秒 Move 次数
  --movement-hold-messages 1  连续多少次 Move 保持同一方向
  --probe-rate 1              每玩家每秒 Probe RPC 次数
  --client-shards 1           Node 压测客户端进程数
  --client node|rust          压测客户端实现，默认 node
  --latency-sample-rate 0     链路分段采样；0 表示关闭
  --duration 30               正式测试秒数
  --warmup 10                 预热秒数
  --rounds 1                  每个负载重复轮数
  --io-backend epoll          epoll（Windows 实际使用 IOCP）或 io-uring
  --uring-entries 2048        io_uring 队列深度
  --uring-read-buffer-bytes 65536
  --probe-only                只测 Probe RPC，不发送 Move
  --skip-rust-build           使用已有 Runtime 二进制
  --debug-runtime             使用 debug Runtime
  --help                      显示帮助并退出`);
  process.exit(0);
}
const options = parseOptions(cliArgs);
if (options.client === "rust" && options.clientShards !== 1) {
  throw new Error("--client-shards currently supports the Node client only");
}
if (options.ioBackend === "io-uring" && process.platform !== "linux") {
  throw new Error("--io-backend io-uring only supports Linux");
}
if ((options.uringEntries & (options.uringEntries - 1)) !== 0) {
  throw new Error("--uring-entries must be a power of two");
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
  if (!options.skipRustBuild) {
    const cargoArgs = ["build"];
    if (!options.debugRuntime) cargoArgs.push("--release");
    if (options.ioBackend === "io-uring") {
      cargoArgs.push("--features", "io-uring");
    }
    cargoArgs.push("--bin", "TiangZ", "--bin", "map_probe_load");
    console.log(`[map-capacity] cargo ${cargoArgs.join(" ")}`);
    process.stdout.write(await runCommand("cargo", cargoArgs));
  }
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
      item.median.innerOverloads === 0 &&
      item.median.innerTimeouts === 0 &&
      item.median.slowDisconnects === 0 &&
      item.median.mapFormalWindowSamples >= 2
    )
    .sort((left, right) => right.players - left.players)[0];
  const validWindowCases = cases.filter((item) => item.median.mapFormalWindowSamples >= 2);
  const nearestTarget = [...validWindowCases].sort(
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

    clientResult = await runLoadClients(players);
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

async function runLoadClients(players) {
  const useRustClient = options.client === "rust";
  const shardCount = useRustClient ? 1 : Math.min(options.clientShards, players);
  const basePlayers = Math.floor(players / shardCount);
  const remainder = players % shardCount;
  const barrier = shardCount > 1 ? await createClientBarrier(shardCount) : undefined;
  let outputs;
  try {
    outputs = await Promise.all(Array.from({ length: shardCount }, (_, index) => {
      const shardPlayers = basePlayers + (index < remainder ? 1 : 0);
      return runCommand(useRustClient ? rustLoadClient : process.execPath, [
        ...(useRustClient ? [] : [loadClient]),
        "--host", "127.0.0.1",
        "--manager-port", String(options.managerPort),
        "--players", String(shardPlayers),
        "--setup-concurrency", String(options.setupConcurrency),
        "--duration", String(options.duration),
        "--warmup", String(options.warmup),
        "--move-rate", String(options.moveRate),
        "--movement-hold-messages", String(options.movementHoldMessages),
        "--probe-rate", String(options.probeRate),
        "--probe-concurrency", String(options.probeConcurrency),
        "--timeout", String(options.timeoutMs),
        "--movement-timeout", String(options.movementTimeoutMs),
        "--label", shardCount === 1 ? `${options.gates}g` : `${options.gates}g-s${index + 1}`,
        ...(barrier ? ["--barrier-port", String(barrier.port)] : []),
        ...(!useRustClient && options.probeOnly ? ["--disable-move"] : []),
      ]);
    }));
  } finally {
    await barrier?.close();
  }
  for (const output of outputs) process.stdout.write(output);
  const results = outputs.map((output, index) => {
    const line = output.split(/\r?\n/).findLast((item) => item.startsWith("RESULT_JSON "));
    if (!line) throw new Error(`load client shard ${index + 1} did not return RESULT_JSON`);
    return JSON.parse(line.slice("RESULT_JSON ".length));
  });
  return combineClientResults(results, players);
}

async function createClientBarrier(expectedClients) {
  const sockets = [];
  let release;
  const allReady = new Promise((resolve) => { release = resolve; });
  const server = net.createServer((socket) => {
    sockets.push(socket);
    if (sockets.length === expectedClients) release();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate client barrier port");
  void allReady.then(() => {
    for (const socket of sockets) socket.end(Uint8Array.of(1));
  });
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function combineClientResults(results, players) {
  if (results.length === 1) return results[0];
  const first = results[0];
  const latestStart = max(results.map((item) => item.measurementStartedAtUnixMs));
  const earliestEnd = Math.min(...results.map((item) => item.measurementEndedAtUnixMs));
  return {
    ...first,
    label: `${options.gates}g/${results.length}shards`,
    players,
    clientShards: results.length,
    latencyAggregation: "worst-shard-percentile",
    measurementStartedAtUnixMs: latestStart,
    measurementEndedAtUnixMs: Math.max(latestStart, earliestEnd),
    setup: {
      count: sum(results.map((item) => item.setup.count)),
      perSecond: sum(results.map((item) => item.setup.count)) /
        max(results.map((item) => item.setup.elapsedSeconds)),
      p50Ms: max(results.map((item) => item.setup.p50Ms)),
      p90Ms: max(results.map((item) => item.setup.p90Ms)),
      p95Ms: max(results.map((item) => item.setup.p95Ms)),
      p99Ms: max(results.map((item) => item.setup.p99Ms)),
      maxMs: max(results.map((item) => item.setup.maxMs)),
      elapsedSeconds: max(results.map((item) => item.setup.elapsedSeconds)),
    },
    movement: combineWorkload(results, "movement"),
    probe: combineWorkload(results, "probe"),
    loadGenerator: combineLoadGenerators(results),
  };
}

function combineWorkload(results, field) {
  const values = results.map((item) => item[field]);
  return {
    count: sum(values.map((item) => item.count)),
    perSecond: sum(values.map((item) => item.perSecond)),
    p50Ms: max(values.map((item) => item.p50Ms)),
    p90Ms: max(values.map((item) => item.p90Ms)),
    p95Ms: max(values.map((item) => item.p95Ms)),
    p99Ms: max(values.map((item) => item.p99Ms)),
    maxMs: max(values.map((item) => item.maxMs)),
    ...(field === "movement"
      ? {
        skippedTicks: sum(values.map((item) => item.skippedTicks ?? 0)),
        entityMovePushes: sum(values.map((item) => item.entityMovePushes ?? 0)),
        pushesPerSecond: sum(values.map((item) => item.pushesPerSecond ?? 0)),
      }
      : {}),
    errors: sum(values.map((item) => item.errors)),
  };
}

function combineLoadGenerators(results) {
  const values = results.map((item) => item.loadGenerator ?? {});
  return {
    kind: "node-sharded",
    shards: results.length,
    cpuUserMs: sum(values.map((item) => item.cpuUserMs ?? 0)),
    cpuSystemMs: sum(values.map((item) => item.cpuSystemMs ?? 0)),
    maxRssBytes: sum(values.map((item) => item.maxRssBytes ?? 0)),
    rssBytes: sum(values.map((item) => item.rssBytes ?? 0)),
    heapUsedBytes: sum(values.map((item) => item.heapUsedBytes ?? 0)),
    heapTotalBytes: sum(values.map((item) => item.heapTotalBytes ?? 0)),
    gcCount: sum(values.map((item) => item.gcCount ?? 0)),
    gcDurationMs: sum(values.map((item) => item.gcDurationMs ?? 0)),
  };
}

function writeTopologyConfigs(caseName) {
  const caseDir = path.join(configDir, caseName);
  mkdirSync(caseDir, { recursive: true });
  const scene = (name, sceneType, port) => ({
    name,
    sceneType,
    ip: "127.0.0.1",
    port,
    ...(options.ioBackend === "io-uring" ? { protocol: "tcp" } : {}),
  });
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
  return {
    process: {
      name,
      ...(options.latencySampleRate > 0
        ? {
          observability: {
            latency: {
              enabled: true,
              sampleRate: options.latencySampleRate,
            },
          },
        }
        : {}),
      network: {
        ioBackend: options.ioBackend,
        uringEntries: options.uringEntries,
        uringReadBufferBytes: options.uringReadBufferBytes,
      },
    },
    scenes,
    knownScenes,
  };
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
    const lines = text.split(/\r?\n/);
    const samples = lines
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
        transportReadOps: Number(values.transport_read_ops ?? 0),
        transportReadFrames: Number(values.transport_read_frames ?? 0),
        transportReadBytes: Number(values.transport_read_bytes ?? 0),
        transportWriteOps: Number(values.transport_write_ops ?? 0),
        transportWriteFrames: Number(values.transport_write_frames ?? 0),
        transportWriteBytes: Number(values.transport_write_bytes ?? 0),
      }));
    const completeWindowSamples = samples.filter((sample) =>
      startedAt && endedAt &&
      sample.timestampMs >= startedAt + 4_000 &&
      sample.timestampMs <= endedAt + 1_000
    );
    const selected = completeWindowSamples.length > 0
      ? completeWindowSamples
      : samples.slice(-Math.max(1, Math.floor(options.duration / 5)));
    const nativeDataSamples = lines
      .filter((line) => line.startsWith("[native-data-metrics] "))
      .map(parseMetricLine)
      .map((values, index) => ({
        timestampMs: samples[index]?.timestampMs ?? 0,
        scalarGets: Number(values.scalar_gets ?? 0),
        scalarSets: Number(values.scalar_sets ?? 0),
        batchCalls: Number(values.batch_calls ?? 0),
        liveEntities: Number(values.live_entities ?? 0),
        liveUnits: Number(values.live_units ?? 0),
        encodedFrames: Number(values.encoded_frames ?? 0),
        encodedItems: Number(values.encoded_items ?? 0),
        encodedBytes: Number(values.encoded_bytes ?? 0),
      }));
    const completeNativeDataSamples = nativeDataSamples.filter((sample) =>
      startedAt && endedAt &&
      sample.timestampMs >= startedAt + 4_000 &&
      sample.timestampMs <= endedAt + 1_000
    );
    const selectedNativeData = completeNativeDataSamples.length > 0
      ? completeNativeDataSamples
      : nativeDataSamples.slice(-Math.max(1, Math.floor(options.duration / 5)));
    const mapBroadcastSamples = lines
      .filter((line) => line.startsWith("[custom-metrics:") && line.includes("name=map_broadcast"))
      .map(parseMetricLine)
      .map((values) => ({
        timestampMs: Number(values.timestamp_ms ?? 0),
        inFlight: Number(values.in_flight ?? 0),
        inFlightUnits: Number(values.in_flight_units ?? 0),
        pendingUnits: Number(values.pending_units ?? 0),
        maxPendingUnits: Number(values.max_pending_units ?? 0),
        maxInFlightUnits: Number(values.max_in_flight_units ?? 0),
        queuedFrames: Number(values.queued_frames_total ?? 0),
        coalescedFrames: Number(values.coalesced_frames_total ?? 0),
        sentFrames: Number(values.sent_frames_total ?? 0),
        broadcastsStarted: Number(values.broadcasts_started_total ?? 0),
        broadcastsCompleted: Number(values.broadcasts_completed_total ?? 0),
        broadcastFailures: Number(values.broadcast_failures_total ?? 0),
        totalDurationMs: Number(values.total_duration_ms ?? 0),
        maxDurationMs: Number(values.max_duration_ms ?? 0),
        totalQueueWaitMs: Number(values.total_queue_wait_ms ?? 0),
        maxQueueWaitMs: Number(values.max_queue_wait_ms ?? 0),
      }));
    const completeMapBroadcastSamples = mapBroadcastSamples.filter((sample) =>
      startedAt && endedAt &&
      sample.timestampMs >= startedAt + 4_000 &&
      sample.timestampMs <= endedAt + 1_000
    );
    const selectedMapBroadcast = completeMapBroadcastSamples.length > 0
      ? completeMapBroadcastSamples
      : mapBroadcastSamples.slice(-Math.max(1, Math.floor(options.duration / 5)));
    return {
      ...summarizeProcess(runtime.name, selected, samples.at(-1)),
      formalWindowSamples: completeWindowSamples.length,
      mapBroadcast: summarizeMapBroadcast(
        selectedMapBroadcast,
        completeMapBroadcastSamples.length,
      ),
      nativeData: summarizeNativeData(
        selectedNativeData,
        completeNativeDataSamples.length,
      ),
    };
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
    gateTransportReadOpsPerSecond: sum(gates.map((item) => item.transportReadOpsPerSecond)),
    gateTransportReadFramesPerSecond: sum(gates.map((item) => item.transportReadFramesPerSecond)),
    gateTransportWriteOpsPerSecond: sum(gates.map((item) => item.transportWriteOpsPerSecond)),
    gateTransportWriteFramesPerSecond: sum(gates.map((item) => item.transportWriteFramesPerSecond)),
    totalPeakRssBytes: sum(processes.map((item) => item.peakRssBytes)),
  };
}

function parseMetricLine(line) {
  return Object.fromEntries(
    [...line.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)=([^\s]+)/g)]
      .map((match) => [match[1], match[2]]),
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
    peakV8HeapUsedBytes: max(samples.map((item) => item.v8HeapUsedBytes)),
    peakV8HeapTotalBytes: max(samples.map((item) => item.v8HeapTotalBytes)),
    v8GcCount: last?.v8GcCount ?? 0,
    v8GcMs: last?.v8GcMs ?? 0,
    outboundBatchesPerSecond: counterRate(samples, "outboundBatches"),
    outboundRecipientsPerSecond: counterRate(samples, "outboundRecipients"),
    outboundBridgeBytesPerSecond: counterRate(samples, "outboundBridgeBytes"),
    outboundLogicalBytesPerSecond: counterRate(samples, "outboundLogicalBytes"),
    transportReadOpsPerSecond: counterRate(samples, "transportReadOps"),
    transportReadFramesPerSecond: counterRate(samples, "transportReadFrames"),
    transportReadBytesPerSecond: counterRate(samples, "transportReadBytes"),
    transportWriteOpsPerSecond: counterRate(samples, "transportWriteOps"),
    transportWriteFramesPerSecond: counterRate(samples, "transportWriteFrames"),
    transportWriteBytesPerSecond: counterRate(samples, "transportWriteBytes"),
  };
}

function summarizeNativeData(samples, formalWindowSamples) {
  const measuredSeconds = samples.length * 5;
  return {
    samples: samples.length,
    formalWindowSamples,
    scalarGetsPerSecond: measuredSeconds > 0
      ? sum(samples.map((item) => item.scalarGets)) / measuredSeconds
      : 0,
    scalarSetsPerSecond: measuredSeconds > 0
      ? sum(samples.map((item) => item.scalarSets)) / measuredSeconds
      : 0,
    batchCallsPerSecond: measuredSeconds > 0
      ? sum(samples.map((item) => item.batchCalls)) / measuredSeconds
      : 0,
    liveEntities: samples.at(-1)?.liveEntities ?? 0,
    maxLiveEntities: max(samples.map((item) => item.liveEntities)),
    liveUnits: samples.at(-1)?.liveUnits ?? 0,
    maxLiveUnits: max(samples.map((item) => item.liveUnits)),
    encodedFramesPerSecond: measuredSeconds > 0
      ? sum(samples.map((item) => item.encodedFrames)) / measuredSeconds
      : 0,
    encodedItemsPerSecond: measuredSeconds > 0
      ? sum(samples.map((item) => item.encodedItems)) / measuredSeconds
      : 0,
    encodedBytesPerSecond: measuredSeconds > 0
      ? sum(samples.map((item) => item.encodedBytes)) / measuredSeconds
      : 0,
  };
}

function summarizeMapBroadcast(samples, formalWindowSamples) {
  const last = samples.at(-1);
  const queuedFrames = counterDelta(samples, "queuedFrames");
  const coalescedFrames = counterDelta(samples, "coalescedFrames");
  const sentFrames = counterDelta(samples, "sentFrames");
  const broadcastsStarted = counterDelta(samples, "broadcastsStarted");
  const broadcastsCompleted = counterDelta(samples, "broadcastsCompleted");
  return {
    samples: samples.length,
    formalWindowSamples,
    inFlightPeak: max(samples.map((item) => item.inFlight)),
    inFlightUnitsPeak: max(samples.map((item) => item.inFlightUnits)),
    pendingUnitsPeak: max(samples.map((item) => item.pendingUnits)),
    maxPendingUnits: max(samples.map((item) => item.maxPendingUnits)),
    maxInFlightUnits: max(samples.map((item) => item.maxInFlightUnits)),
    queuedFramesPerSecond: counterRate(samples, "queuedFrames"),
    coalescedFramesPerSecond: counterRate(samples, "coalescedFrames"),
    sentFramesPerSecond: counterRate(samples, "sentFrames"),
    broadcastsPerSecond: counterRate(samples, "broadcastsStarted"),
    coalescedPercent: queuedFrames > 0 ? coalescedFrames / queuedFrames * 100 : 0,
    framesPerBroadcast: broadcastsStarted > 0 ? sentFrames / broadcastsStarted : 0,
    averageDurationMs: broadcastsCompleted > 0
      ? counterDelta(samples, "totalDurationMs") / broadcastsCompleted
      : 0,
    maxDurationMs: max(samples.map((item) => item.maxDurationMs)),
    averageQueueWaitMs: broadcastsStarted > 0
      ? counterDelta(samples, "totalQueueWaitMs") / broadcastsStarted
      : 0,
    maxQueueWaitMs: max(samples.map((item) => item.maxQueueWaitMs)),
    failures: last?.broadcastFailures ?? 0,
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
      mapFormalWindowSamples: median(group.map(
        (item) => item.serverResources.map?.formalWindowSamples ?? 0,
      )),
      mapBroadcastSamples: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.formalWindowSamples ?? 0,
      )),
      mapBroadcastPendingUnitsPeak: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.pendingUnitsPeak ?? 0,
      )),
      mapBroadcastMaxPendingUnits: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.maxPendingUnits ?? 0,
      )),
      mapBroadcastQueuedFramesPerSecond: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.queuedFramesPerSecond ?? 0,
      )),
      mapBroadcastCoalescedFramesPerSecond: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.coalescedFramesPerSecond ?? 0,
      )),
      mapBroadcastSentFramesPerSecond: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.sentFramesPerSecond ?? 0,
      )),
      mapBroadcastsPerSecond: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.broadcastsPerSecond ?? 0,
      )),
      mapBroadcastCoalescedPercent: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.coalescedPercent ?? 0,
      )),
      mapBroadcastFramesPerBroadcast: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.framesPerBroadcast ?? 0,
      )),
      mapBroadcastAverageDurationMs: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.averageDurationMs ?? 0,
      )),
      mapBroadcastMaxDurationMs: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.maxDurationMs ?? 0,
      )),
      mapBroadcastAverageQueueWaitMs: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.averageQueueWaitMs ?? 0,
      )),
      mapBroadcastMaxQueueWaitMs: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.maxQueueWaitMs ?? 0,
      )),
      mapBroadcastFailures: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.failures ?? 0,
      )),
      nativeDataSamples: median(group.map(
        (item) => item.serverResources.map?.nativeData?.formalWindowSamples ?? 0,
      )),
      nativeScalarGetsPerSecond: median(group.map(
        (item) => item.serverResources.map?.nativeData?.scalarGetsPerSecond ?? 0,
      )),
      nativeScalarSetsPerSecond: median(group.map(
        (item) => item.serverResources.map?.nativeData?.scalarSetsPerSecond ?? 0,
      )),
      nativeBatchCallsPerSecond: median(group.map(
        (item) => item.serverResources.map?.nativeData?.batchCallsPerSecond ?? 0,
      )),
      nativeLiveEntities: median(group.map(
        (item) => item.serverResources.map?.nativeData?.liveEntities ?? 0,
      )),
      nativeLiveUnits: median(group.map(
        (item) => item.serverResources.map?.nativeData?.liveUnits ?? 0,
      )),
      nativeEncodedFramesPerSecond: median(group.map(
        (item) => item.serverResources.map?.nativeData?.encodedFramesPerSecond ?? 0,
      )),
      nativeEncodedItemsPerSecond: median(group.map(
        (item) => item.serverResources.map?.nativeData?.encodedItemsPerSecond ?? 0,
      )),
      nativeEncodedBytesPerSecond: median(group.map(
        (item) => item.serverResources.map?.nativeData?.encodedBytesPerSecond ?? 0,
      )),
      mapPeakV8HeapUsedBytes: median(group.map(
        (item) => item.serverResources.map?.peakV8HeapUsedBytes ?? 0,
      )),
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
      mapTransportReadOpsPerSecond: median(group.map(
        (item) => item.serverResources.map?.transportReadOpsPerSecond ?? 0,
      )),
      mapTransportReadFramesPerSecond: median(group.map(
        (item) => item.serverResources.map?.transportReadFramesPerSecond ?? 0,
      )),
      mapTransportWriteOpsPerSecond: median(group.map(
        (item) => item.serverResources.map?.transportWriteOpsPerSecond ?? 0,
      )),
      mapTransportWriteFramesPerSecond: median(group.map(
        (item) => item.serverResources.map?.transportWriteFramesPerSecond ?? 0,
      )),
      gateTransportReadOpsPerSecond: median(group.map(
        (item) => item.serverResources.gateTransportReadOpsPerSecond,
      )),
      gateTransportReadFramesPerSecond: median(group.map(
        (item) => item.serverResources.gateTransportReadFramesPerSecond,
      )),
      gateTransportWriteOpsPerSecond: median(group.map(
        (item) => item.serverResources.gateTransportWriteOpsPerSecond,
      )),
      gateTransportWriteFramesPerSecond: median(group.map(
        (item) => item.serverResources.gateTransportWriteFramesPerSecond,
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
      innerTimeouts: median(group.map((item) => item.transport.innerTimeouts)),
      backpressure: median(group.map((item) => item.transport.backpressure)),
      slowDisconnects: median(group.map((item) => item.transport.slowDisconnects)),
      serverRssBytes: median(group.map((item) => item.serverResources.totalPeakRssBytes)),
    },
  }));
}

function renderMarkdown(report) {
  const ioBackend = effectiveIoBackendName(options.ioBackend);
  const lines = [
    "# 单 MapHost 同屏容量测试报告",
    "",
    `- 时间：${report.generatedAt}`,
    `- 拓扑：1 MapHost / ${options.gates} Gate / 1 Login / 1 LoginMgr`,
    `- I/O Backend：${ioBackend}`,
    "- Unit 数据：Rust 权威存储，Rust 批处理并直接编码移动快照",
    `- 负载：${options.probeOnly ? "Probe Only，" : `每玩家 ${options.moveRate}Hz Move + `}每玩家 ${options.probeRate}Hz MapProbe`,
    ...(!options.probeOnly && options.movementHoldMessages > 1
      ? [`- 移动输入：每 ${options.movementHoldMessages} 次上报保持同一方向`]
      : []),
    `- Probe in-flight：每连接 ${options.probeConcurrency}`,
    ...(options.latencySampleRate > 0
      ? [`- 链路耗时采样：每 ${options.latencySampleRate} 个候选指标记录 1 个（诊断模式）`]
      : []),
    `- 压测客户端：${options.client === "rust" ? "Rust" : "Node.js"}`,
    `- 正式测试：${options.duration}s；预热：${options.warmup}s；轮数：${options.rounds}`,
    `- Map CPU 目标：${options.targetMapCpu}%（100% 表示一个逻辑核）`,
    `- 机器：${report.machine.cpu} / ${report.machine.logicalCpus} 逻辑核 / ${formatBytes(report.machine.memoryBytes)}`,
    "",
    `## ${options.rounds} 轮中位数`,
    "",
    "| 玩家 | Map CPU avg/p90/peak | Map 窗口样本 | Gate max avg/peak | move/s | Move 达标率 | push/s | Probe/s | Probe p50 | p90 | p95 | p99 | max | move/probe errors | overload/timeout/backpressure/slow | RSS |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const item of report.cases) {
    const value = item.median;
    lines.push(
      `| ${item.players} | ${round(value.mapCpuAverage, 1)}/${round(value.mapCpuP90, 1)}/${round(value.mapCpuPeak, 1)}% | ` +
      `${value.mapFormalWindowSamples} | ${round(value.gateMaxCpuAverage, 1)}/${round(value.gateMaxCpuPeak, 1)}% | ${round(value.movesPerSecond)} | ` +
      `${round(value.moveTargetPercent, 1)}% | ${round(value.pushesPerSecond)} | ${round(value.probePerSecond)} | ${round(value.probeP50Ms, 2)}ms | ` +
      `${round(value.probeP90Ms, 2)}ms | ${round(value.probeP95Ms, 2)}ms | ${round(value.probeP99Ms, 2)}ms | ` +
      `${round(value.probeMaxMs, 2)}ms | ${value.moveErrors}/${value.probeErrors} | ` +
      `${value.innerOverloads}/${value.innerTimeouts}/${value.backpressure}/${value.slowDisconnects} | ${formatBytes(value.serverRssBytes)} |`,
    );
  }
  lines.push(
    "",
    "## NativeData 边界指标",
    "",
    "| 玩家 | 指标样本 | scalar gets/s | scalar sets/s | batch calls/s | encoded frames/items | encoded bytes/s | live Entities/Units | Map V8 Heap peak |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const item of report.cases) {
    const value = item.median;
    lines.push(
      `| ${item.players} | ${value.nativeDataSamples} | ` +
      `${round(value.nativeScalarGetsPerSecond, 1)} | ${round(value.nativeScalarSetsPerSecond, 1)} | ` +
      `${round(value.nativeBatchCallsPerSecond, 1)} | ` +
      `${round(value.nativeEncodedFramesPerSecond, 1)}/${round(value.nativeEncodedItemsPerSecond)} | ` +
      `${formatBytes(value.nativeEncodedBytesPerSecond)}/s | ` +
      `${round(value.nativeLiveEntities)}/${round(value.nativeLiveUnits)} | ` +
      `${formatBytes(value.mapPeakV8HeapUsedBytes)} |`,
    );
  }
  lines.push(
    "",
    "## Map 广播 single-flight",
    "",
    "| 玩家 | 指标样本 | pending 采样峰值/生命周期峰值 | queued/s | coalesced/s (%) | sent/s | batch/s | frames/batch | 广播 avg/max | 排队 avg/max | failures |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const item of report.cases) {
    const value = item.median;
    lines.push(
      `| ${item.players} | ${value.mapBroadcastSamples} | ` +
      `${round(value.mapBroadcastPendingUnitsPeak)}/${round(value.mapBroadcastMaxPendingUnits)} | ` +
      `${round(value.mapBroadcastQueuedFramesPerSecond)} | ` +
      `${round(value.mapBroadcastCoalescedFramesPerSecond)} (${round(value.mapBroadcastCoalescedPercent, 1)}%) | ` +
      `${round(value.mapBroadcastSentFramesPerSecond)} | ${round(value.mapBroadcastsPerSecond, 1)} | ` +
      `${round(value.mapBroadcastFramesPerBroadcast, 1)} | ` +
      `${round(value.mapBroadcastAverageDurationMs, 2)}/${round(value.mapBroadcastMaxDurationMs, 2)}ms | ` +
      `${round(value.mapBroadcastAverageQueueWaitMs, 2)}/${round(value.mapBroadcastMaxQueueWaitMs, 2)}ms | ` +
      `${value.mapBroadcastFailures} |`,
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
    "## Transport Backend",
    "",
    "| 玩家 | Map read frames/op | Map write frames/op | Gate read frames/op | Gate write frames/op |",
    "|---:|---:|---:|---:|---:|",
    ...report.cases.map(({ players, median: item }) => `| ${players} | ${ratio(item.mapTransportReadFramesPerSecond, item.mapTransportReadOpsPerSecond)} | ${ratio(item.mapTransportWriteFramesPerSecond, item.mapTransportWriteOpsPerSecond)} | ${ratio(item.gateTransportReadFramesPerSecond, item.gateTransportReadOpsPerSecond)} | ${ratio(item.gateTransportWriteFramesPerSecond, item.gateTransportWriteOpsPerSecond)} |`),
    "",
    "## 指标口径",
    "",
    "- `MapProbe` 是 ActorLocation RPC，链路为客户端 -> Gate -> MapHost -> Gate -> 客户端，不产生 AOI 广播。",
    "- Map/Gate CPU 使用正式测试窗口内的 5 秒进程 CPU 样本；平均值用于容量判断。",
    "- Map 正式窗口至少需要 2 个 CPU 样本；不足时该测试点只作故障诊断，不参与容量候选。",
    options.probeOnly
      ? "- Probe Only 模式关闭 Move 和 AOI 广播，用于测 MapHost pingpong RPC 基线吞吐。"
      : "- Move 按固定频率开环发送，吞吐只统计正式窗口内实际写入的请求；容量点要求实际吞吐至少达到目标的 95%。",
    "- `backpressure` 表示入口有界队列满后等待重试，是削峰信号，不等于丢包；容量候选要求零业务错误、零 overload、零内部超时和零慢连接断开。",
    options.probeOnly
      ? "- Probe Only 模式不包含 AOI 下行。"
      : "- 虚拟客户端只拆分并计数 AOI 帧，不逐连接反序列化全员移动快照；端到端延迟由 MapProbe 独立测量。",
    "- `push/s` 仍是全地图全量可见广播，代表最坏同屏 O(N^2) 场景。",
    "- Map 移动广播采用 single-flight；前一批未完成时，同一 Unit 的后续帧只保留最新状态。`pending`、合并率、广播耗时和排队时间用于判断下行是否跟不上 Game.Update。",
    "- Gate 数量用于分摊连接、编码和下行发送；MapHost 始终只有一个。",
    "",
  );
  return lines.join("\n");
}

function effectiveIoBackendName(configuredBackend) {
  if (process.platform === "win32" && configuredBackend === "epoll") {
    return "IOCP（Tokio/Mio；兼容配置值 epoll）";
  }
  return configuredBackend;
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
  const options = {
    players: csvNumbers(values.get("--players") ?? "100,125,150,175,200"),
    gates: positive(values.get("--gates") ?? "4", "--gates"),
    // Demo 默认客户端输入上报频率是 5Hz；服务端 Game.Update 默认保持 20Hz。
    moveRate: nonNegative(values.get("--move-rate") ?? "5", "--move-rate"),
    movementHoldMessages: positive(
      values.get("--movement-hold-messages") ?? "1",
      "--movement-hold-messages",
    ),
    probeRate: positive(values.get("--probe-rate") ?? "1", "--probe-rate"),
    probeConcurrency: positive(values.get("--probe-concurrency") ?? "1", "--probe-concurrency"),
    clientShards: positive(values.get("--client-shards") ?? "1", "--client-shards"),
    latencySampleRate: nonNegative(
      values.get("--latency-sample-rate") ?? "0",
      "--latency-sample-rate",
    ),
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
    skipRustBuild: flags.has("--skip-rust-build"),
    probeOnly: flags.has("--probe-only"),
    client: enumValue(values.get("--client") ?? "node", ["node", "rust"], "--client"),
    ioBackend: enumValue(
      values.get("--io-backend") ?? values.get("--network-backend") ?? "epoll",
      ["epoll", "io-uring"],
      "--io-backend",
    ),
    uringEntries: positive(values.get("--uring-entries") ?? "2048", "--uring-entries"),
    uringReadBufferBytes: positive(
      values.get("--uring-read-buffer-bytes") ?? "65536",
      "--uring-read-buffer-bytes",
    ),
  };
  return options;
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
function counterDelta(samples, field) {
  if (samples.length < 2) return 0;
  return Math.max(0, samples.at(-1)[field] - samples[0][field]);
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
function ratio(numerator, denominator) { return denominator > 0 ? (numerator / denominator).toFixed(2) : "0.00"; }
function timestamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_"); }
function machineInfo() { return { cpu: os.cpus()[0]?.model ?? "unknown", logicalCpus: os.cpus().length, memoryBytes: os.totalmem(), os: `${os.platform()} ${os.release()}` }; }
function writeJson(file, value) { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
