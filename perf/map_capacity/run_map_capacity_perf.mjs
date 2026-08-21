import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SanitizePerformanceReport } from "../lib/sanitize_report.mjs";
import { InspectRuntimeLog } from "../lib/runtime_log_health.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliArgs = process.argv.slice(2);
if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
  console.log(`用法：npm run perf:map-capacity -- [options]

主要参数：
  --players 3000              玩家数量列表；默认正式基线为3000
  --gates 16                  Gate 数量
  --move-rate 2               每玩家每秒 Move 次数（默认500ms一次）
  --movement-hold-messages 2  连续多少次 Move 保持同一方向
  --spawn-layout grid-uniform same-point|single-grid|grid-uniform；默认均匀分布全部Grid
  --entry-sync-mode full      full|attach-only|new-observer-only|existing-observers-only；仅Bench诊断
  --world-grids 10            Grid世界边长；当前支持10|15|20
  --probe-rate 0.2            每玩家每秒 Probe RPC 次数（默认5秒一次）
  --business-rate 0          每玩家每秒真实道具/技能请求次数；默认关闭
  --state-sync-mode off       off|numeric|player|item|mixed
  --state-sync-rate 0         每玩家每秒状态同步触发 RPC 次数
  --state-sync-concurrency 4  每玩家状态同步最大 in-flight
  --client-shards 1           Node 压测客户端进程数
  --client node|rust          压测客户端实现，默认 rust
  --latency-sample-rate 0     链路分段采样；0 表示关闭
  --duration 30               正式测试秒数
  --post-setup-settle 0       全员进图后、负载预热前的空闲排空秒数
  --warmup 10                 预热秒数
  --rounds 1                  每个负载重复轮数
  --setup-concurrency 16      Login、Gate建连和LoginGate并发度
  --map-entry-concurrency N   连接全部就绪后单独释放Map Enter；仅Rust客户端
  --map-entry-rate N          两阶段Map Enter开环释放速率（人/秒）；仅Rust客户端
  --io-backend epoll          epoll（Windows 实际使用 IOCP）或 io-uring
  --uring-entries 2048        io_uring 队列深度
  --uring-read-buffer-bytes 65536
  --probe-only                只测 Probe RPC，不发送 Move
  --hotfix-mode off          off|baseline|reload；baseline 只开启同口径观测
  --hotfix-candidates a,b    reload 模式交替加载的候选目录
  --hotfix-interval-ms 1000  在线 Reload 周期
  --health-base-port 7800    Hotfix 测试使用的 Process 健康端口起点
  --location-port 7401       Location Scene 内网端口
  --map-inspector-port 0     仅为Map开启V8 Inspector；0表示关闭
  --map-profile-duration 10  Inspector开启时采集CPU Profile的秒数
  --skip-rust-build           使用已有 Runtime 二进制
  --debug-runtime             使用 debug Runtime
  --help                      显示帮助并退出`);
  process.exit(0);
}
const options = parseOptions(cliArgs);
if (options.stateSyncMode !== "off" && options.client !== "rust") {
  throw new Error("--state-sync-mode currently requires --client rust");
}
if (options.client === "rust" && options.clientShards !== 1) {
  throw new Error("--client-shards currently supports the Node client only");
}
if (options.mapEntryConcurrency !== null && options.client !== "rust") {
  throw new Error("--map-entry-concurrency requires --client rust");
}
if (options.mapEntryRate !== null && options.client !== "rust") {
  throw new Error("--map-entry-rate requires --client rust");
}
if (options.mapEntryRate !== null && options.mapEntryConcurrency === null) {
  throw new Error("--map-entry-rate requires --map-entry-concurrency");
}
if (options.spawnLayout === "grid-uniform" && options.client !== "rust") {
  throw new Error("--spawn-layout grid-uniform currently requires --client rust");
}
if (options.entrySyncMode !== "full" && options.client !== "rust") {
  throw new Error("--entry-sync-mode diagnostic variants require --client rust");
}
if (options.entrySyncMode !== "full" && options.spawnLayout === "same-point") {
  throw new Error("--entry-sync-mode diagnostic variants require single-grid or grid-uniform");
}
if (options.worldGrids !== 10 && options.client !== "rust") {
  throw new Error("--world-grids 15|20 currently requires --client rust");
}
if (options.hotfixMode === "reload" && options.client !== "rust") {
  throw new Error("--hotfix-mode reload requires --client rust for measurement alignment");
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
  assertBenchBundle();
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
      item.median.mapUpdateTargetPercentMin >= 95 &&
      item.median.mapSkippedFixedUpdates === 0 &&
      item.median.moveTargetPercent >= 95 &&
      item.median.aoiRelocationTargetPercent >= 80 &&
      item.median.aoiRelocationTargetPercent <= 120 &&
      item.median.stateSyncTargetPercent >= 95 &&
      item.median.moveErrors === 0 &&
      item.median.probeErrors === 0 &&
      item.median.stateSyncErrors === 0 &&
      item.median.businessTargetPercent >= 95 &&
      item.median.businessTransportErrors === 0 &&
      item.median.innerOverloads === 0 &&
      item.median.innerTimeouts === 0 &&
      item.median.backpressure === 0 &&
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
  const topology = writeTopologyConfigs(caseName, round);
  const runtimes = [];
  let clientResult;
  let hotfixController;
  let hotfixResult;
  let healthSampler;
  let healthSamples;
  let profileTask;
  let profilePath;
  let caseError;
  try {
    for (const runtime of topology.runtimes) {
      runtimes.push(startRuntime(runtime));
    }
    for (const port of topology.ports) {
      await waitPort("127.0.0.1", port, 30_000);
    }
    await Promise.all(runtimes.map((runtime) => waitReady(runtime.healthPort, 30_000)));
    // MapHost 的首次路由注册可能早于独立 Location 就绪；等待一次恢复周期，
    // 避免把启动竞态误记为入图容量失败。该等待不进入预热或正式测量窗口。
    await sleep(5_500);

    healthSampler = startHealthSampler(runtimes);
    const measurementSignal = path.join(configDir, `${caseName}_measurement.txt`);
    const clientTask = runLoadClients(players, topology.managerPort, round, measurementSignal);
    if (options.hotfixMode === "reload" || options.mapInspectorPort > 0) {
      // 地图入场保护会限制每Tick放行数量；大规模诊断不能用固定120秒误杀尚在正常建连的测试。
      // Map admission is intentionally tick-limited, so large diagnostic runs need a player-scaled wait.
      const measurementSignalTimeoutMs = Math.max(120_000, players * 100);
      const measurementStartedAt = await waitMeasurementSignal(
        measurementSignal,
        measurementSignalTimeoutMs,
      );
      if (options.hotfixMode === "reload") {
        hotfixController = startHotfixReloadController(runtimes, measurementStartedAt);
      }
      if (options.mapInspectorPort > 0) {
        profilePath = path.join(resultDir, `map_capacity_${runId}_${caseName}.cpuprofile`);
        profileTask = runCommand(process.execPath, [
          path.join(root, "tools", "capture_v8_profile.mjs"),
          "--port", String(options.mapInspectorPort),
          "--duration", String(options.mapProfileDuration),
          "--out", profilePath,
        ]);
      }
    }
    clientResult = await clientTask;
    if (profileTask) process.stdout.write(await profileTask);
    healthSamples = await healthSampler?.stop() ?? new Map();
    hotfixResult = await hotfixController?.stop(clientResult) ?? {
      mode: options.hotfixMode,
      attempts: 0,
      formalWindowAttempts: 0,
      formalWindowCompleted: 0,
      formalWindowMissed: 0,
      samples: [],
    };
  } catch (error) {
    caseError = error;
  } finally {
    if (hotfixController && !hotfixResult) {
      hotfixResult = await hotfixController.stop(clientResult);
    }
    if (healthSampler && !healthSamples) healthSamples = await healthSampler.stop();
    await stopRuntimes(runtimes);
  }

  const runtimeLogFailures = collectRuntimeLogFailures(runtimes);
  if (!caseError && (runtimeLogFailures.errors > 0 || runtimeLogFailures.panics > 0)) {
    caseError = new Error(
      `server logs contain ${runtimeLogFailures.errors} ERROR line(s) and ` +
      `${runtimeLogFailures.panics} panic line(s); see ${logDir}`,
    );
  }

  if (caseError) {
    const failure = {
      generatedAt: new Date().toISOString(),
      runId,
      caseName,
      parameters: options,
      error: caseError instanceof Error
        ? { name: caseError.name, message: caseError.message, stack: caseError.stack }
        : { name: "UnknownError", message: String(caseError) },
      serverResources: collectRuntimeResources(
        runtimes,
        clientResult?.measurementStartedAtUnixMs,
        clientResult?.measurementEndedAtUnixMs,
        healthSamples,
      ),
      clientResult,
      runtimeLogFailures,
      logDirectory: logDir,
      configDirectory: configDir,
    };
    const failurePath = path.join(resultDir, `map_capacity_${runId}_${caseName}_failure.json`);
    writeJson(failurePath, failure);
    console.error(`[map-capacity] failure diagnostics: ${failurePath}`);
    throw caseError;
  }

  const resources = collectRuntimeResources(
    runtimes,
    clientResult?.measurementStartedAtUnixMs,
    clientResult?.measurementEndedAtUnixMs,
    healthSamples,
  );
  return {
    ...clientResult,
    gates: options.gates,
    round,
    serverResources: resources,
    transport: collectTransportMetrics(runtimes, resources),
    hotfix: hotfixResult,
    profilePath,
    logDirectory: logDir,
    configDirectory: configDir,
  };
}

async function runLoadClients(players, managerPort, round, measurementSignal) {
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
        "--manager-port", String(managerPort),
        ...(useRustClient ? ["--map-id", String(options.mapId)] : []),
        ...(useRustClient && process.platform === "win32"
          ? ["--source-ip", `127.0.0.${
            options.sourceIpBase + options.players.indexOf(players) * options.rounds + round - 1
          }`]
          : []),
        ...(useRustClient ? ["--measurement-signal-file", measurementSignal] : []),
        "--players", String(shardPlayers),
        "--setup-concurrency", String(options.setupConcurrency),
        ...(useRustClient && options.mapEntryConcurrency !== null
          ? ["--map-entry-concurrency", String(options.mapEntryConcurrency)]
          : []),
        ...(useRustClient && options.mapEntryRate !== null
          ? ["--map-entry-rate", String(options.mapEntryRate)]
          : []),
        "--post-setup-settle", String(options.postSetupSettle),
        "--duration", String(options.duration),
        "--warmup", String(options.warmup),
        "--move-rate", String(options.moveRate),
        "--movement-hold-messages", String(options.movementHoldMessages),
        "--spawn-layout", options.spawnLayout,
        ...(useRustClient ? ["--world-grids", String(options.worldGrids)] : []),
        ...(useRustClient ? ["--entry-sync-mode", options.entrySyncMode] : []),
        "--probe-rate", String(options.probeRate),
        "--probe-concurrency", String(options.probeConcurrency),
        "--business-rate", String(options.businessRate),
        "--state-sync-mode", options.stateSyncMode,
        "--state-sync-rate", String(options.stateSyncRate),
        "--state-sync-concurrency", String(options.stateSyncConcurrency),
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
    business: combineBusiness(results),
    stateSync: combineStateSync(results),
    loadGenerator: combineLoadGenerators(results),
  };
}

function combineBusiness(results) {
  const values = results.map((item) => item.business ?? {});
  return {
    targetRatePerPlayer: options.businessRate,
    count: sum(values.map((item) => item.count ?? 0)),
    perSecond: sum(values.map((item) => item.perSecond ?? 0)),
    accepted: sum(values.map((item) => item.accepted ?? 0)),
    rejected: sum(values.map((item) => item.rejected ?? 0)),
    transportErrors: sum(values.map((item) => item.transportErrors ?? 0)),
    p50Ms: max(values.map((item) => item.p50Ms ?? 0)),
    p90Ms: max(values.map((item) => item.p90Ms ?? 0)),
    p95Ms: max(values.map((item) => item.p95Ms ?? 0)),
    p99Ms: max(values.map((item) => item.p99Ms ?? 0)),
    maxMs: max(values.map((item) => item.maxMs ?? 0)),
  };
}

function combineStateSync(results) {
  const values = results.map((item) => item.stateSync ?? {});
  return {
    mode: options.stateSyncMode,
    targetRatePerPlayer: options.stateSyncRate,
    count: sum(values.map((item) => item.count ?? 0)),
    perSecond: sum(values.map((item) => item.perSecond ?? 0)),
    p50Ms: max(values.map((item) => item.p50Ms ?? 0)),
    p90Ms: max(values.map((item) => item.p90Ms ?? 0)),
    p95Ms: max(values.map((item) => item.p95Ms ?? 0)),
    p99Ms: max(values.map((item) => item.p99Ms ?? 0)),
    maxMs: max(values.map((item) => item.maxMs ?? 0)),
    errors: sum(values.map((item) => item.errors ?? 0)),
    numericPushes: sum(values.map((item) => item.numericPushes ?? 0)),
    playerInfoPushes: sum(values.map((item) => item.playerInfoPushes ?? 0)),
    itemPushes: sum(values.map((item) => item.itemPushes ?? 0)),
    numericPushesPerSecond: sum(values.map((item) => item.numericPushesPerSecond ?? 0)),
    numericItemsPerSecond: sum(values.map((item) => item.numericItemsPerSecond ?? 0)),
    numericBytesPerSecond: sum(values.map((item) => item.numericBytesPerSecond ?? 0)),
    playerInfoPushesPerSecond: sum(values.map((item) => item.playerInfoPushesPerSecond ?? 0)),
    playerInfoItemsPerSecond: sum(values.map((item) => item.playerInfoItemsPerSecond ?? 0)),
    playerInfoBytesPerSecond: sum(values.map((item) => item.playerInfoBytesPerSecond ?? 0)),
    itemPushesPerSecond: sum(values.map((item) => item.itemPushesPerSecond ?? 0)),
    itemItemsPerSecond: sum(values.map((item) => item.itemItemsPerSecond ?? 0)),
    itemBytesPerSecond: sum(values.map((item) => item.itemBytesPerSecond ?? 0)),
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

function writeTopologyConfigs(caseName, round) {
  const caseDir = path.join(configDir, caseName);
  mkdirSync(caseDir, { recursive: true });
  // Windows 会为登录阶段的短连接保留 TIME_WAIT；每轮换一组服务端端口，避免本机
  // 临时端口耗尽干扰长时间 A/B 测试。业务拓扑、连接数和协议链路保持不变。
  const roundPortOffset = (round - 1) * 100;
  const managerPort = options.managerPort + roundPortOffset;
  const loginPort = options.loginPort + roundPortOffset;
  const gateBasePort = options.gateBasePort + roundPortOffset;
  const mapPort = options.mapPort + roundPortOffset;
  const locationPort = options.locationPort + roundPortOffset;
  const healthBasePort = options.healthBasePort + roundPortOffset;
  const scene = (name, sceneType, port) => ({
    name,
    sceneType,
    ip: "127.0.0.1",
    port,
    ...(options.ioBackend === "io-uring" ? { protocol: "tcp" } : {}),
  });
  const managerScene = scene("login_mgr", "LoginMgr", managerPort);
  const loginScene = scene("login_1", "Login", loginPort);
  const mapScene = {
    ...scene("map_1", "MapHost", mapPort),
    staticMapIds: [options.mapId],
  };
  const locationScene = scene("location_1", "Location", locationPort);
  const gateScenes = Array.from(
    { length: options.gates },
    (_, index) => scene(`gate_${index + 1}`, "Gate", gateBasePort + index),
  );
  const configs = [
    runtimeConfig("map1", [mapScene], [...gateScenes, locationScene]),
    ...gateScenes.map((gate, index) =>
      runtimeConfig(`gate${index + 1}`, [gate], [mapScene, locationScene])
    ),
    runtimeConfig("login1", [loginScene], gateScenes),
    runtimeConfig("mgr", [managerScene], [loginScene]),
    runtimeConfig("location", [locationScene], []),
  ];
  const runtimes = configs.map((config, index) => {
    const healthPort = healthBasePort + index;
    if (healthPort) {
      config.process.observability = {
        ...config.process.observability,
        health: { ip: "127.0.0.1", port: healthPort },
      };
    }
    const configPath = path.join(caseDir, `${config.process.name}.json`);
    writeJson(configPath, config);
    return {
      name: config.process.name,
      configPath,
      healthPort,
      logName: `${caseName}_${config.process.name}`,
    };
  });
  return {
    runtimes,
    ports: [
      managerPort,
      loginPort,
      mapPort,
      locationPort,
      ...gateScenes.map((item) => item.port),
      ...runtimes.flatMap((runtime) => runtime.healthPort ? [runtime.healthPort] : []),
      ...(options.mapInspectorPort > 0 ? [options.mapInspectorPort] : []),
    ],
    managerPort,
  };
}

function runtimeConfig(name, scenes, knownScenes, healthPort) {
  const observability = {
    ...(options.latencySampleRate > 0
      ? {
        latency: {
          enabled: true,
          sampleRate: options.latencySampleRate,
        },
      }
      : {}),
    ...(healthPort
      ? {
        health: {
          ip: "127.0.0.1",
          port: healthPort,
        },
      }
      : {}),
  };
  return {
    process: {
      name,
      ...(Object.keys(observability).length > 0 ? { observability } : {}),
      network: {
        ioBackend: options.ioBackend,
        uringEntries: options.uringEntries,
        uringReadBufferBytes: options.uringReadBufferBytes,
      },
      ...(name === "map1" && options.mapInspectorPort > 0
        ? {
          debug: {
            inspectorIp: "127.0.0.1",
            inspectorPort: options.mapInspectorPort,
            breakOnStart: false,
          },
        }
        : {}),
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
    env: options.hotfixMode === "off"
      ? process.env
      : { ...process.env, TIANGZ_WATCHER_CONTROL: "stdin" },
    stdio: [options.hotfixMode === "off" ? "ignore" : "pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.pipe(createWriteStream(stdoutPath));
  child.stderr.pipe(createWriteStream(stderrPath));
  return { child, name: runtime.name, healthPort: runtime.healthPort, stdoutPath, stderrPath };
}

function startHotfixReloadController(runtimes, startAtUnixMs) {
  let active = true;
  let attempts = 0;
  const samples = [];
  const task = (async () => {
    if (startAtUnixMs > Date.now()) await sleep(startAtUnixMs - Date.now());
    let nextAt = startAtUnixMs;
    while (active) {
      const waitMs = nextAt - Date.now();
      if (waitMs > 0) await sleep(waitMs);
      if (!active) break;
      const candidate = options.hotfixCandidates[attempts % options.hotfixCandidates.length];
      attempts += 1;
      const requestedAtUnixMs = Date.now();
      const before = await Promise.all(runtimes.map(readHotfixMetrics));
      for (const runtime of runtimes) runtime.child.stdin.write(`reload ${candidate}\n`);

      const deadline = requestedAtUnixMs + options.hotfixIntervalMs;
      let snapshots = [];
      while (active && Date.now() < deadline) {
        snapshots = await Promise.all(runtimes.map(readHotfixMetrics));
        if (snapshots.every((snapshot, index) =>
          snapshot.successes > (before[index].successes ?? 0) ||
          snapshot.failures > (before[index].failures ?? 0)
        )) break;
        await sleep(25);
      }
      const completedAtUnixMs = Date.now();
      const map = snapshots.find((snapshot) => snapshot.process === "map1") ?? {};
      const completedProcesses = snapshots.filter((snapshot, index) =>
        snapshot.successes > (before[index].successes ?? 0)
      ).length;
      const failedProcesses = snapshots.filter((snapshot, index) =>
        snapshot.failures > (before[index].failures ?? 0)
      ).length;
      samples.push({
        attempt: attempts,
        candidate,
        requestedAtUnixMs,
        completedAtUnixMs,
        completed: completedProcesses === runtimes.length,
        processSuccesses: completedProcesses,
        processFailures: failedProcesses,
        processCount: runtimes.length,
        map,
      });
      nextAt += options.hotfixIntervalMs;
      if (nextAt < Date.now()) nextAt = Date.now();
    }
  })();
  return {
    stop: async (clientResult) => {
      active = false;
      await task;
      const startedAt = clientResult?.measurementStartedAtUnixMs ?? Number.MAX_SAFE_INTEGER;
      const endedAt = clientResult?.measurementEndedAtUnixMs ?? 0;
      const formal = samples.filter((sample) =>
        sample.requestedAtUnixMs >= startedAt && sample.requestedAtUnixMs <= endedAt
      );
      return {
        mode: options.hotfixMode,
        intervalMs: options.hotfixIntervalMs,
        attempts,
        formalWindowAttempts: formal.length,
        formalWindowCompleted: formal.filter((sample) => sample.completed).length,
        formalWindowMissed: formal.filter((sample) => !sample.completed).length,
        samples: formal,
      };
    },
  };
}

async function waitMeasurementSignal(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = readText(file).trim();
    if (value) return Number(value);
    await sleep(25);
  }
  throw new Error(`timed out waiting for measurement signal ${file}`);
}

function startHealthSampler(runtimes) {
  let active = true;
  const samples = new Map(runtimes.map((runtime) => [runtime.name, []]));
  const task = (async () => {
    while (active) {
      const snapshots = await Promise.all(runtimes.map(readProcessHealthMetrics));
      for (const snapshot of snapshots) {
        if (!snapshot.timestampMs) continue;
        const processSamples = samples.get(snapshot.process);
        if (processSamples && processSamples.at(-1)?.timestampMs !== snapshot.timestampMs) {
          processSamples.push(snapshot);
        }
      }
      await sleep(1_000);
    }
  })();
  return {
    stop: async () => {
      active = false;
      await task;
      return samples;
    },
  };
}

async function readProcessHealthMetrics(runtime) {
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.healthPort}/metrics`);
    if (!response.ok) return { process: runtime.name };
    const body = await response.text();
    const metric = (name) => prometheusMetric(body, name);
    const stageMetric = (name, stage) => prometheusMetricWithLabel(body, name, "stage", stage);
    const queueStages = Object.fromEntries(
      ["frame", "completion", "disconnect", "shutdown", "control_ingress", "data_ingress"]
        .map((stage) => [stage, {
        depth: stageMetric("tiangz_process_queue_stage_depth", stage),
        maxDepth: stageMetric("tiangz_process_queue_stage_max_depth", stage),
        backpressureWaits: stageMetric(
          "tiangz_process_queue_stage_backpressure_waits_total",
          stage,
        ),
        waitMs: stageMetric(
          "tiangz_process_queue_stage_backpressure_wait_ms_total",
          stage,
        ),
        maxWaitMs: stageMetric(
          "tiangz_process_queue_stage_backpressure_wait_ms_max",
          stage,
        ),
        }]),
    );
    const innerOverloadStages = Object.fromEntries(
      ["manager_queue", "connection_queue", "call_writer_queue", "send_writer_queue", "target_ingress_queue"]
        .map((stage) => [stage, stageMetric(
          "tiangz_transport_inner_overload_stage_rejections_total",
          stage,
        )]),
    );
    return {
      process: runtime.name,
      cpuPercent: metric("tiangz_process_cpu_percent"),
      cpuTimeMs: metric("tiangz_process_cpu_time_ms"),
      rssBytes: metric("tiangz_process_rss_bytes"),
      v8HeapUsedBytes: metric("tiangz_process_v8_heap_used_bytes"),
      v8HeapTotalBytes: metric("tiangz_process_v8_heap_total_bytes"),
      v8GcCount: metric("tiangz_process_v8_gc_count_total"),
      v8GcMs: metric("tiangz_process_v8_gc_ms_total"),
      gameFixedUpdateMs: metric("tiangz_game_fixed_update_ms"),
      gameFrameCount: metric("tiangz_game_frame_count_total"),
      gameSkippedFixedUpdates: metric("tiangz_game_skipped_fixed_updates_total"),
      timestampMs: metric("tiangz_process_metrics_timestamp_ms"),
      outboundBatches: metric("tiangz_process_outbound_batches_total"),
      outboundRecipients: metric("tiangz_process_outbound_recipients_total"),
      outboundBridgeBytes: metric("tiangz_process_outbound_bridge_bytes_total"),
      outboundLogicalBytes: metric("tiangz_process_outbound_logical_bytes_total"),
      transportReadOps: metric("tiangz_process_transport_read_ops_total"),
      transportReadFrames: metric("tiangz_process_transport_read_frames_total"),
      transportReadBytes: metric("tiangz_process_transport_read_bytes_total"),
      transportWriteOps: metric("tiangz_process_transport_write_ops_total"),
      transportWriteFrames: metric("tiangz_process_transport_write_frames_total"),
      transportWriteBytes: metric("tiangz_process_transport_write_bytes_total"),
      backpressure: metric("tiangz_process_backpressure_waits_total"),
      slowDisconnects: metric("tiangz_process_slow_disconnects_total"),
      innerOverloads: metric("tiangz_transport_inner_overload_rejections"),
      innerOverloadStages,
      innerTimeouts: metric("tiangz_transport_inner_timed_out_calls"),
      queueStages,
      nativeScalarGets: metric("tiangz_native_scalar_gets_total"),
      nativeScalarSets: metric("tiangz_native_scalar_sets_total"),
      nativeBatchCalls: metric("tiangz_native_batch_calls_total"),
      nativeLiveEntities: metric("tiangz_native_live_entities"),
      nativeLiveUnits: metric("tiangz_native_live_units"),
      nativeLiveItems: metric("tiangz_native_live_items"),
      nativePoolCapacityBytes: metric("tiangz_native_pool_capacity_bytes"),
      nativeScratchCapacityBytes: metric("tiangz_native_scratch_capacity_bytes"),
      nativeScratchGrowths: metric("tiangz_native_scratch_growths_total"),
      nativeRefs: prometheusMetricSum(body, "tiangz_native_refs"),
      nativeEncodedFrames: metric("tiangz_native_encoded_frames_total"),
      nativeEncodedItems: metric("tiangz_native_encoded_items_total"),
      nativeEncodedBytes: metric("tiangz_native_encoded_bytes_total"),
      numericReplication: readNumericReplicationMetrics(body),
      aoiWorlds: metric("tiangz_aoi_worlds"),
      aoiEntries: metric("tiangz_aoi_entries"),
      aoiGrids: metric("tiangz_aoi_grids"),
      aoiCandidateRelations: metric("tiangz_aoi_candidate_relations"),
      aoiVisibleRelations: metric("tiangz_aoi_visible_relations"),
      aoiLingeringRelations: metric("tiangz_aoi_lingering_relations"),
      aoiRejectedRelations: metric("tiangz_aoi_rejected_relations"),
      aoiRelocations: metric("tiangz_aoi_relocations_total"),
      aoiVisibilityChanges: metric("tiangz_aoi_visibility_changes_total"),
      aoiFilterOverrides: metric("tiangz_aoi_filter_overrides_total"),
      mapBroadcast: readMapBroadcastMetrics(body),
      mapEntry: readMapEntryMetrics(body),
      actorLatestForward: readActorLatestForwardMetrics(body),
    };
  } catch {
    return { process: runtime.name };
  }
}

async function readHotfixMetrics(runtime) {
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.healthPort}/metrics`);
    if (!response.ok) return { process: runtime.name };
    const body = await response.text();
    return {
      process: runtime.name,
      generation: prometheusMetric(body, "tiangz_hotfix_active_generation"),
      successes: prometheusMetric(body, "tiangz_hotfix_reload_successes_total"),
      failures: prometheusMetric(body, "tiangz_hotfix_reload_failures_total"),
      preflightMs: prometheusMetric(body, "tiangz_hotfix_preflight_ms"),
      barrierWaitMs: prometheusMetric(body, "tiangz_hotfix_barrier_wait_ms"),
      candidateEvalMs: prometheusMetric(body, "tiangz_hotfix_candidate_eval_ms"),
      commitMs: prometheusMetric(body, "tiangz_hotfix_commit_ms"),
      reloadTotalMs: prometheusMetric(body, "tiangz_hotfix_reload_total_ms"),
    };
  } catch {
    return { process: runtime.name };
  }
}

function prometheusMetric(body, name) {
  const line = body.split(/\r?\n/).find((value) => value.startsWith(`${name}{`));
  return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : 0;
}

function prometheusMetricWithLabel(body, name, label, value) {
  const expected = `${label}="${value}"`;
  const line = body.split(/\r?\n/).find((candidate) =>
    candidate.startsWith(`${name}{`) && candidate.includes(expected)
  );
  return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : 0;
}

function prometheusMetricSum(body, name) {
  return body.split(/\r?\n/)
    .filter((line) => line.startsWith(`${name}{`))
    .reduce((total, line) => total + Number(line.slice(line.lastIndexOf(" ") + 1)), 0);
}

function readNumericReplicationMetrics(body) {
  const result = {};
  for (const [metricName, field] of [
    ["tiangz_native_numeric_changes_total", "changes"],
    ["tiangz_native_numeric_encoded_records_total", "encodedRecords"],
    ["tiangz_native_numeric_recipient_deliveries_total", "recipientDeliveries"],
    ["tiangz_native_numeric_logical_bytes_total", "logicalBytes"],
  ]) {
    for (const line of body.split(/\r?\n/).filter((value) => value.startsWith(`${metricName}{`))) {
      const match = line.match(/numeric_type="(\d+)"/);
      if (!match) continue;
      const numericType = match[1];
      const item = result[numericType] ??= {
        changes: 0,
        encodedRecords: 0,
        recipientDeliveries: 0,
        logicalBytes: 0,
      };
      item[field] = Number(line.slice(line.lastIndexOf(" ") + 1));
    }
  }
  return result;
}

function prometheusCustomMetric(body, key, customName = "map_broadcast") {
  const line = body.split(/\r?\n/).find((value) =>
    (value.startsWith("tiangz_scene_custom_metric_total{") ||
      value.startsWith("tiangz_scene_custom_metric_gauge{")) &&
    value.includes(`name="${customName}"`) && value.includes(`key="${key}"`)
  );
  return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : 0;
}

function prometheusCustomMetricSum(body, key, customName) {
  return body.split(/\r?\n/)
    .filter((line) =>
      (line.startsWith("tiangz_scene_custom_metric_total{") ||
        line.startsWith("tiangz_scene_custom_metric_gauge{")) &&
      line.includes(`name="${customName}"`) && line.includes(`key="${key}"`)
    )
    .reduce((total, line) => total + Number(line.slice(line.lastIndexOf(" ") + 1)), 0);
}

function readMapBroadcastMetrics(body) {
  return {
    inFlight: prometheusCustomMetric(body, "in_flight"),
    inFlightUnits: prometheusCustomMetric(body, "in_flight_units"),
    pendingUnits: prometheusCustomMetric(body, "pending_units"),
    maxPendingUnits: prometheusCustomMetric(body, "max_pending_units"),
    maxInFlightUnits: prometheusCustomMetric(body, "max_in_flight_units"),
    queuedFrames: prometheusCustomMetric(body, "queued_frames_total"),
    coalescedFrames: prometheusCustomMetric(body, "coalesced_frames_total"),
    supersededPublishes: prometheusCustomMetric(body, "superseded_publishes_total"),
    latestCapacityRejections: prometheusCustomMetric(body, "latest_capacity_rejections_total"),
    sentFrames: prometheusCustomMetric(body, "sent_frames_total"),
    broadcastsStarted: prometheusCustomMetric(body, "broadcasts_started_total"),
    broadcastsCompleted: prometheusCustomMetric(body, "broadcasts_completed_total"),
    broadcastFailures: prometheusCustomMetric(body, "broadcast_failures_total"),
    totalDurationMs: prometheusCustomMetric(body, "total_duration_ms"),
    maxDurationMs: prometheusCustomMetric(body, "max_duration_ms"),
    totalQueueWaitMs: prometheusCustomMetric(body, "total_queue_wait_ms"),
    maxQueueWaitMs: prometheusCustomMetric(body, "max_queue_wait_ms"),
    totalDispatchMs: prometheusCustomMetric(body, "total_dispatch_ms"),
    maxDispatchMs: prometheusCustomMetric(body, "max_dispatch_ms"),
    movementAdvanceMs: prometheusCustomMetric(body, "movement_advance_ms_total"),
    aoiRefreshMs: prometheusCustomMetric(body, "aoi_refresh_ms_total"),
    movementEncodeMs: prometheusCustomMetric(body, "movement_encode_ms_total"),
    audienceMapMs: prometheusCustomMetric(body, "audience_map_ms_total"),
    numericPeekMs: prometheusCustomMetric(body, "numeric_peek_ms_total"),
    statePeekMs: prometheusCustomMetric(body, "state_peek_ms_total"),
    updateCount: prometheusCustomMetric(body, "update_count_total"),
    audienceMapCount: prometheusCustomMetric(body, "audience_map_count_total"),
    numericPeekCount: prometheusCustomMetric(body, "numeric_peek_count_total"),
    statePeekCount: prometheusCustomMetric(body, "state_peek_count_total"),
    playerEntryQueue: prometheusCustomMetric(body, "player_entry_queue"),
    playerEntryQueuePeak: prometheusCustomMetric(body, "player_entry_queue_peak"),
    playerEntriesAdmitted: prometheusCustomMetric(body, "player_entries_admitted_total"),
    playerEntryFailures: prometheusCustomMetric(body, "player_entry_failures_total"),
    playerEntryQueueWaitMs: prometheusCustomMetric(body, "player_entry_queue_wait_ms_total"),
    playerEntryQueueWaitMaxMs: prometheusCustomMetric(body, "player_entry_queue_wait_ms_max"),
    playerEntryAttachMs: prometheusCustomMetric(body, "player_entry_attach_ms_total"),
    playerEntryAttachMaxMs: prometheusCustomMetric(body, "player_entry_attach_ms_max"),
    playerEntryVisibilityChanges: prometheusCustomMetric(
      body,
      "player_entry_visibility_changes_total",
    ),
    playerEntrySnapshotCalls: prometheusCustomMetric(body, "player_entry_snapshot_calls_total"),
    playerEntrySnapshotItems: prometheusCustomMetric(body, "player_entry_snapshot_items_total"),
    playerEntrySnapshotMs: prometheusCustomMetric(body, "player_entry_snapshot_ms_total"),
    playerEntrySnapshotMaxMs: prometheusCustomMetric(body, "player_entry_snapshot_ms_max"),
    playerEntrySnapshotBuilds: prometheusCustomMetric(body, "player_entry_snapshot_builds_total"),
    playerEntrySnapshotMaterializedItems: prometheusCustomMetric(
      body,
      "player_entry_snapshot_materialized_items_total",
    ),
    playerEntrySnapshotAudienceReuseHits: prometheusCustomMetric(
      body,
      "player_entry_snapshot_audience_reuse_hits_total",
    ),
    playerEntrySnapshotUnitReuseHits: prometheusCustomMetric(
      body,
      "player_entry_snapshot_unit_reuse_hits_total",
    ),
    aoiDeltaBatches: prometheusCustomMetric(body, "aoi_delta_batches_total"),
    aoiDeltaEnterItems: prometheusCustomMetric(body, "aoi_delta_enter_items_total"),
    aoiDeltaLeaveItems: prometheusCustomMetric(body, "aoi_delta_leave_items_total"),
    aoiDeltaRecipients: prometheusCustomMetric(body, "aoi_delta_recipients_total"),
    aoiDeltaDeliveries: prometheusCustomMetric(body, "aoi_delta_deliveries_total"),
    aoiDeltaPrepareMs: prometheusCustomMetric(body, "aoi_delta_prepare_ms_total"),
    aoiDeltaPublishMs: prometheusCustomMetric(body, "aoi_delta_publish_ms_total"),
  };
}

function readActorLatestForwardMetrics(body) {
  const metric = (key) => prometheusCustomMetricSum(body, key, "actor_latest_forward");
  return {
    pendingFrames: metric("pending_frames"),
    queued: metric("queued_total"),
    coalesced: metric("coalesced_total"),
    forwarded: metric("forwarded_total"),
    batches: metric("batches_total"),
    failedBatches: metric("failed_batches_total"),
    failedFrames: metric("failed_frames_total"),
    dropped: metric("dropped_total"),
  };
}

function readMapEntryMetrics(body) {
  const metric = (key) => prometheusCustomMetric(body, key, "map_entry");
  return {
    requests: metric("requests_total"),
    completed: metric("completed_total"),
    failures: metric("failures_total"),
    inFlight: metric("in_flight"),
    maxInFlight: metric("max_in_flight"),
    durationMs: metric("duration_ms_total"),
    maxDurationMs: metric("duration_ms_max"),
    idAllocations: metric("id_allocations_total"),
    idAllocationMs: metric("id_allocation_ms_total"),
    maxIdAllocationMs: metric("id_allocation_ms_max"),
    playerCreates: metric("player_creates_total"),
    playerCreateMs: metric("player_create_ms_total"),
    maxPlayerCreateMs: metric("player_create_ms_max"),
    locationRegisters: metric("location_registers_total"),
    locationRegisterMs: metric("location_register_ms_total"),
    maxLocationRegisterMs: metric("location_register_ms_max"),
    mapReadySends: metric("map_ready_sends_total"),
    mapReadySendMs: metric("map_ready_send_ms_total"),
    maxMapReadySendMs: metric("map_ready_send_ms_max"),
    locationResolves: metric("location_resolves_total"),
    locationResolveMs: metric("location_resolve_ms_total"),
    maxLocationResolveMs: metric("location_resolve_ms_max"),
  };
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

function collectRuntimeLogFailures(runtimes) {
  const processes = runtimes.map((runtime) => ({
    process: runtime.name,
    ...InspectRuntimeLog(readRuntimeLogs(runtime)),
  }));
  return {
    errors: sum(processes.map((item) => item.errors)),
    panics: sum(processes.map((item) => item.panics)),
    processes,
  };
}

function collectRuntimeResources(runtimes, startedAt, endedAt, healthSamples = new Map()) {
  const processes = runtimes.map((runtime) => {
    const text = readRuntimeLogs(runtime);
    const lines = text.split(/\r?\n/);
    const logSamples = lines
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
    const samples = healthSamples.get(runtime.name)?.length > 0
      ? healthSamples.get(runtime.name)
      : logSamples;
    const completeWindowSamples = samples.filter((sample) =>
      startedAt && endedAt &&
      sample.timestampMs >= startedAt + 4_000 &&
      sample.timestampMs <= endedAt + 1_000
    );
    const selected = completeWindowSamples.length > 0
      ? completeWindowSamples
      : samples.slice(-Math.max(1, Math.floor(options.duration / 5)));
    const nativeDataSamples = healthSamples.get(runtime.name)?.length > 0
      ? samples.map((sample) => ({
        timestampMs: sample.timestampMs,
        scalarGets: sample.nativeScalarGets,
        scalarSets: sample.nativeScalarSets,
        batchCalls: sample.nativeBatchCalls,
        liveEntities: sample.nativeLiveEntities,
        liveUnits: sample.nativeLiveUnits,
        liveItems: sample.nativeLiveItems,
        poolCapacityBytes: sample.nativePoolCapacityBytes,
        scratchCapacityBytes: sample.nativeScratchCapacityBytes,
        scratchGrowths: sample.nativeScratchGrowths,
        nativeRefs: sample.nativeRefs,
        encodedFrames: sample.nativeEncodedFrames,
        encodedItems: sample.nativeEncodedItems,
        encodedBytes: sample.nativeEncodedBytes,
        numericReplication: sample.numericReplication,
        aoiWorlds: sample.aoiWorlds,
        aoiEntries: sample.aoiEntries,
        aoiGrids: sample.aoiGrids,
        aoiCandidateRelations: sample.aoiCandidateRelations,
        aoiVisibleRelations: sample.aoiVisibleRelations,
        aoiLingeringRelations: sample.aoiLingeringRelations,
        aoiRejectedRelations: sample.aoiRejectedRelations,
        aoiRelocations: sample.aoiRelocations,
        aoiVisibilityChanges: sample.aoiVisibilityChanges,
        aoiFilterOverrides: sample.aoiFilterOverrides,
      }))
      : lines
        .filter((line) => line.startsWith("[native-data-metrics] "))
        .map(parseMetricLine)
        .map((values, index) => ({
          timestampMs: samples[index]?.timestampMs ?? 0,
          scalarGets: Number(values.scalar_gets ?? 0),
          scalarSets: Number(values.scalar_sets ?? 0),
          batchCalls: Number(values.batch_calls ?? 0),
          liveEntities: Number(values.live_entities ?? 0),
          liveUnits: Number(values.live_units ?? 0),
          liveItems: Number(values.live_items ?? 0),
          poolCapacityBytes: Number(values.pool_capacity_bytes ?? 0),
          scratchCapacityBytes: Number(values.scratch_capacity_bytes ?? 0),
          scratchGrowths: Number(values.scratch_growths ?? 0),
          nativeRefs: Number(values.native_refs ?? 0),
          encodedFrames: Number(values.encoded_frames ?? 0),
          encodedItems: Number(values.encoded_items ?? 0),
          encodedBytes: Number(values.encoded_bytes ?? 0),
          aoiWorlds: Number(values.aoi_worlds ?? 0),
          aoiEntries: Number(values.aoi_entries ?? 0),
          aoiGrids: Number(values.aoi_grids ?? 0),
          aoiCandidateRelations: Number(values.aoi_candidate_relations ?? 0),
          aoiVisibleRelations: Number(values.aoi_visible_relations ?? 0),
          aoiLingeringRelations: Number(values.aoi_lingering_relations ?? 0),
          aoiRejectedRelations: Number(values.aoi_rejected_relations ?? 0),
          aoiRelocations: Number(values.aoi_relocations ?? 0),
          aoiVisibilityChanges: Number(values.aoi_visibility_changes ?? 0),
          aoiFilterOverrides: Number(values.aoi_filter_overrides ?? 0),
        }));
    const completeNativeDataSamples = nativeDataSamples.filter((sample) =>
      startedAt && endedAt &&
      sample.timestampMs >= startedAt + 4_000 &&
      sample.timestampMs <= endedAt + 1_000
    );
    const selectedNativeData = completeNativeDataSamples.length > 0
      ? completeNativeDataSamples
      : nativeDataSamples.slice(-Math.max(1, Math.floor(options.duration / 5)));
    const mapBroadcastSamples = healthSamples.get(runtime.name)?.length > 0
      ? samples.map((sample) => ({ timestampMs: sample.timestampMs, ...sample.mapBroadcast }))
      : lines
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
        supersededPublishes: Number(values.superseded_publishes_total ?? 0),
        latestCapacityRejections: Number(values.latest_capacity_rejections_total ?? 0),
        sentFrames: Number(values.sent_frames_total ?? 0),
        broadcastsStarted: Number(values.broadcasts_started_total ?? 0),
        broadcastsCompleted: Number(values.broadcasts_completed_total ?? 0),
        broadcastFailures: Number(values.broadcast_failures_total ?? 0),
        totalDurationMs: Number(values.total_duration_ms ?? 0),
        maxDurationMs: Number(values.max_duration_ms ?? 0),
        totalQueueWaitMs: Number(values.total_queue_wait_ms ?? 0),
        maxQueueWaitMs: Number(values.max_queue_wait_ms ?? 0),
        totalDispatchMs: Number(values.total_dispatch_ms ?? 0),
        maxDispatchMs: Number(values.max_dispatch_ms ?? 0),
        movementAdvanceMs: Number(values.movement_advance_ms_total ?? 0),
        aoiRefreshMs: Number(values.aoi_refresh_ms_total ?? 0),
        movementEncodeMs: Number(values.movement_encode_ms_total ?? 0),
        audienceMapMs: Number(values.audience_map_ms_total ?? 0),
        numericPeekMs: Number(values.numeric_peek_ms_total ?? 0),
        statePeekMs: Number(values.state_peek_ms_total ?? 0),
        updateCount: Number(values.update_count_total ?? 0),
        audienceMapCount: Number(values.audience_map_count_total ?? 0),
        numericPeekCount: Number(values.numeric_peek_count_total ?? 0),
        statePeekCount: Number(values.state_peek_count_total ?? 0),
        playerEntryQueue: Number(values.player_entry_queue ?? 0),
        playerEntryQueuePeak: Number(values.player_entry_queue_peak ?? 0),
        playerEntriesAdmitted: Number(values.player_entries_admitted_total ?? 0),
        playerEntryFailures: Number(values.player_entry_failures_total ?? 0),
        playerEntryQueueWaitMs: Number(values.player_entry_queue_wait_ms_total ?? 0),
        playerEntryQueueWaitMaxMs: Number(values.player_entry_queue_wait_ms_max ?? 0),
        playerEntryAttachMs: Number(values.player_entry_attach_ms_total ?? 0),
        playerEntryAttachMaxMs: Number(values.player_entry_attach_ms_max ?? 0),
        playerEntryVisibilityChanges: Number(values.player_entry_visibility_changes_total ?? 0),
        playerEntrySnapshotCalls: Number(values.player_entry_snapshot_calls_total ?? 0),
        playerEntrySnapshotItems: Number(values.player_entry_snapshot_items_total ?? 0),
        playerEntrySnapshotMs: Number(values.player_entry_snapshot_ms_total ?? 0),
        playerEntrySnapshotMaxMs: Number(values.player_entry_snapshot_ms_max ?? 0),
        playerEntrySnapshotBuilds: Number(values.player_entry_snapshot_builds_total ?? 0),
        playerEntrySnapshotMaterializedItems: Number(
          values.player_entry_snapshot_materialized_items_total ?? 0,
        ),
        playerEntrySnapshotAudienceReuseHits: Number(
          values.player_entry_snapshot_audience_reuse_hits_total ?? 0,
        ),
        playerEntrySnapshotUnitReuseHits: Number(
          values.player_entry_snapshot_unit_reuse_hits_total ?? 0,
        ),
        aoiDeltaBatches: Number(values.aoi_delta_batches_total ?? 0),
        aoiDeltaEnterItems: Number(values.aoi_delta_enter_items_total ?? 0),
        aoiDeltaLeaveItems: Number(values.aoi_delta_leave_items_total ?? 0),
        aoiDeltaRecipients: Number(values.aoi_delta_recipients_total ?? 0),
        aoiDeltaDeliveries: Number(values.aoi_delta_deliveries_total ?? 0),
        aoiDeltaPrepareMs: Number(values.aoi_delta_prepare_ms_total ?? 0),
        aoiDeltaPublishMs: Number(values.aoi_delta_publish_ms_total ?? 0),
        }));
    const completeMapBroadcastSamples = mapBroadcastSamples.filter((sample) =>
      startedAt && endedAt &&
      sample.timestampMs >= startedAt + 4_000 &&
      sample.timestampMs <= endedAt + 1_000
    );
    const selectedMapBroadcast = completeMapBroadcastSamples.length > 0
      ? completeMapBroadcastSamples
      : mapBroadcastSamples.slice(-Math.max(1, Math.floor(options.duration / 5)));
    const actorLatestForwardSamples = selected.map((sample) => ({
      timestampMs: sample.timestampMs,
      ...sample.actorLatestForward,
    }));
    const mapEntrySamples = healthSamples.get(runtime.name)?.length > 0
      ? samples.map((sample) => ({ timestampMs: sample.timestampMs, ...sample.mapEntry }))
      : lines
        .filter((line) => line.startsWith("[custom-metrics:") && line.includes("name=map_entry"))
        .map(parseMetricLine)
        .map((values) => ({
          timestampMs: Number(values.timestamp_ms ?? 0),
          requests: Number(values.requests_total ?? 0),
          completed: Number(values.completed_total ?? 0),
          failures: Number(values.failures_total ?? 0),
          inFlight: Number(values.in_flight ?? 0),
          maxInFlight: Number(values.max_in_flight ?? 0),
          durationMs: Number(values.duration_ms_total ?? 0),
          maxDurationMs: Number(values.duration_ms_max ?? 0),
          idAllocations: Number(values.id_allocations_total ?? 0),
          idAllocationMs: Number(values.id_allocation_ms_total ?? 0),
          maxIdAllocationMs: Number(values.id_allocation_ms_max ?? 0),
          playerCreates: Number(values.player_creates_total ?? 0),
          playerCreateMs: Number(values.player_create_ms_total ?? 0),
          maxPlayerCreateMs: Number(values.player_create_ms_max ?? 0),
          locationRegisters: Number(values.location_registers_total ?? 0),
          locationRegisterMs: Number(values.location_register_ms_total ?? 0),
          maxLocationRegisterMs: Number(values.location_register_ms_max ?? 0),
          mapReadySends: Number(values.map_ready_sends_total ?? 0),
          mapReadySendMs: Number(values.map_ready_send_ms_total ?? 0),
          maxMapReadySendMs: Number(values.map_ready_send_ms_max ?? 0),
          locationResolves: Number(values.location_resolves_total ?? 0),
          locationResolveMs: Number(values.location_resolve_ms_total ?? 0),
          maxLocationResolveMs: Number(values.location_resolve_ms_max ?? 0),
        }));
    return {
      ...summarizeProcess(runtime.name, selected, samples.at(-1)),
      lifecycleTransportReadBytes: counterDelta(samples, "transportReadBytes"),
      lifecycleTransportWriteBytes: counterDelta(samples, "transportWriteBytes"),
      lifecycleOutboundBridgeBytes: counterDelta(samples, "outboundBridgeBytes"),
      lifecycleOutboundLogicalBytes: counterDelta(samples, "outboundLogicalBytes"),
      formalWindowSamples: completeWindowSamples.length,
      mapBroadcast: summarizeMapBroadcast(
        selectedMapBroadcast,
        completeMapBroadcastSamples.length,
        mapBroadcastSamples.at(-1),
      ),
      mapEntry: summarizeMapEntry(mapEntrySamples),
      nativeData: summarizeNativeData(
        selectedNativeData,
        completeNativeDataSamples.length,
      ),
      actorLatestForward: summarizeActorLatestForward(actorLatestForwardSamples),
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
    gateActorLatestQueuedPerSecond: sum(
      gates.map((item) => item.actorLatestForward?.queuedPerSecond ?? 0),
    ),
    gateActorLatestCoalescedPerSecond: sum(
      gates.map((item) => item.actorLatestForward?.coalescedPerSecond ?? 0),
    ),
    gateActorLatestForwardedPerSecond: sum(
      gates.map((item) => item.actorLatestForward?.forwardedPerSecond ?? 0),
    ),
    gateActorLatestBatchesPerSecond: sum(
      gates.map((item) => item.actorLatestForward?.batchesPerSecond ?? 0),
    ),
    gateActorLatestPendingFramesPeak: sum(
      gates.map((item) => item.actorLatestForward?.pendingFramesPeak ?? 0),
    ),
    gateActorLatestFailedBatches: sum(
      gates.map((item) => item.actorLatestForward?.failedBatches ?? 0),
    ),
    gateActorLatestFailedFrames: sum(
      gates.map((item) => item.actorLatestForward?.failedFrames ?? 0),
    ),
    gateActorLatestDropped: sum(
      gates.map((item) => item.actorLatestForward?.dropped ?? 0),
    ),
    gateLifecycleOutboundBridgeBytes: sum(gates.map((item) => item.lifecycleOutboundBridgeBytes)),
    gateLifecycleOutboundLogicalBytes: sum(gates.map((item) => item.lifecycleOutboundLogicalBytes)),
    gateLifecycleTransportWriteBytes: sum(gates.map((item) => item.lifecycleTransportWriteBytes)),
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
  const selectedLast = samples.at(-1) ?? last;
  const stageNames = [
    "frame",
    "completion",
    "disconnect",
    "shutdown",
    "control_ingress",
    "data_ingress",
  ];
  const queueStages = Object.fromEntries(stageNames.map((stage) => [stage, {
    depth: selectedLast?.queueStages?.[stage]?.depth ?? 0,
    maxDepth: last?.queueStages?.[stage]?.maxDepth ?? 0,
    backpressureWaits: nestedCounterDelta(
      samples,
      (sample) => sample.queueStages?.[stage]?.backpressureWaits,
    ),
    waitMs: nestedCounterDelta(samples, (sample) => sample.queueStages?.[stage]?.waitMs),
    maxWaitMs: last?.queueStages?.[stage]?.maxWaitMs ?? 0,
  }]));
  const overloadStageNames = [
    "manager_queue",
    "connection_queue",
    "call_writer_queue",
    "send_writer_queue",
    "target_ingress_queue",
  ];
  const innerOverloadStages = Object.fromEntries(overloadStageNames.map((stage) => [
    stage,
    nestedCounterDelta(samples, (sample) => sample.innerOverloadStages?.[stage]),
  ]));
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
    gameFixedUpdateMs: selectedLast?.gameFixedUpdateMs ?? 0,
    gameFramesPerSecond: counterRate(samples, "gameFrameCount"),
    gameSkippedFixedUpdates: counterDelta(samples, "gameSkippedFixedUpdates"),
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
    backpressure: counterDelta(samples, "backpressure"),
    slowDisconnects: counterDelta(samples, "slowDisconnects"),
    innerOverloads: counterDelta(samples, "innerOverloads"),
    innerOverloadStages,
    innerTimeouts: counterDelta(samples, "innerTimeouts"),
    queueStages,
  };
}

function processQueueStage(round, processName, stage, field) {
  const process = round.serverResources.processes.find((item) => item.process === processName);
  return process?.queueStages?.[stage]?.[field] ?? 0;
}

function gateTransportOverloadStage(round, stage) {
  return sum(round.serverResources.gates.map(
    (gate) => gate.innerOverloadStages?.[stage] ?? 0,
  ));
}

function summarizeNativeData(samples, formalWindowSamples) {
  const numericTypes = [...new Set(samples.flatMap(
    (sample) => Object.keys(sample.numericReplication ?? {}),
  ))].sort((left, right) => Number(left) - Number(right));
  return {
    samples: samples.length,
    formalWindowSamples,
    scalarGetsPerSecond: counterRate(samples, "scalarGets"),
    scalarSetsPerSecond: counterRate(samples, "scalarSets"),
    batchCallsPerSecond: counterRate(samples, "batchCalls"),
    liveEntities: samples.at(-1)?.liveEntities ?? 0,
    maxLiveEntities: max(samples.map((item) => item.liveEntities)),
    liveUnits: samples.at(-1)?.liveUnits ?? 0,
    maxLiveUnits: max(samples.map((item) => item.liveUnits)),
    liveItems: samples.at(-1)?.liveItems ?? 0,
    poolCapacityBytes: max(samples.map((item) => item.poolCapacityBytes)),
    scratchCapacityBytes: max(samples.map((item) => item.scratchCapacityBytes)),
    scratchGrowths: samples.at(-1)?.scratchGrowths ?? 0,
    scratchGrowthsPerSecond: counterRate(samples, "scratchGrowths"),
    nativeRefs: samples.at(-1)?.nativeRefs ?? 0,
    encodedFramesPerSecond: counterRate(samples, "encodedFrames"),
    encodedItemsPerSecond: counterRate(samples, "encodedItems"),
    encodedBytesPerSecond: counterRate(samples, "encodedBytes"),
    numericReplication: Object.fromEntries(numericTypes.map((numericType) => [numericType, {
      changesPerSecond: nestedCounterRate(
        samples,
        (sample) => sample.numericReplication?.[numericType]?.changes,
      ),
      encodedRecordsPerSecond: nestedCounterRate(
        samples,
        (sample) => sample.numericReplication?.[numericType]?.encodedRecords,
      ),
      recipientDeliveriesPerSecond: nestedCounterRate(
        samples,
        (sample) => sample.numericReplication?.[numericType]?.recipientDeliveries,
      ),
      logicalBytesPerSecond: nestedCounterRate(
        samples,
        (sample) => sample.numericReplication?.[numericType]?.logicalBytes,
      ),
    }])),
    aoiWorlds: samples.at(-1)?.aoiWorlds ?? 0,
    aoiEntries: samples.at(-1)?.aoiEntries ?? 0,
    aoiGrids: samples.at(-1)?.aoiGrids ?? 0,
    aoiCandidateRelations: samples.at(-1)?.aoiCandidateRelations ?? 0,
    aoiVisibleRelations: samples.at(-1)?.aoiVisibleRelations ?? 0,
    aoiLingeringRelations: samples.at(-1)?.aoiLingeringRelations ?? 0,
    aoiRejectedRelations: samples.at(-1)?.aoiRejectedRelations ?? 0,
    aoiRelocationsPerSecond: counterRate(samples, "aoiRelocations"),
    aoiVisibilityChangesPerSecond: counterRate(samples, "aoiVisibilityChanges"),
    aoiFilterOverridesPerSecond: counterRate(samples, "aoiFilterOverrides"),
  };
}

function summarizeMapBroadcast(samples, formalWindowSamples, lifecycleLast = samples.at(-1)) {
  const last = samples.at(-1);
  const queuedFrames = counterDelta(samples, "queuedFrames");
  const coalescedFrames = counterDelta(samples, "coalescedFrames");
  const sentFrames = counterDelta(samples, "sentFrames");
  const broadcastsStarted = counterDelta(samples, "broadcastsStarted");
  const broadcastsCompleted = counterDelta(samples, "broadcastsCompleted");
  const updateCount = counterDelta(samples, "updateCount");
  const audienceMapCount = counterDelta(samples, "audienceMapCount");
  const numericPeekCount = counterDelta(samples, "numericPeekCount");
  const statePeekCount = counterDelta(samples, "statePeekCount");
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
    supersededPublishesPerSecond: counterRate(samples, "supersededPublishes"),
    latestCapacityRejections: last?.latestCapacityRejections ?? 0,
    sentFramesPerSecond: counterRate(samples, "sentFrames"),
    broadcastsPerSecond: counterRate(samples, "broadcastsStarted"),
    updatesPerSecond: counterRate(samples, "updateCount"),
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
    averageDispatchMs: broadcastsStarted > 0
      ? counterDelta(samples, "totalDispatchMs") / broadcastsStarted
      : 0,
    maxDispatchMs: max(samples.map((item) => item.maxDispatchMs)),
    averageMovementAdvanceMs: updateCount > 0
      ? counterDelta(samples, "movementAdvanceMs") / updateCount
      : 0,
    averageAoiRefreshMs: updateCount > 0
      ? counterDelta(samples, "aoiRefreshMs") / updateCount
      : 0,
    averageMovementEncodeMs: updateCount > 0
      ? counterDelta(samples, "movementEncodeMs") / updateCount
      : 0,
    averageAudienceMapMs: audienceMapCount > 0
      ? counterDelta(samples, "audienceMapMs") / audienceMapCount
      : 0,
    averageNumericPeekMs: numericPeekCount > 0
      ? counterDelta(samples, "numericPeekMs") / numericPeekCount
      : 0,
    averageStatePeekMs: statePeekCount > 0
      ? counterDelta(samples, "statePeekMs") / statePeekCount
      : 0,
    playerEntryQueue: lifecycleLast?.playerEntryQueue ?? 0,
    playerEntryQueuePeak: lifecycleLast?.playerEntryQueuePeak ?? 0,
    playerEntriesAdmitted: lifecycleLast?.playerEntriesAdmitted ?? 0,
    playerEntryFailures: lifecycleLast?.playerEntryFailures ?? 0,
    averagePlayerEntryQueueWaitMs: divide(
      lifecycleLast?.playerEntryQueueWaitMs,
      lifecycleLast?.playerEntriesAdmitted,
    ),
    maxPlayerEntryQueueWaitMs: lifecycleLast?.playerEntryQueueWaitMaxMs ?? 0,
    averagePlayerEntryAttachMs: divide(
      lifecycleLast?.playerEntryAttachMs,
      lifecycleLast?.playerEntriesAdmitted,
    ),
    maxPlayerEntryAttachMs: lifecycleLast?.playerEntryAttachMaxMs ?? 0,
    playerEntryVisibilityChanges: lifecycleLast?.playerEntryVisibilityChanges ?? 0,
    playerEntrySnapshotCalls: lifecycleLast?.playerEntrySnapshotCalls ?? 0,
    playerEntrySnapshotItems: lifecycleLast?.playerEntrySnapshotItems ?? 0,
    averagePlayerEntrySnapshotItems: divide(
      lifecycleLast?.playerEntrySnapshotItems,
      lifecycleLast?.playerEntrySnapshotCalls,
    ),
    averagePlayerEntrySnapshotMs: divide(
      lifecycleLast?.playerEntrySnapshotMs,
      lifecycleLast?.playerEntrySnapshotCalls,
    ),
    maxPlayerEntrySnapshotMs: lifecycleLast?.playerEntrySnapshotMaxMs ?? 0,
    playerEntrySnapshotBuilds: lifecycleLast?.playerEntrySnapshotBuilds ?? 0,
    playerEntrySnapshotMaterializedItems:
      lifecycleLast?.playerEntrySnapshotMaterializedItems ?? 0,
    playerEntrySnapshotAudienceReuseHits:
      lifecycleLast?.playerEntrySnapshotAudienceReuseHits ?? 0,
    playerEntrySnapshotUnitReuseHits: lifecycleLast?.playerEntrySnapshotUnitReuseHits ?? 0,
    aoiDeltaBatches: lifecycleLast?.aoiDeltaBatches ?? 0,
    aoiDeltaEnterItems: lifecycleLast?.aoiDeltaEnterItems ?? 0,
    aoiDeltaLeaveItems: lifecycleLast?.aoiDeltaLeaveItems ?? 0,
    aoiDeltaRecipients: lifecycleLast?.aoiDeltaRecipients ?? 0,
    aoiDeltaDeliveries: lifecycleLast?.aoiDeltaDeliveries ?? 0,
    aoiDeltaPrepareMs: lifecycleLast?.aoiDeltaPrepareMs ?? 0,
    aoiDeltaPublishMs: lifecycleLast?.aoiDeltaPublishMs ?? 0,
    failures: last?.broadcastFailures ?? 0,
  };
}

function summarizeActorLatestForward(samples) {
  return {
    pendingFramesPeak: max(samples.map((item) => item.pendingFrames ?? 0)),
    queuedPerSecond: counterRate(samples, "queued"),
    coalescedPerSecond: counterRate(samples, "coalesced"),
    forwardedPerSecond: counterRate(samples, "forwarded"),
    batchesPerSecond: counterRate(samples, "batches"),
    failedBatches: counterDelta(samples, "failedBatches"),
    failedFrames: counterDelta(samples, "failedFrames"),
    dropped: counterDelta(samples, "dropped"),
  };
}

function summarizeMapEntry(samples) {
  const last = samples.at(-1) ?? {};
  return {
    samples: samples.length,
    requests: last.requests ?? 0,
    completed: last.completed ?? 0,
    failures: last.failures ?? 0,
    inFlight: last.inFlight ?? 0,
    maxInFlight: last.maxInFlight ?? 0,
    averageDurationMs: divide(last.durationMs, last.completed + last.failures),
    maxDurationMs: last.maxDurationMs ?? 0,
    averageIdAllocationMs: divide(last.idAllocationMs, last.idAllocations),
    maxIdAllocationMs: last.maxIdAllocationMs ?? 0,
    averagePlayerCreateMs: divide(last.playerCreateMs, last.playerCreates),
    maxPlayerCreateMs: last.maxPlayerCreateMs ?? 0,
    averageLocationRegisterMs: divide(last.locationRegisterMs, last.locationRegisters),
    maxLocationRegisterMs: last.maxLocationRegisterMs ?? 0,
    averageMapReadySendMs: divide(last.mapReadySendMs, last.mapReadySends),
    maxMapReadySendMs: last.maxMapReadySendMs ?? 0,
    averageLocationResolveMs: divide(last.locationResolveMs, last.locationResolves),
    maxLocationResolveMs: last.maxLocationResolveMs ?? 0,
  };
}

function divide(numerator = 0, denominator = 0) {
  return denominator > 0 ? numerator / denominator : 0;
}

function collectTransportMetrics(runtimes, resources) {
  const text = runtimes.map(readRuntimeLogs).join("\n");
  const hasFormalHealth = resources.processes.some((item) => item.samples >= 2);
  const metric = (field, pattern) => hasFormalHealth
    ? sum(resources.processes.map((item) => item[field]))
    : maxMatches(text, pattern);
  return {
    innerOverloads: metric("innerOverloads", /overloads=(\d+)/g),
    innerTimeouts: metric("innerTimeouts", /timeouts=(\d+)/g),
    backpressure: metric("backpressure", /backpressure=(\d+)/g),
    slowDisconnects: metric("slowDisconnects", /slow_disconnects=(\d+)/g),
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
      setupElapsedSeconds: median(group.map((item) => item.setup?.elapsedSeconds ?? 0)),
      connectionSeconds: median(group.map((item) => item.setup?.connectionSeconds ?? 0)),
      mapEntrySeconds: median(group.map((item) => item.setup?.mapEntrySeconds ?? 0)),
      mapEntryPerSecond: median(group.map((item) => item.setup?.mapEntryPerSecond ?? 0)),
      mapCpuAverage: median(group.map((item) => item.serverResources.map?.averageCpuPercent ?? 0)),
      mapCpuP90: median(group.map((item) => item.serverResources.map?.p90CpuPercent ?? 0)),
      mapCpuPeak: median(group.map((item) => item.serverResources.map?.peakCpuPercent ?? 0)),
      mapFixedUpdateMs: median(group.map(
        (item) => item.serverResources.map?.gameFixedUpdateMs ?? 0,
      )),
      mapFramesPerSecond: median(group.map(
        (item) => item.serverResources.map?.gameFramesPerSecond ?? 0,
      )),
      mapSkippedFixedUpdates: max(group.map(
        (item) => item.serverResources.map?.gameSkippedFixedUpdates ?? 0,
      )),
      mapUpdatesPerSecond: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.updatesPerSecond ?? 0,
      )),
      mapUpdateTargetPercent: median(group.map((item) => {
        const fixedUpdateMs = item.serverResources.map?.gameFixedUpdateMs ?? 0;
        const targetUpdatesPerSecond = fixedUpdateMs > 0 ? 1000 / fixedUpdateMs : 0;
        const updatesPerSecond = item.serverResources.map?.mapBroadcast?.updatesPerSecond ?? 0;
        return targetUpdatesPerSecond > 0 ? updatesPerSecond / targetUpdatesPerSecond * 100 : 0;
      })),
      mapUpdateTargetPercentMin: Math.min(...group.map((item) => {
        const fixedUpdateMs = item.serverResources.map?.gameFixedUpdateMs ?? 0;
        const targetUpdatesPerSecond = fixedUpdateMs > 0 ? 1000 / fixedUpdateMs : 0;
        const updatesPerSecond = item.serverResources.map?.mapBroadcast?.updatesPerSecond ?? 0;
        return targetUpdatesPerSecond > 0 ? updatesPerSecond / targetUpdatesPerSecond * 100 : 0;
      })),
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
      mapBroadcastSupersededPublishesPerSecond: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.supersededPublishesPerSecond ?? 0,
      )),
      mapBroadcastLatestCapacityRejections: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.latestCapacityRejections ?? 0,
      )),
      mapBroadcastSentFramesPerSecond: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.sentFramesPerSecond ?? 0,
      )),
      mapBroadcastsPerSecond: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.broadcastsPerSecond ?? 0,
      )),
      mapMovementAdvanceAverageMs: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.averageMovementAdvanceMs ?? 0,
      )),
      mapAoiRefreshAverageMs: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.averageAoiRefreshMs ?? 0,
      )),
      mapMovementEncodeAverageMs: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.averageMovementEncodeMs ?? 0,
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
      playerEntryQueue: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.playerEntryQueue ?? 0,
      )),
      playerEntryQueuePeak: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.playerEntryQueuePeak ?? 0,
      )),
      playerEntriesAdmitted: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.playerEntriesAdmitted ?? 0,
      )),
      playerEntryFailures: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.playerEntryFailures ?? 0,
      )),
      playerEntryQueueWaitAverageMs: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.averagePlayerEntryQueueWaitMs ?? 0,
      )),
      playerEntryQueueWaitMaxMs: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.maxPlayerEntryQueueWaitMs ?? 0,
      )),
      playerEntryAttachAverageMs: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.averagePlayerEntryAttachMs ?? 0,
      )),
      playerEntryAttachMaxMs: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.maxPlayerEntryAttachMs ?? 0,
      )),
      playerEntryVisibilityChanges: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.playerEntryVisibilityChanges ?? 0,
      )),
      playerEntrySnapshotCalls: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.playerEntrySnapshotCalls ?? 0,
      )),
      playerEntrySnapshotItems: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.playerEntrySnapshotItems ?? 0,
      )),
      playerEntrySnapshotAverageItems: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.averagePlayerEntrySnapshotItems ?? 0,
      )),
      playerEntrySnapshotAverageMs: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.averagePlayerEntrySnapshotMs ?? 0,
      )),
      playerEntrySnapshotMaxMs: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.maxPlayerEntrySnapshotMs ?? 0,
      )),
      playerEntrySnapshotBuilds: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.playerEntrySnapshotBuilds ?? 0,
      )),
      playerEntrySnapshotMaterializedItems: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.playerEntrySnapshotMaterializedItems ?? 0,
      )),
      playerEntrySnapshotAudienceReuseHits: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.playerEntrySnapshotAudienceReuseHits ?? 0,
      )),
      playerEntrySnapshotUnitReuseHits: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.playerEntrySnapshotUnitReuseHits ?? 0,
      )),
      aoiDeltaBatches: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.aoiDeltaBatches ?? 0,
      )),
      aoiDeltaEnterItems: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.aoiDeltaEnterItems ?? 0,
      )),
      aoiDeltaLeaveItems: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.aoiDeltaLeaveItems ?? 0,
      )),
      aoiDeltaRecipients: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.aoiDeltaRecipients ?? 0,
      )),
      aoiDeltaDeliveries: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.aoiDeltaDeliveries ?? 0,
      )),
      aoiDeltaPrepareMs: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.aoiDeltaPrepareMs ?? 0,
      )),
      aoiDeltaPublishMs: median(group.map(
        (item) => item.serverResources.map?.mapBroadcast?.aoiDeltaPublishMs ?? 0,
      )),
      mapEntryRequests: median(group.map(
        (item) => item.serverResources.map?.mapEntry?.requests ?? 0,
      )),
      mapEntryFailures: median(group.map(
        (item) => item.serverResources.map?.mapEntry?.failures ?? 0,
      )),
      mapEntryMaxInFlight: median(group.map(
        (item) => item.serverResources.map?.mapEntry?.maxInFlight ?? 0,
      )),
      mapEntryAverageDurationMs: median(group.map(
        (item) => item.serverResources.map?.mapEntry?.averageDurationMs ?? 0,
      )),
      mapEntryMaxDurationMs: median(group.map(
        (item) => item.serverResources.map?.mapEntry?.maxDurationMs ?? 0,
      )),
      mapEntryIdAllocationAverageMs: median(group.map(
        (item) => item.serverResources.map?.mapEntry?.averageIdAllocationMs ?? 0,
      )),
      mapEntryIdAllocationMaxMs: median(group.map(
        (item) => item.serverResources.map?.mapEntry?.maxIdAllocationMs ?? 0,
      )),
      mapEntryPlayerCreateAverageMs: median(group.map(
        (item) => item.serverResources.map?.mapEntry?.averagePlayerCreateMs ?? 0,
      )),
      mapEntryPlayerCreateMaxMs: median(group.map(
        (item) => item.serverResources.map?.mapEntry?.maxPlayerCreateMs ?? 0,
      )),
      mapEntryLocationRegisterAverageMs: median(group.map(
        (item) => item.serverResources.map?.mapEntry?.averageLocationRegisterMs ?? 0,
      )),
      mapEntryLocationRegisterMaxMs: median(group.map(
        (item) => item.serverResources.map?.mapEntry?.maxLocationRegisterMs ?? 0,
      )),
      mapEntryMapReadyAverageMs: median(group.map(
        (item) => item.serverResources.map?.mapEntry?.averageMapReadySendMs ?? 0,
      )),
      mapEntryMapReadyMaxMs: median(group.map(
        (item) => item.serverResources.map?.mapEntry?.maxMapReadySendMs ?? 0,
      )),
      mapEntryLocationResolveAverageMs: median(group.map(
        (item) => item.serverResources.map?.mapEntry?.averageLocationResolveMs ?? 0,
      )),
      mapEntryLocationResolveMaxMs: median(group.map(
        (item) => item.serverResources.map?.mapEntry?.maxLocationResolveMs ?? 0,
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
      nativeLiveItems: median(group.map(
        (item) => item.serverResources.map?.nativeData?.liveItems ?? 0,
      )),
      nativePoolCapacityBytes: median(group.map(
        (item) => item.serverResources.map?.nativeData?.poolCapacityBytes ?? 0,
      )),
      nativeScratchCapacityBytes: median(group.map(
        (item) => item.serverResources.map?.nativeData?.scratchCapacityBytes ?? 0,
      )),
      nativeScratchGrowths: median(group.map(
        (item) => item.serverResources.map?.nativeData?.scratchGrowths ?? 0,
      )),
      nativeScratchGrowthsPerSecond: median(group.map(
        (item) => item.serverResources.map?.nativeData?.scratchGrowthsPerSecond ?? 0,
      )),
      nativeRefs: median(group.map(
        (item) => item.serverResources.map?.nativeData?.nativeRefs ?? 0,
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
      numericReplication: aggregateNumericReplication(group),
      aoiWorlds: median(group.map(
        (item) => item.serverResources.map?.nativeData?.aoiWorlds ?? 0,
      )),
      aoiEntries: median(group.map(
        (item) => item.serverResources.map?.nativeData?.aoiEntries ?? 0,
      )),
      aoiGrids: median(group.map(
        (item) => item.serverResources.map?.nativeData?.aoiGrids ?? 0,
      )),
      aoiCandidateRelations: median(group.map(
        (item) => item.serverResources.map?.nativeData?.aoiCandidateRelations ?? 0,
      )),
      aoiVisibleRelations: median(group.map(
        (item) => item.serverResources.map?.nativeData?.aoiVisibleRelations ?? 0,
      )),
      aoiLingeringRelations: median(group.map(
        (item) => item.serverResources.map?.nativeData?.aoiLingeringRelations ?? 0,
      )),
      aoiRejectedRelations: median(group.map(
        (item) => item.serverResources.map?.nativeData?.aoiRejectedRelations ?? 0,
      )),
      aoiRelocationsPerSecond: median(group.map(
        (item) => item.serverResources.map?.nativeData?.aoiRelocationsPerSecond ?? 0,
      )),
      aoiRelocationTargetPercent: options.probeOnly ||
        options.spawnLayout !== "grid-uniform" || options.moveRate === 0
        ? 100
        : median(group.map((item) =>
          (item.serverResources.map?.nativeData?.aoiRelocationsPerSecond ?? 0) /
          (item.players * 0.1) * 100
        )),
      aoiVisibilityChangesPerSecond: median(group.map(
        (item) => item.serverResources.map?.nativeData?.aoiVisibilityChangesPerSecond ?? 0,
      )),
      aoiFilterOverridesPerSecond: median(group.map(
        (item) => item.serverResources.map?.nativeData?.aoiFilterOverridesPerSecond ?? 0,
      )),
      mapPeakV8HeapUsedBytes: median(group.map(
        (item) => item.serverResources.map?.peakV8HeapUsedBytes ?? 0,
      )),
      mapLifecycleTransportWriteBytes: median(group.map(
        (item) => item.serverResources.map?.lifecycleTransportWriteBytes ?? 0,
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
      gateLifecycleOutboundBridgeBytes: median(group.map(
        (item) => item.serverResources.gateLifecycleOutboundBridgeBytes,
      )),
      gateLifecycleOutboundLogicalBytes: median(group.map(
        (item) => item.serverResources.gateLifecycleOutboundLogicalBytes,
      )),
      gateLifecycleTransportWriteBytes: median(group.map(
        (item) => item.serverResources.gateLifecycleTransportWriteBytes,
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
      gateActorLatestQueuedPerSecond: median(group.map(
        (item) => item.serverResources.gateActorLatestQueuedPerSecond,
      )),
      gateActorLatestCoalescedPerSecond: median(group.map(
        (item) => item.serverResources.gateActorLatestCoalescedPerSecond,
      )),
      gateActorLatestForwardedPerSecond: median(group.map(
        (item) => item.serverResources.gateActorLatestForwardedPerSecond,
      )),
      gateActorLatestBatchesPerSecond: median(group.map(
        (item) => item.serverResources.gateActorLatestBatchesPerSecond,
      )),
      gateActorLatestPendingFramesPeak: median(group.map(
        (item) => item.serverResources.gateActorLatestPendingFramesPeak,
      )),
      gateActorLatestFailedBatches: median(group.map(
        (item) => item.serverResources.gateActorLatestFailedBatches,
      )),
      gateActorLatestFailedFrames: median(group.map(
        (item) => item.serverResources.gateActorLatestFailedFrames,
      )),
      gateActorLatestDropped: median(group.map(
        (item) => item.serverResources.gateActorLatestDropped,
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
      stateSyncPerSecond: median(group.map((item) => item.stateSync?.perSecond ?? 0)),
      stateSyncTargetPercent: options.stateSyncMode === "off" || options.stateSyncRate === 0
        ? 100
        : median(group.map(
          (item) => (item.stateSync?.perSecond ?? 0) /
            (item.players * options.stateSyncRate) * 100,
        )),
      stateSyncP50Ms: median(group.map((item) => item.stateSync?.p50Ms ?? 0)),
      stateSyncP90Ms: median(group.map((item) => item.stateSync?.p90Ms ?? 0)),
      stateSyncP95Ms: median(group.map((item) => item.stateSync?.p95Ms ?? 0)),
      stateSyncP99Ms: median(group.map((item) => item.stateSync?.p99Ms ?? 0)),
      stateSyncMaxMs: median(group.map((item) => item.stateSync?.maxMs ?? 0)),
      stateSyncErrors: median(group.map((item) => item.stateSync?.errors ?? 0)),
      businessPerSecond: median(group.map((item) => item.business?.perSecond ?? 0)),
      businessTargetPercent: options.businessRate === 0
        ? 100
        : median(group.map((item) =>
          (item.business?.perSecond ?? 0) / (item.players * options.businessRate) * 100,
        )),
      businessAccepted: median(group.map((item) => item.business?.accepted ?? 0)),
      businessRejected: median(group.map((item) => item.business?.rejected ?? 0)),
      businessTransportErrors: median(group.map(
        (item) => item.business?.transportErrors ?? 0,
      )),
      businessP50Ms: median(group.map((item) => item.business?.p50Ms ?? 0)),
      businessP90Ms: median(group.map((item) => item.business?.p90Ms ?? 0)),
      businessP95Ms: median(group.map((item) => item.business?.p95Ms ?? 0)),
      businessP99Ms: median(group.map((item) => item.business?.p99Ms ?? 0)),
      businessMaxMs: median(group.map((item) => item.business?.maxMs ?? 0)),
      numericPushesPerSecond: median(group.map(
        (item) => item.stateSync?.numericPushesPerSecond ?? 0,
      )),
      numericItemsPerSecond: median(group.map(
        (item) => item.stateSync?.numericItemsPerSecond ?? 0,
      )),
      numericBytesPerSecond: median(group.map(
        (item) => item.stateSync?.numericBytesPerSecond ?? 0,
      )),
      playerInfoPushesPerSecond: median(group.map(
        (item) => item.stateSync?.playerInfoPushesPerSecond ?? 0,
      )),
      playerInfoItemsPerSecond: median(group.map(
        (item) => item.stateSync?.playerInfoItemsPerSecond ?? 0,
      )),
      playerInfoBytesPerSecond: median(group.map(
        (item) => item.stateSync?.playerInfoBytesPerSecond ?? 0,
      )),
      itemPushesPerSecond: median(group.map(
        (item) => item.stateSync?.itemPushesPerSecond ?? 0,
      )),
      itemItemsPerSecond: median(group.map(
        (item) => item.stateSync?.itemItemsPerSecond ?? 0,
      )),
      itemBytesPerSecond: median(group.map(
        (item) => item.stateSync?.itemBytesPerSecond ?? 0,
      )),
      innerOverloads: median(group.map((item) => item.transport.innerOverloads)),
      innerTimeouts: median(group.map((item) => item.transport.innerTimeouts)),
      backpressure: median(group.map((item) => item.transport.backpressure)),
      slowDisconnects: median(group.map((item) => item.transport.slowDisconnects)),
      mapFrameBackpressure: median(group.map(
        (item) => processQueueStage(item, "map1", "frame", "backpressureWaits"),
      )),
      mapFrameBackpressureWaitMs: median(group.map(
        (item) => processQueueStage(item, "map1", "frame", "waitMs"),
      )),
      mapFrameBackpressureMaxWaitMs: median(group.map(
        (item) => processQueueStage(item, "map1", "frame", "maxWaitMs"),
      )),
      mapFrameQueueMaxDepth: median(group.map(
        (item) => processQueueStage(item, "map1", "frame", "maxDepth"),
      )),
      mapCompletionBackpressure: median(group.map(
        (item) => processQueueStage(item, "map1", "completion", "backpressureWaits"),
      )),
      mapControlIngressBackpressure: median(group.map(
        (item) => processQueueStage(item, "map1", "control_ingress", "backpressureWaits"),
      )),
      mapControlIngressMaxDepth: median(group.map(
        (item) => processQueueStage(item, "map1", "control_ingress", "maxDepth"),
      )),
      mapDataIngressBackpressure: median(group.map(
        (item) => processQueueStage(item, "map1", "data_ingress", "backpressureWaits"),
      )),
      mapDataIngressMaxDepth: median(group.map(
        (item) => processQueueStage(item, "map1", "data_ingress", "maxDepth"),
      )),
      gateManagerQueueOverloads: median(group.map(
        (item) => gateTransportOverloadStage(item, "manager_queue"),
      )),
      gateConnectionQueueOverloads: median(group.map(
        (item) => gateTransportOverloadStage(item, "connection_queue"),
      )),
      gateCallWriterQueueOverloads: median(group.map(
        (item) => gateTransportOverloadStage(item, "call_writer_queue"),
      )),
      gateSendWriterQueueOverloads: median(group.map(
        (item) => gateTransportOverloadStage(item, "send_writer_queue"),
      )),
      gateTargetIngressQueueOverloads: median(group.map(
        (item) => gateTransportOverloadStage(item, "target_ingress_queue"),
      )),
      serverRssBytes: median(group.map((item) => item.serverResources.totalPeakRssBytes)),
    },
  }));
}

function aggregateNumericReplication(rounds) {
  const numericTypes = [...new Set(rounds.flatMap((round) =>
    Object.keys(round.serverResources.map?.nativeData?.numericReplication ?? {})
  ))].sort((left, right) => Number(left) - Number(right));
  return Object.fromEntries(numericTypes.map((numericType) => [numericType, {
    changesPerSecond: median(rounds.map(
      (round) => round.serverResources.map?.nativeData?.numericReplication?.[numericType]?.changesPerSecond ?? 0,
    )),
    encodedRecordsPerSecond: median(rounds.map(
      (round) => round.serverResources.map?.nativeData?.numericReplication?.[numericType]?.encodedRecordsPerSecond ?? 0,
    )),
    recipientDeliveriesPerSecond: median(rounds.map(
      (round) => round.serverResources.map?.nativeData?.numericReplication?.[numericType]?.recipientDeliveriesPerSecond ?? 0,
    )),
    logicalBytesPerSecond: median(rounds.map(
      (round) => round.serverResources.map?.nativeData?.numericReplication?.[numericType]?.logicalBytesPerSecond ?? 0,
    )),
  }]));
}

function renderMarkdown(report) {
  const ioBackend = effectiveIoBackendName(options.ioBackend);
  const lines = [
    options.spawnLayout === "grid-uniform"
      ? "# 单 MapHost 全图均匀 AOI 容量测试报告"
      : "# 单 MapHost 同屏容量测试报告",
    "",
    `- 时间：${report.generatedAt}`,
    `- 拓扑：1 MapHost / ${options.gates} Gate / 1 Login / 1 LoginMgr / 1 Location`,
    `- I/O Backend：${ioBackend}`,
    `- 地图：${options.worldGrids}x${options.worldGrids} AOI Grid（MapConfig ${options.mapId}）`,
    "- Unit 数据：Rust 权威存储，Rust 批处理并直接编码移动快照",
    `- 玩家布局：${options.spawnLayout === "grid-uniform"
      ? `轮询全部AOI Grid并从Grid中央Cell开始（各档平均${options.players.map((players) => formatDensity(players, options.worldGrids)).join("/")}人/Grid）`
      : options.spawnLayout === "single-grid"
         ? "固定单个AOI Grid内的安全轨迹（不跨Grid）"
         : "统一出生点（最坏同屏）"}`,
    `- 进图同步模式：${options.entrySyncMode}${options.entrySyncMode === "full" ? "（正式完整语义）" : "（仅Bench诊断，不代表可上线语义）"}`,
    `- 负载：${options.probeOnly ? "Probe Only，" : `每玩家 ${options.moveRate}Hz Move + `}每玩家 ${options.probeRate}Hz MapProbe` +
      (options.businessRate > 0 ? ` + ${options.businessRate}Hz真实道具/技能` : ""),
    ...(options.stateSyncMode !== "off"
      ? [`- 状态同步：${options.stateSyncMode}，每玩家 ${options.stateSyncRate}Hz，in-flight ${options.stateSyncConcurrency}`]
      : []),
    ...(!options.probeOnly && options.movementHoldMessages > 1
      ? [`- 移动输入：每 ${options.movementHoldMessages} 次上报保持同一方向`]
      : []),
    ...(!options.probeOnly && options.spawnLayout === "grid-uniform"
      ? [`- 移动画像：80%玩家在Grid内闭环；20%玩家每2秒跨越一次相邻Grid，预期跨Grid约${options.players.map((players) => round(players * 0.1, 1)).join("/")}次/s`]
      : []),
    `- Probe in-flight：每连接 ${options.probeConcurrency}`,
    ...(options.latencySampleRate > 0
      ? [`- 链路耗时采样：每 ${options.latencySampleRate} 个候选指标记录 1 个（诊断模式）`]
      : []),
    `- 压测客户端：${options.client === "rust" ? "Rust" : "Node.js"}`,
    ...(options.mapEntryConcurrency !== null
      ? [`- 两阶段进图：连接/Login并发${options.setupConcurrency}；全部就绪后Map Enter并发${options.mapEntryConcurrency}` +
        (options.mapEntryRate !== null ? `；开环释放${options.mapEntryRate}人/秒` : "")]
      : []),
    `- 正式测试：${options.duration}s；预热：${options.warmup}s；轮数：${options.rounds}`,
    ...(options.postSetupSettle > 0
      ? [`- Setup后空闲排空：${options.postSetupSettle}s（不发送Move/Probe）`]
      : []),
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
    "## Map Tick健康度",
    "",
    "| 玩家 | 配置Tick | Runtime frame/s | Map update/s（中位/最差达标率） | 跳过固定帧max | Movement/AOI/Encode 每次Update |",
    "|---:|---:|---:|---:|---:|---:|",
  );
  for (const item of report.cases) {
    const value = item.median;
    const configuredHz = value.mapFixedUpdateMs > 0 ? 1000 / value.mapFixedUpdateMs : 0;
    lines.push(
      `| ${item.players} | ${round(configuredHz, 1)}Hz (${round(value.mapFixedUpdateMs, 1)}ms) | ` +
      `${round(value.mapFramesPerSecond, 1)} | ${round(value.mapUpdatesPerSecond, 1)}（${round(value.mapUpdateTargetPercent, 1)}%/` +
      `${round(value.mapUpdateTargetPercentMin, 1)}%） | ` +
      `${round(value.mapSkippedFixedUpdates)} | ${round(value.mapMovementAdvanceAverageMs, 2)}/` +
      `${round(value.mapAoiRefreshAverageMs, 2)}/${round(value.mapMovementEncodeAverageMs, 2)}ms |`,
    );
  }
  if (options.stateSyncMode !== "off") {
    lines.push(
      "",
      "## 状态同步全链路",
      "",
      "| 玩家 | 模式 | RPC/s | 达标率 | RPC p50/p90/p95/p99/max | Numeric frames/items/MiB/s | PlayerInfo frames/items/MiB/s | Item frames/items/MiB/s | errors |",
      "|---:|---|---:|---:|---:|---:|---:|---:|---:|",
    );
    for (const item of report.cases) {
      const value = item.median;
      lines.push(
        `| ${item.players} | ${options.stateSyncMode} | ${round(value.stateSyncPerSecond)} | ` +
        `${round(value.stateSyncTargetPercent, 1)}% | ` +
        `${round(value.stateSyncP50Ms, 2)}/${round(value.stateSyncP90Ms, 2)}/${round(value.stateSyncP95Ms, 2)}/${round(value.stateSyncP99Ms, 2)}/${round(value.stateSyncMaxMs, 2)}ms | ` +
        `${round(value.numericPushesPerSecond)}/${round(value.numericItemsPerSecond)}/${round(value.numericBytesPerSecond / 1024 / 1024, 2)} | ` +
        `${round(value.playerInfoPushesPerSecond)}/${round(value.playerInfoItemsPerSecond)}/${round(value.playerInfoBytesPerSecond / 1024 / 1024, 2)} | ` +
        `${round(value.itemPushesPerSecond)}/${round(value.itemItemsPerSecond)}/${round(value.itemBytesPerSecond / 1024 / 1024, 2)} | ${value.stateSyncErrors} |`,
      );
    }
  }
  if (options.businessRate > 0) {
    lines.push(
      "",
      "## 真实业务闭环",
      "",
      "| 玩家 | business/s | 达标率 | 成功 | 业务拒绝 | 传输错误 | p50/p90/p95/p99/max |",
      "|---:|---:|---:|---:|---:|---:|---:|",
    );
    for (const item of report.cases) {
      const value = item.median;
      lines.push(
        `| ${item.players} | ${round(value.businessPerSecond)} | ${round(value.businessTargetPercent, 1)}% | ` +
        `${value.businessAccepted} | ${value.businessRejected} | ${value.businessTransportErrors} | ` +
        `${round(value.businessP50Ms, 2)}/${round(value.businessP90Ms, 2)}/${round(value.businessP95Ms, 2)}/` +
        `${round(value.businessP99Ms, 2)}/${round(value.businessMaxMs, 2)}ms |`,
      );
    }
  }
  if (options.mapEntryConcurrency !== null) {
    lines.push(
      "",
      "## 客户端两阶段Setup",
      "",
      "| 玩家 | 总耗时 | 连接/Login耗时 | Map Enter耗时 | Map Enter/s |",
      "|---:|---:|---:|---:|---:|",
    );
    for (const item of report.cases) {
      const value = item.median;
      lines.push(
        `| ${item.players} | ${round(value.setupElapsedSeconds, 2)}s | ` +
        `${round(value.connectionSeconds, 2)}s | ${round(value.mapEntrySeconds, 2)}s | ` +
        `${round(value.mapEntryPerSecond, 2)} |`,
      );
    }
  }
  lines.push(
    "",
    "## 背压责任分解",
    "",
    "| 玩家 | Map Frame 正式窗口 waits/total ms | 生命周期 max wait/depth | control waits/depth | data waits/depth | Map Completion waits | Gate manager/connection/call-writer/send-writer/target-ingress overload |",
    "|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const item of report.cases) {
    const value = item.median;
    lines.push(
      `| ${item.players} | ${value.mapFrameBackpressure}/${round(value.mapFrameBackpressureWaitMs, 2)} | ` +
      `${round(value.mapFrameBackpressureMaxWaitMs, 2)}/${value.mapFrameQueueMaxDepth} | ` +
      `${value.mapControlIngressBackpressure}/${value.mapControlIngressMaxDepth} | ` +
      `${value.mapDataIngressBackpressure}/${value.mapDataIngressMaxDepth} | ` +
      `${value.mapCompletionBackpressure} | ${value.gateManagerQueueOverloads}/${value.gateConnectionQueueOverloads}/${value.gateCallWriterQueueOverloads}/${value.gateSendWriterQueueOverloads}/${value.gateTargetIngressQueueOverloads} |`,
    );
  }
  lines.push(
    "",
    "## AOI 空间指标",
    "",
    "| 玩家 | World/Entity/Grid | candidate/visible | 迟滞关系 | 拒绝关系 | 跨Grid/s（达标率） | 可见变化/s | 过滤覆盖/s |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const item of report.cases) {
    const value = item.median;
    lines.push(
      `| ${item.players} | ${round(value.aoiWorlds)}/${round(value.aoiEntries)}/${round(value.aoiGrids)} | ` +
      `${round(value.aoiCandidateRelations)}/${round(value.aoiVisibleRelations)} | ` +
      `${round(value.aoiLingeringRelations)} | ${round(value.aoiRejectedRelations)} | ` +
      `${round(value.aoiRelocationsPerSecond, 1)}（${round(value.aoiRelocationTargetPercent, 1)}%） | ${round(value.aoiVisibilityChangesPerSecond, 1)} | ` +
      `${round(value.aoiFilterOverridesPerSecond, 1)} |`,
    );
  }
  lines.push(
    "",
    "## MapHost进图阶段",
    "",
    "| 玩家 | 请求/失败/max in-flight | 全链路 avg/max | ID分配 avg/max | 创建Player avg/max | Location注册 avg/max | MapReady avg/max | Location确认 avg/max |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const item of report.cases) {
    const value = item.median;
    lines.push(
      `| ${item.players} | ${round(value.mapEntryRequests)}/${round(value.mapEntryFailures)}/${round(value.mapEntryMaxInFlight)} | ` +
      `${round(value.mapEntryAverageDurationMs, 2)}/${round(value.mapEntryMaxDurationMs, 2)}ms | ` +
      `${round(value.mapEntryIdAllocationAverageMs, 2)}/${round(value.mapEntryIdAllocationMaxMs, 2)}ms | ` +
      `${round(value.mapEntryPlayerCreateAverageMs, 2)}/${round(value.mapEntryPlayerCreateMaxMs, 2)}ms | ` +
      `${round(value.mapEntryLocationRegisterAverageMs, 2)}/${round(value.mapEntryLocationRegisterMaxMs, 2)}ms | ` +
      `${round(value.mapEntryMapReadyAverageMs, 2)}/${round(value.mapEntryMapReadyMaxMs, 2)}ms | ` +
      `${round(value.mapEntryLocationResolveAverageMs, 2)}/${round(value.mapEntryLocationResolveMaxMs, 2)}ms |`,
    );
  }
  lines.push(
    "",
    "## Admission与新玩家快照",
    "",
    "| 玩家 | 结束队列/峰值 | 放行/失败 | 排队 avg/max | Attach avg/max | 可见变化 | Snapshot calls/items(avg) | Snapshot avg/max |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const item of report.cases) {
    const value = item.median;
    lines.push(
      `| ${item.players} | ${round(value.playerEntryQueue)}/${round(value.playerEntryQueuePeak)} | ` +
      `${round(value.playerEntriesAdmitted)}/${round(value.playerEntryFailures)} | ` +
      `${round(value.playerEntryQueueWaitAverageMs, 2)}/${round(value.playerEntryQueueWaitMaxMs, 2)}ms | ` +
      `${round(value.playerEntryAttachAverageMs, 3)}/${round(value.playerEntryAttachMaxMs, 3)}ms | ` +
      `${round(value.playerEntryVisibilityChanges)} | ${round(value.playerEntrySnapshotCalls)}/${round(value.playerEntrySnapshotItems)}(${round(value.playerEntrySnapshotAverageItems, 1)}) | ` +
      `${round(value.playerEntrySnapshotAverageMs, 3)}/${round(value.playerEntrySnapshotMaxMs, 3)}ms |`,
    );
  }
  lines.push(
    "",
    "## AOI Enter/Leave下行",
    "",
    "| 玩家 | batch | enter/leave items | recipients | entity deliveries | prepare ms | publish wait ms |",
    "|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const item of report.cases) {
    const value = item.median;
    lines.push(
      `| ${item.players} | ${round(value.aoiDeltaBatches)} | ` +
      `${round(value.aoiDeltaEnterItems)}/${round(value.aoiDeltaLeaveItems)} | ` +
      `${round(value.aoiDeltaRecipients)} | ${round(value.aoiDeltaDeliveries)} | ` +
      `${round(value.aoiDeltaPrepareMs, 2)} | ${round(value.aoiDeltaPublishMs, 2)} |`,
    );
  }
  lines.push(
    "",
    "## NativeData 边界指标",
    "",
    "| 玩家 | 指标样本 | scalar gets/s | scalar sets/s | batch calls/s | encoded frames/items | encoded bytes/s | live E/U/I | Pool/Scratch | scratch grows/s (total) | TS refs | Map V8 Heap peak |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const item of report.cases) {
    const value = item.median;
    lines.push(
      `| ${item.players} | ${value.nativeDataSamples} | ` +
      `${round(value.nativeScalarGetsPerSecond, 1)} | ${round(value.nativeScalarSetsPerSecond, 1)} | ` +
      `${round(value.nativeBatchCallsPerSecond, 1)} | ` +
      `${round(value.nativeEncodedFramesPerSecond, 1)}/${round(value.nativeEncodedItemsPerSecond)} | ` +
      `${formatBytes(value.nativeEncodedBytesPerSecond)}/s | ` +
      `${round(value.nativeLiveEntities)}/${round(value.nativeLiveUnits)}/${round(value.nativeLiveItems)} | ` +
      `${formatBytes(value.nativePoolCapacityBytes)}/${formatBytes(value.nativeScratchCapacityBytes)} | ` +
      `${round(value.nativeScratchGrowthsPerSecond, 2)} (${round(value.nativeScratchGrowths)}) | ${round(value.nativeRefs)} | ` +
      `${formatBytes(value.mapPeakV8HeapUsedBytes)} |`,
    );
  }
  lines.push(
    "",
    "## NumericType复制指标",
    "",
    "| 玩家 | NumericType | changes/s | encoded records/s | recipient deliveries/s | logical bytes/s |",
    "|---:|---|---:|---:|---:|---:|",
  );
  for (const item of report.cases) {
    for (const [numericType, metrics] of Object.entries(item.median.numericReplication ?? {})) {
      lines.push(
        `| ${item.players} | ${numericTypeName(numericType)} (${numericType}) | ` +
        `${round(metrics.changesPerSecond, 1)} | ${round(metrics.encodedRecordsPerSecond, 1)} | ` +
        `${round(metrics.recipientDeliveriesPerSecond, 1)} | ${formatRate(metrics.logicalBytesPerSecond)} |`,
      );
    }
  }
  lines.push(
    "",
    "## Map 广播 single-flight",
    "",
    "| 玩家 | 指标样本 | pending 采样峰值/生命周期峰值 | queued/s | coalesced/s (%) | superseded/s | sent/s | batch/s | frames/batch | 广播 avg/max | 排队 avg/max | failures/capacity rejects |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const item of report.cases) {
    const value = item.median;
    lines.push(
      `| ${item.players} | ${value.mapBroadcastSamples} | ` +
      `${round(value.mapBroadcastPendingUnitsPeak)}/${round(value.mapBroadcastMaxPendingUnits)} | ` +
      `${round(value.mapBroadcastQueuedFramesPerSecond)} | ` +
      `${round(value.mapBroadcastCoalescedFramesPerSecond)} (${round(value.mapBroadcastCoalescedPercent, 1)}%) | ` +
      `${round(value.mapBroadcastSupersededPublishesPerSecond)} | ` +
      `${round(value.mapBroadcastSentFramesPerSecond)} | ${round(value.mapBroadcastsPerSecond, 1)} | ` +
      `${round(value.mapBroadcastFramesPerBroadcast, 1)} | ` +
      `${round(value.mapBroadcastAverageDurationMs, 2)}/${round(value.mapBroadcastMaxDurationMs, 2)}ms | ` +
      `${round(value.mapBroadcastAverageQueueWaitMs, 2)}/${round(value.mapBroadcastMaxQueueWaitMs, 2)}ms | ` +
      `${value.mapBroadcastFailures}/${value.mapBroadcastLatestCapacityRejections} |`,
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
  lines.push(
    "",
    "## Gate 到 Map latest Actor 输入",
    "",
    "| 玩家 | input/s | coalesced/s (%) | forwarded/s | batch/s | items/batch | pending peak | failed batch/frame | dropped |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const item of report.cases) {
    const value = item.median;
    const coalescedPercent = value.gateActorLatestQueuedPerSecond > 0
      ? value.gateActorLatestCoalescedPerSecond / value.gateActorLatestQueuedPerSecond * 100
      : 0;
    const itemsPerBatch = value.gateActorLatestBatchesPerSecond > 0
      ? value.gateActorLatestForwardedPerSecond / value.gateActorLatestBatchesPerSecond
      : 0;
    lines.push(
      `| ${item.players} | ${round(value.gateActorLatestQueuedPerSecond, 1)} | ` +
      `${round(value.gateActorLatestCoalescedPerSecond, 1)} (${round(coalescedPercent, 1)}%) | ` +
      `${round(value.gateActorLatestForwardedPerSecond, 1)} | ` +
      `${round(value.gateActorLatestBatchesPerSecond, 1)} | ${round(itemsPerBatch, 1)} | ` +
      `${round(value.gateActorLatestPendingFramesPeak)} | ` +
      `${round(value.gateActorLatestFailedBatches)}/${round(value.gateActorLatestFailedFrames)} | ` +
      `${round(value.gateActorLatestDropped)} |`,
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
    "- 容量候选要求Map业务Update达到配置固定Tick的95%以上，且正式窗口没有跳过固定帧。Map Update是同步回调；高入站负载会拉长固定帧之前的Scene mailbox与V8 microtask泵送，使Runtime frame/s和Map update/s一起下降。",
    options.probeOnly
      ? "- Probe Only 模式关闭 Move 和 AOI 广播，用于测 MapHost pingpong RPC 基线吞吐。"
      : "- Move 按固定频率开环发送，吞吐只统计正式窗口内实际写入的请求；容量点要求实际吞吐至少达到目标的 95%。",
    "- `backpressure`、overload、timeout 和 slow disconnect 都按正式测试窗口的 Counter 增量计算；Setup/入场期历史值不会污染稳态容量判断。",
    "- `forwarding=latest` 的 ActorLocation 单向输入在 Gate 以 connectionId + msgcode 覆盖等待窗口内的旧值，并按目标 Scene 形成内部批量帧；`input/s` 是客户端输入，`forwarded/s` 是进入目标 Actor mailbox 的最终条目，`batch/s` 是实际跨进程帧。",
    "- 背压责任分解使用固定 stage 标签：Map 的 `frame` 是网络入站业务帧，`control_ingress/data_ingress` 是物理保留队列，`completion` 是异步 Scene 操作完成；Gate 内部传输依次为 manager、目标连接、RPC writer、单向 send writer 与目标控制入口。waits/total 是正式窗口增量，max wait/max depth 是进程生命周期峰值。",
    options.probeOnly
      ? "- Probe Only 模式不包含 AOI 下行。"
      : "- 虚拟客户端不完整构造业务对象；状态测试会扫描 protobuf 顶层 repeated 字段，分别统计协议帧、状态项和消息体字节。端到端延迟由 MapProbe 独立测量。",
    options.spawnLayout === "single-grid"
      ? "- `push/s` 是虚拟客户端实际收到的移动帧数；单Grid布局使用Grid内闭合轨迹，正式窗口应没有持续跨Grid或可见关系变化。"
      : options.spawnLayout === "grid-uniform"
        ? "- `push/s` 是虚拟客户端实际收到的移动帧数；均匀基线固定20%玩家每2秒跨Grid一次，必须结合AOI空间指标中的实际跨Grid速率和Map update达标率判断负载是否成立。"
        : "- `push/s` 是虚拟客户端实际收到的移动帧数；玩家可能跨AOI Grid，实际Grid、候选关系、跨Grid和可见变化见AOI空间指标。",
    "- AOI进入/离开是不可覆盖事件，但同一逻辑帧内受众完全相同的变化会合并为一个`G2C_AoiDelta`；Movement、Numeric等可覆盖状态仍走latest。",
    "- Map 可覆盖状态广播采用 single-flight；前一批未完成时保留最新 dirty revision，发送成功后按 revision Ack。`pending`、合并率、广播耗时和排队时间用于判断下行是否跟不上 Game.Update。",
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
    players: csvNumbers(values.get("--players") ?? "3000"),
    gates: positive(values.get("--gates") ?? "16", "--gates"),
    // Demo 默认客户端方向保活频率是2Hz；按键变化立即发送，服务端Game.Update保持20Hz。
    moveRate: flags.has("--probe-only")
      ? 0
      : nonNegative(values.get("--move-rate") ?? "2", "--move-rate"),
    movementHoldMessages: positive(
      values.get("--movement-hold-messages") ?? "2",
      "--movement-hold-messages",
    ),
    spawnLayout: enumValue(
      values.get("--spawn-layout") ?? "grid-uniform",
      ["same-point", "single-grid", "grid-uniform"],
      "--spawn-layout",
    ),
    entrySyncMode: enumValue(
      values.get("--entry-sync-mode") ?? "full",
      ["full", "attach-only", "new-observer-only", "existing-observers-only"],
      "--entry-sync-mode",
    ),
    worldGrids: positive(values.get("--world-grids") ?? "10", "--world-grids"),
    probeRate: nonNegative(values.get("--probe-rate") ?? "0.2", "--probe-rate"),
    businessRate: nonNegative(values.get("--business-rate") ?? "0", "--business-rate"),
    probeConcurrency: positive(values.get("--probe-concurrency") ?? "1", "--probe-concurrency"),
    stateSyncMode: enumValue(
      values.get("--state-sync-mode") ?? "off",
      ["off", "numeric", "player", "item", "mixed"],
      "--state-sync-mode",
    ),
    stateSyncRate: nonNegative(values.get("--state-sync-rate") ?? "0", "--state-sync-rate"),
    stateSyncConcurrency: positive(
      values.get("--state-sync-concurrency") ?? "4",
      "--state-sync-concurrency",
    ),
    clientShards: positive(values.get("--client-shards") ?? "1", "--client-shards"),
    latencySampleRate: nonNegative(
      values.get("--latency-sample-rate") ?? "0",
      "--latency-sample-rate",
    ),
    duration: positive(values.get("--duration") ?? "30", "--duration"),
    warmup: nonNegative(values.get("--warmup") ?? "10", "--warmup"),
    rounds: positive(values.get("--rounds") ?? "1", "--rounds"),
    setupConcurrency: positive(values.get("--setup-concurrency") ?? "512", "--setup-concurrency"),
    mapEntryConcurrency: values.has("--map-entry-concurrency")
      ? positive(values.get("--map-entry-concurrency"), "--map-entry-concurrency")
      : null,
    mapEntryRate: values.has("--map-entry-rate")
      ? positive(values.get("--map-entry-rate"), "--map-entry-rate")
      : null,
    postSetupSettle: nonNegative(
      values.get("--post-setup-settle") ?? "0",
      "--post-setup-settle",
    ),
    timeoutMs: positive(values.get("--timeout") ?? "600000", "--timeout"),
    movementTimeoutMs: positive(values.get("--movement-timeout") ?? "10000", "--movement-timeout"),
    targetMapCpu: positive(values.get("--target-map-cpu") ?? "80", "--target-map-cpu"),
    managerPort: positive(values.get("--manager-port") ?? "7000", "--manager-port"),
    loginPort: positive(values.get("--login-port") ?? "7001", "--login-port"),
    gateBasePort: positive(values.get("--gate-base-port") ?? "7201", "--gate-base-port"),
    mapPort: positive(values.get("--map-port") ?? "7301", "--map-port"),
    locationPort: positive(values.get("--location-port") ?? "7401", "--location-port"),
    mapInspectorPort: nonNegative(
      values.get("--map-inspector-port") ?? "0",
      "--map-inspector-port",
    ),
    mapProfileDuration: positive(
      values.get("--map-profile-duration") ?? "10",
      "--map-profile-duration",
    ),
    debugRuntime: flags.has("--debug-runtime"),
    skipRustBuild: flags.has("--skip-rust-build"),
    probeOnly: flags.has("--probe-only"),
    client: enumValue(values.get("--client") ?? "rust", ["node", "rust"], "--client"),
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
    hotfixMode: enumValue(
      values.get("--hotfix-mode") ?? "off",
      ["off", "baseline", "reload"],
      "--hotfix-mode",
    ),
    hotfixCandidates: (values.get("--hotfix-candidates") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => path.resolve(root, item)),
    hotfixIntervalMs: positive(
      values.get("--hotfix-interval-ms") ?? "1000",
      "--hotfix-interval-ms",
    ),
    healthBasePort: positive(
      values.get("--health-base-port") ?? "7800",
      "--health-base-port",
    ),
    sourceIpBase: positive(
      values.get("--source-ip-base") ?? String(2 + Math.floor(Date.now() / 1_000) % 100),
      "--source-ip-base",
    ),
  };
  if (options.hotfixMode === "reload" && options.hotfixCandidates.length < 2) {
    throw new Error("--hotfix-mode reload requires at least two --hotfix-candidates");
  }
  const mapIdsByWorldGrids = new Map([[10, 1], [15, 1015], [20, 1020]]);
  options.mapId = mapIdsByWorldGrids.get(options.worldGrids);
  if (!options.mapId) {
    throw new Error("--world-grids currently supports 10, 15 or 20");
  }
  if (options.sourceIpBase + options.players.length * options.rounds - 1 > 254) {
    throw new Error("--source-ip-base plus all player/round cases must stay within 127.0.0.254");
  }
  return options;
}

function formatDensity(players, worldGrids) {
  const density = players / (worldGrids * worldGrids);
  return Number.isInteger(density) ? String(density) : density.toFixed(2);
}

function assertBenchBundle() {
  const manifestPath = path.join(root, "dist", "model.manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Bench Bundle不存在或无法读取；请使用 npm run perf:map-capacity 启动。${error}`,
    );
  }
  if (manifest.buildMode !== "bench") {
    throw new Error(
      `容量压测需要Bench Bundle，当前是${manifest.buildMode ?? "unknown"}；请使用 npm run perf:map-capacity 启动。`,
    );
  }
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

async function waitReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ready`);
      if (response.status === 200) return;
    } catch {}
    await sleep(50);
  }
  throw new Error(`timed out waiting for http://127.0.0.1:${port}/ready`);
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
function readRuntimeLogs(runtime) { return `${readText(runtime.stdoutPath)}\n${readText(runtime.stderrPath)}`; }
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
function nestedCounterDelta(samples, valueOf) {
  if (samples.length < 2) return 0;
  return Math.max(0, Number(valueOf(samples.at(-1)) ?? 0) - Number(valueOf(samples[0]) ?? 0));
}
function nestedCounterRate(samples, valueOf) {
  if (samples.length < 2) return 0;
  const elapsedSeconds = (samples.at(-1).timestampMs - samples[0].timestampMs) / 1000;
  return elapsedSeconds > 0 ? nestedCounterDelta(samples, valueOf) / elapsedSeconds : 0;
}
function numericTypeName(value) {
  return ({
    1: "CurrentHp",
    2: "CurrentMp",
    3: "Level",
    4: "Experience",
    1000: "MaxHp",
    1001: "MaxMp",
    2000: "Attack",
    2001: "AttackSpeed",
    3000: "MoveSpeed",
  })[value] ?? "Numeric";
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
function writeJson(file, value) {
  const portable = SanitizePerformanceReport(value, root);
  writeFileSync(file, `${JSON.stringify(portable, null, 2)}\n`, "utf8");
}
