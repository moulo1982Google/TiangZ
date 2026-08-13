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
const logDir = path.join(resultDir, "logs", `${options.outputPrefix}_${runId}`);
mkdirSync(logDir, { recursive: true });

const executable = path.join(
  root,
  "target",
  options.debugRuntime ? "debug" : "release",
  process.platform === "win32" ? "TiangZ.exe" : "TiangZ",
);
const gameClient = path.join(root, "dist", "full_chain_load_test.cjs");
const rawResults = [];
const activeRuntimes = new Set();
const activeCommands = new Set();
let interrupting = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void handleInterrupt(signal));
}

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
          writeJson(path.join(resultDir, `${options.outputPrefix}_${runId}_raw.json`), rawResults);
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
  const jsonPath = path.join(resultDir, `${options.outputPrefix}_${runId}.json`);
  const markdownPath = path.join(resultDir, `${options.outputPrefix}_${runId}.md`);
  writeJson(jsonPath, report);
  writeJson(path.join(resultDir, `${options.outputPrefix}_latest.json`), report);
  const markdown = renderMarkdown(report);
  writeFileSync(markdownPath, markdown, "utf8");
  writeFileSync(path.join(resultDir, `${options.outputPrefix}_latest.md`), markdown, "utf8");
  console.log(`[${options.outputPrefix}] report: ${markdownPath}`);
  console.log(markdown);
}

async function runCase(deployment, players, moveRate, round) {
  const workload = moveRate > 0 ? `${moveRate}hz` : "saturation";
  const caseName = `${deployment}_${players}_${workload}_r${round}`;
  console.log(`[full-chain] ${caseName}`);
  const runtimes = [];
  let clientResult;
  let healthSampler;
  let healthSamples = new Map();
  try {
    if (!options.remote) {
      const configs = deployment === "all"
        ? ["configs/local/all-in-one.json"]
        : [
            "configs/local/cluster/manager.json",
            "configs/local/cluster/login-1.json",
            "configs/local/cluster/login-2.json",
            "configs/local/cluster/gate-1.json",
            "configs/local/cluster/map-1.json",
          ];
      for (const config of configs) {
        const configName = path.basename(config, ".json");
        runtimes.push(startRuntime(config, `${caseName}_${configName}`));
      }
      const ports = new Set([
        7000,
        7001,
        7002,
        7201,
        7301,
        ...runtimes.map((runtime) => runtime.healthPort).filter((port) => port > 0),
      ]);
      for (const port of ports) {
        await waitPort("127.0.0.1", port, 20_000);
      }
      await Promise.all(runtimes
        .filter((runtime) => runtime.healthPort > 0)
        .map((runtime) => waitReady(runtime.healthHost, runtime.healthPort, 20_000)));
    } else {
      await waitPort(options.host, options.managerPort, 20_000);
    }

    // 通过健康端点采集资源和队列；日志只作为旧配置/旧 Runtime 的后备来源。
    // Sample resources and queues through the health endpoint; logs remain a fallback for older runtimes.
    if (!options.remote) healthSampler = startHealthSampler(runtimes);
    const output = await runCommand(process.execPath, [
      gameClient,
      "--host", options.host,
      "--manager-port", String(options.managerPort),
      "--players", String(players),
      "--setup-concurrency", String(options.setupConcurrency),
      "--duration", String(options.duration),
      "--warmup", String(options.warmup),
      "--move-rate", String(moveRate),
      "--business-rate", String(options.businessRate),
      "--label", deployment,
    ]);
    process.stdout.write(output);
    const line = output.split(/\r?\n/).findLast((item) => item.startsWith("RESULT_JSON "));
    if (!line) throw new Error("gameplay client did not return RESULT_JSON");
    clientResult = JSON.parse(line.slice("RESULT_JSON ".length));
  } finally {
    if (healthSampler) healthSamples = await healthSampler.stop();
    await stopRuntimes(runtimes);
  }
  return {
    ...clientResult,
    round,
    serverResources: options.remote
      ? undefined
      : collectRuntimeResources(
        runtimes,
        clientResult?.measurementStartedAtUnixMs,
        clientResult?.measurementEndedAtUnixMs,
        healthSamples,
      ),
    logDirectory: logDir,
  };
}

function startRuntime(configPath, logName) {
  const stdoutPath = path.join(logDir, `${logName}_stdout.log`);
  const stderrPath = path.join(logDir, `${logName}_stderr.log`);
  const child = spawn(executable, [configPath], {
    cwd: root,
    env: { ...process.env, TIANGZ_WATCHER_CONTROL: "stdin" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.pipe(createWriteStream(stdoutPath));
  child.stderr.pipe(createWriteStream(stderrPath));
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const health = config.process?.observability?.health;
  const runtime = {
    child,
    name: config.process?.name ?? path.basename(configPath, ".json"),
    healthHost: health?.ip ?? "127.0.0.1",
    healthPort: health?.port ?? 0,
    stdoutPath,
    stderrPath,
  };
  activeRuntimes.add(runtime);
  return runtime;
}

async function stopRuntimes(runtimes) {
  for (const runtime of runtimes) {
    if (runtime.child.exitCode !== null) continue;
    runtime.child.stdin.end("shutdown\n");
  }
  await Promise.all(runtimes.map(async (runtime) => {
    if (runtime.child.exitCode !== null) return;
    await Promise.race([onceExit(runtime.child), sleep(15_000)]);
    if (runtime.child.exitCode === null) runtime.child.kill("SIGKILL");
  }));
  for (const runtime of runtimes) activeRuntimes.delete(runtime);
}

function collectRuntimeResources(runtimes, startedAt, endedAt, healthSamples = new Map()) {
  const processes = runtimes.map((runtime) => {
    let text = "";
    try { text = readFileSync(runtime.stdoutPath, "utf8"); } catch {}
    const logSamples = [...text.matchAll(
      /\[process-metrics\] process=(\S+) cpu_percent=([0-9.]+) cpu_time_ms=(\d+) rss_bytes=(\d+) v8_heap_used_bytes=(\d+) v8_heap_total_bytes=(\d+) v8_gc_count=(\d+) v8_gc_ms=([0-9.]+) timestamp_ms=(\d+)/g,
    )].map((match) => ({
      process: match[1],
      cpuPercent: Number(match[2]),
      cpuTimeMs: Number(match[3]),
      rssBytes: Number(match[4]),
      v8HeapUsedBytes: Number(match[5]),
      v8HeapTotalBytes: Number(match[6]),
      v8GcCount: Number(match[7]),
      v8GcMs: Number(match[8]),
      timestampMs: Number(match[9]),
    }));
    const endpointSamples = healthSamples.get(runtime.name) ?? [];
    const allSamples = endpointSamples.length > 0 ? endpointSamples : logSamples;
    const formalSamples = allSamples.filter((sample) =>
      startedAt && endedAt &&
      sample.timestampMs >= startedAt + 4_000 &&
      sample.timestampMs <= endedAt + 1_000
    );
    const samples = formalSamples.length > 0
      ? formalSamples
      : allSamples.slice(-Math.max(1, Math.floor(options.duration / 5)));
    const last = samples.at(-1);
    const rssTrend = resourceTrend(samples, "rssBytes");
    const heapTrend = resourceTrend(samples, "v8HeapUsedBytes");
    // GC counters are cumulative for the Runtime lifetime. Report the delta
    // across the formal window instead of treating the final lifetime total as
    // work performed by this case.
    // GC 计数器是 Runtime 生命周期累计值；正式窗口必须记录首尾增量，不能把最终累计值当成本轮开销。
    const gcCountWindow = cumulativeWindow(allSamples, "v8GcCount", startedAt, endedAt);
    const gcMsWindow = cumulativeWindow(allSamples, "v8GcMs", startedAt, endedAt);
    return {
      process: last?.process ?? runtime.name,
      samples: samples.length,
      // 空采样必须保持 undefined；0 代表真实采样到的零值，不能代替“没有数据”。
      // Empty samples must stay undefined; zero is a real observation, not a substitute for missing data.
      peakCpuPercent: optionalMax(samples.map((item) => item.cpuPercent)),
      peakRssBytes: optionalMax(samples.map((item) => item.rssBytes)),
      peakV8HeapUsedBytes: optionalMax(samples.map((item) => item.v8HeapUsedBytes)),
      cpuTimeMs: last?.cpuTimeMs,
      v8GcCount: last?.v8GcCount,
      v8GcMs: last?.v8GcMs,
      v8GcCountStart: gcCountWindow.start,
      v8GcCountEnd: gcCountWindow.end,
      v8GcCountDelta: gcCountWindow.delta,
      v8GcMsStart: gcMsWindow.start,
      v8GcMsEnd: gcMsWindow.end,
      v8GcMsDelta: gcMsWindow.delta,
      v8GcWindowDurationMs: gcMsWindow.durationMs,
      v8GcMsPerSecond: gcMsWindow.perSecond,
      queueDepth: last?.queueDepth,
      queueCapacity: last?.queueCapacity,
      queueMaxDepth: optionalMax(samples.map((item) => item.queueMaxDepth)),
      backpressureWaits: last?.backpressureWaits,
      slowDisconnects: last?.slowDisconnects,
      innerOverloads: last?.innerOverloads,
      innerTimeouts: last?.innerTimeouts,
      mailboxFastPathCalls: last?.mailboxFastPathCalls,
      mailboxQueuedCalls: last?.mailboxQueuedCalls,
      mailboxAsyncCalls: last?.mailboxAsyncCalls,
      mailboxOneWayFastPathCalls: last?.mailboxOneWayFastPathCalls,
      mailboxOneWayQueuedCalls: last?.mailboxOneWayQueuedCalls,
      mailboxOneWayAsyncCalls: last?.mailboxOneWayAsyncCalls,
      mailboxQueuedDepth: last?.mailboxQueuedDepth,
      mailboxMaxQueuedDepth: optionalMax(samples.map((item) => item.mailboxMaxQueuedDepth)),
      actorMailboxFastPathCalls: last?.actorMailboxFastPathCalls,
      actorMailboxQueuedCalls: last?.actorMailboxQueuedCalls,
      actorMailboxAsyncCalls: last?.actorMailboxAsyncCalls,
      actorMailboxOneWayFastPathCalls: last?.actorMailboxOneWayFastPathCalls,
      actorMailboxOneWayQueuedCalls: last?.actorMailboxOneWayQueuedCalls,
      actorMailboxOneWayAsyncCalls: last?.actorMailboxOneWayAsyncCalls,
      actorMailboxQueuedDepth: last?.actorMailboxQueuedDepth,
      actorMailboxMaxQueuedDepth: optionalMax(samples.map((item) => item.actorMailboxMaxQueuedDepth)),
      rssStartBytes: rssTrend.start,
      rssEndBytes: rssTrend.end,
      rssGrowthBytes: rssTrend.growth,
      rssGrowthBytesPerHour: rssTrend.perHour,
      rssLastHalfBytesPerHour: rssTrend.lastHalfPerHour,
      rssLastQuarterBytesPerHour: rssTrend.lastQuarterPerHour,
      v8HeapStartBytes: heapTrend.start,
      v8HeapEndBytes: heapTrend.end,
      v8HeapGrowthBytes: heapTrend.growth,
      v8HeapGrowthBytesPerHour: heapTrend.perHour,
      v8HeapLastHalfBytesPerHour: heapTrend.lastHalfPerHour,
      v8HeapLastQuarterBytesPerHour: heapTrend.lastQuarterPerHour,
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
    v8GcCountDeltaSum: sum(processes.map((item) => item.v8GcCountDelta)),
    v8GcMsDeltaSum: sum(processes.map((item) => item.v8GcMsDelta)),
    v8GcMsPerSecondSum: sum(processes.map((item) => item.v8GcMsPerSecond)),
    rssGrowthBytesSum: sum(processes.map((item) => item.rssGrowthBytes)),
    rssGrowthBytesPerHourSum: sum(processes.map((item) => item.rssGrowthBytesPerHour)),
    v8HeapGrowthBytesSum: sum(processes.map((item) => item.v8HeapGrowthBytes)),
    v8HeapGrowthBytesPerHourSum: sum(processes.map((item) => item.v8HeapGrowthBytesPerHour)),
    queueDepthSum: sum(processes.map((item) => item.queueDepth)),
    queueCapacitySum: sum(processes.map((item) => item.queueCapacity)),
    queueMaxDepthSum: sum(processes.map((item) => item.queueMaxDepth)),
    backpressureWaitsSum: sum(processes.map((item) => item.backpressureWaits)),
    slowDisconnectsSum: sum(processes.map((item) => item.slowDisconnects)),
    innerOverloadsSum: sum(processes.map((item) => item.innerOverloads)),
    innerTimeoutsSum: sum(processes.map((item) => item.innerTimeouts)),
    mailboxFastPathCallsSum: sum(processes.map((item) => item.mailboxFastPathCalls)),
    mailboxQueuedCallsSum: sum(processes.map((item) => item.mailboxQueuedCalls)),
    mailboxAsyncCallsSum: sum(processes.map((item) => item.mailboxAsyncCalls)),
    mailboxOneWayFastPathCallsSum: sum(processes.map((item) => item.mailboxOneWayFastPathCalls)),
    mailboxOneWayQueuedCallsSum: sum(processes.map((item) => item.mailboxOneWayQueuedCalls)),
    mailboxOneWayAsyncCallsSum: sum(processes.map((item) => item.mailboxOneWayAsyncCalls)),
    mailboxQueuedDepthSum: sum(processes.map((item) => item.mailboxQueuedDepth)),
    mailboxMaxQueuedDepthSum: sum(processes.map((item) => item.mailboxMaxQueuedDepth)),
    actorMailboxFastPathCallsSum: sum(processes.map((item) => item.actorMailboxFastPathCalls)),
    actorMailboxQueuedCallsSum: sum(processes.map((item) => item.actorMailboxQueuedCalls)),
    actorMailboxAsyncCallsSum: sum(processes.map((item) => item.actorMailboxAsyncCalls)),
    actorMailboxOneWayFastPathCallsSum: sum(processes.map((item) => item.actorMailboxOneWayFastPathCalls)),
    actorMailboxOneWayQueuedCallsSum: sum(processes.map((item) => item.actorMailboxOneWayQueuedCalls)),
    actorMailboxOneWayAsyncCallsSum: sum(processes.map((item) => item.actorMailboxOneWayAsyncCalls)),
    actorMailboxQueuedDepthSum: sum(processes.map((item) => item.actorMailboxQueuedDepth)),
    actorMailboxMaxQueuedDepthSum: sum(processes.map((item) => item.actorMailboxMaxQueuedDepth)),
  };
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
  if (!runtime.healthPort) return { process: runtime.name };
  try {
    const response = await fetch(
      `http://${runtime.healthHost}:${runtime.healthPort}/metrics`,
      { signal: AbortSignal.timeout(1_000) },
    );
    if (!response.ok) return { process: runtime.name };
    const body = await response.text();
    const metric = (name) => prometheusMetric(body, name);
    return {
      process: runtime.name,
      cpuPercent: metric("tiangz_process_cpu_percent"),
      cpuTimeMs: metric("tiangz_process_cpu_time_ms"),
      rssBytes: metric("tiangz_process_rss_bytes"),
      v8HeapUsedBytes: metric("tiangz_process_v8_heap_used_bytes"),
      v8HeapTotalBytes: metric("tiangz_process_v8_heap_total_bytes"),
      v8GcCount: metric("tiangz_process_v8_gc_count_total"),
      v8GcMs: metric("tiangz_process_v8_gc_ms_total"),
      timestampMs: metric("tiangz_process_metrics_timestamp_ms"),
      queueDepth: metric("tiangz_process_rust_queue_depth"),
      queueCapacity: metric("tiangz_process_rust_queue_capacity"),
      queueMaxDepth: metric("tiangz_process_rust_queue_max_depth"),
      backpressureWaits: metric("tiangz_process_backpressure_waits_total"),
      slowDisconnects: metric("tiangz_process_slow_disconnects_total"),
      innerOverloads: metric("tiangz_transport_inner_overload_rejections"),
      innerTimeouts: metric("tiangz_transport_inner_timed_out_calls"),
      mailboxFastPathCalls: prometheusMetricSum(body, "tiangz_scene_mailbox_fast_path_calls_total"),
      mailboxQueuedCalls: prometheusMetricSum(body, "tiangz_scene_mailbox_queued_calls_total"),
      mailboxAsyncCalls: prometheusMetricSum(body, "tiangz_scene_mailbox_async_calls_total"),
      mailboxOneWayFastPathCalls: prometheusMetricSum(body, "tiangz_scene_mailbox_one_way_fast_path_calls_total"),
      mailboxOneWayQueuedCalls: prometheusMetricSum(body, "tiangz_scene_mailbox_one_way_queued_calls_total"),
      mailboxOneWayAsyncCalls: prometheusMetricSum(body, "tiangz_scene_mailbox_one_way_async_calls_total"),
      mailboxQueuedDepth: prometheusMetricMax(body, "tiangz_scene_mailbox_queued_depth"),
      mailboxMaxQueuedDepth: prometheusMetricMax(body, "tiangz_scene_mailbox_max_queued_depth"),
      actorMailboxFastPathCalls: metric("tiangz_process_actor_mailbox_fast_path_calls_total"),
      actorMailboxQueuedCalls: metric("tiangz_process_actor_mailbox_queued_calls_total"),
      actorMailboxAsyncCalls: metric("tiangz_process_actor_mailbox_async_calls_total"),
      actorMailboxOneWayFastPathCalls: metric("tiangz_process_actor_mailbox_one_way_fast_path_calls_total"),
      actorMailboxOneWayQueuedCalls: metric("tiangz_process_actor_mailbox_one_way_queued_calls_total"),
      actorMailboxOneWayAsyncCalls: metric("tiangz_process_actor_mailbox_one_way_async_calls_total"),
      actorMailboxQueuedDepth: metric("tiangz_process_actor_mailbox_queued_depth"),
      actorMailboxMaxQueuedDepth: metric("tiangz_process_actor_mailbox_max_queued_depth"),
    };
  } catch {
    return { process: runtime.name };
  }
}

function prometheusMetric(body, name) {
  const line = body.split(/\r?\n/).find((value) => value.startsWith(`${name}{`));
  if (!line) return undefined;
  const value = Number(line.slice(line.lastIndexOf(" ") + 1));
  return Number.isFinite(value) ? value : undefined;
}

// Scene metrics carry a scene label, so process-level reports must aggregate
// all matching series instead of reading the first scene only.
// Scene 指标带有 scene 标签，进程级报告必须聚合全部序列，不能只读取第一个 Scene。
function prometheusMetricValues(body, name) {
  return body
    .split(/\r?\n/)
    .filter((value) => value.startsWith(`${name}{`))
    .map((value) => Number(value.slice(value.lastIndexOf(" ") + 1)))
    .filter((value) => Number.isFinite(value));
}

function prometheusMetricSum(body, name) {
  const values = prometheusMetricValues(body, name);
  return values.length > 0 ? sum(values) : undefined;
}

function prometheusMetricMax(body, name) {
  const values = prometheusMetricValues(body, name);
  return values.length > 0 ? max(values) : undefined;
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
      moveAcknowledged: median(group.map((item) => item.movement.acknowledged ?? 0)),
      moveLatencySamples: median(group.map((item) => item.movement.latencySamples ?? 0)),
      moveP50Ms: median(group.map((item) => item.movement.p50Ms)),
      moveP95Ms: median(group.map((item) => item.movement.p95Ms)),
      moveP99Ms: median(group.map((item) => item.movement.p99Ms)),
      stalled: median(group.map((item) => item.movement.errors)),
      probeErrors: requiredMedian(group, (item) => item.probe?.errors),
      businessPerSecond: median(group.map((item) => item.business?.perSecond ?? 0)),
      businessAccepted: median(group.map((item) => item.business?.accepted ?? 0)),
      businessRejected: median(group.map((item) => item.business?.rejected ?? 0)),
      businessTransportErrors: options.businessRate > 0
        ? requiredMedian(group, (item) => item.business?.transportErrors)
        : median(group.map((item) => item.business?.transportErrors ?? 0)),
      businessP50Ms: median(group.map((item) => item.business?.p50Ms ?? 0)),
      businessP95Ms: median(group.map((item) => item.business?.p95Ms ?? 0)),
      businessP99Ms: median(group.map((item) => item.business?.p99Ms ?? 0)),
      serverPeakCpuPercentSum: requiredMedian(group, (item) => item.serverResources?.peakCpuPercentSum),
      serverPeakRssBytesSum: requiredMedian(group, (item) => item.serverResources?.peakRssBytesSum),
      serverGcCount: requiredMedian(group, (item) => item.serverResources?.v8GcCountSum),
      serverGcMs: requiredMedian(group, (item) => item.serverResources?.v8GcMsSum),
      serverGcCountDelta: requiredMedian(group, (item) => item.serverResources?.v8GcCountDeltaSum),
      serverGcMsDelta: requiredMedian(group, (item) => item.serverResources?.v8GcMsDeltaSum),
      serverGcMsPerSecond: requiredMedian(group, (item) => item.serverResources?.v8GcMsPerSecondSum),
      serverQueueMaxDepthSum: requiredMedian(group, (item) => item.serverResources?.queueMaxDepthSum),
      serverBackpressureWaitsSum: requiredMedian(group, (item) => item.serverResources?.backpressureWaitsSum),
      serverInnerOverloadsSum: requiredMedian(group, (item) => item.serverResources?.innerOverloadsSum),
      serverInnerTimeoutsSum: requiredMedian(group, (item) => item.serverResources?.innerTimeoutsSum),
      serverMailboxQueuedCallsSum: requiredMedian(group, (item) => item.serverResources?.mailboxQueuedCallsSum),
      serverMailboxOneWayQueuedCallsSum: requiredMedian(group, (item) => item.serverResources?.mailboxOneWayQueuedCallsSum),
      serverMailboxOneWayAsyncCallsSum: requiredMedian(group, (item) => item.serverResources?.mailboxOneWayAsyncCallsSum),
      serverMailboxMaxQueuedDepthSum: requiredMedian(group, (item) => item.serverResources?.mailboxMaxQueuedDepthSum),
      serverActorMailboxQueuedCallsSum: requiredMedian(group, (item) => item.serverResources?.actorMailboxQueuedCallsSum),
      serverActorMailboxOneWayQueuedCallsSum: requiredMedian(group, (item) => item.serverResources?.actorMailboxOneWayQueuedCallsSum),
      serverActorMailboxMaxQueuedDepthSum: requiredMedian(group, (item) => item.serverResources?.actorMailboxMaxQueuedDepthSum),
      serverRssGrowthBytesPerHour: requiredMedian(group, (item) => item.serverResources?.rssGrowthBytesPerHourSum),
      serverV8HeapGrowthBytesPerHour: requiredMedian(group, (item) => item.serverResources?.v8HeapGrowthBytesPerHourSum),
      loadCpuMs: median(group.map((item) => item.loadGenerator.cpuUserMs + item.loadGenerator.cpuSystemMs)),
      loadPeakRssBytes: median(group.map((item) => item.loadGenerator.maxRssBytes)),
      loadGcCount: requiredMedian(group, (item) => item.loadGenerator?.gcCountDelta ?? item.loadGenerator?.gcCount),
      loadGcMs: requiredMedian(group, (item) => item.loadGenerator?.gcDurationDeltaMs ?? item.loadGenerator?.gcDurationMs),
      loadGcMsPerSecond: requiredMedian(group, (item) => item.loadGenerator?.gcDurationMsPerSecond),
    },
  }));
}

function renderMarkdown(report) {
  const lines = [
    options.outputPrefix === "soak" ? "# TiangZ 长稳测试报告" : "# 全链路性能测试报告",
    "",
    `- 时间：${report.generatedAt}`,
    `- 正式测试：${options.duration}s；预热：${options.warmup}s；轮数：${options.rounds}`,
    `- 服务端：${options.host}；独立部署：${options.remote ? "是" : "否"}`,
    `- 压测机：${report.loadGeneratorMachine.cpu} / ${report.loadGeneratorMachine.logicalCpus} 逻辑核 / ${formatBytes(report.loadGeneratorMachine.memoryBytes)}`,
    "",
    `## ${options.rounds} 轮中位数`,
    "",
    "| 部署 | 负载 | 玩家 | move/s | push/s | 确认数 | move p95 | business/s | business成功 | business拒绝 | business传输错 | business p95 | stalled | Server CPU% | Server RSS | Queue峰值(启动至今) | Backpressure | Inner超载 | Inner超时 | Load CPU ms | Load RSS |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const item of report.cases) {
    const value = item.median;
    lines.push(`| ${item.label} | ${item.workload} | ${item.players} | ${round(value.movesPerSecond)} | ${round(value.pushesPerSecond)} | ${value.moveAcknowledged} | ${round(value.moveP95Ms, 2)} | ${round(value.businessPerSecond)} | ${value.businessAccepted} | ${value.businessRejected} | ${value.businessTransportErrors} | ${round(value.businessP95Ms, 2)} | ${value.stalled} | ${options.remote ? "N/A" : round(value.serverPeakCpuPercentSum, 1)} | ${options.remote ? "N/A" : formatBytes(value.serverPeakRssBytesSum)} | ${options.remote ? "N/A" : value.serverQueueMaxDepthSum} | ${options.remote ? "N/A" : value.serverBackpressureWaitsSum} | ${options.remote ? "N/A" : value.serverInnerOverloadsSum} | ${options.remote ? "N/A" : value.serverInnerTimeoutsSum} | ${round(value.loadCpuMs)} | ${formatBytes(value.loadPeakRssBytes)} |`);
  }
  lines.push(
    "",
    "## Mailbox 低分配观测",
    "",
    "| 部署 | 负载 | 玩家 | Scene有序调用排队 | Scene单向消息排队 | Scene单向异步 | Scene峰值深度 | Actor有序调用排队 | Actor单向消息排队 | Actor峰值深度 |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const item of report.cases) {
    const value = item.median;
    lines.push(`| ${item.label} | ${item.workload} | ${item.players} | ${options.remote ? "N/A" : value.serverMailboxQueuedCallsSum} | ${options.remote ? "N/A" : value.serverMailboxOneWayQueuedCallsSum} | ${options.remote ? "N/A" : value.serverMailboxOneWayAsyncCallsSum} | ${options.remote ? "N/A" : value.serverMailboxMaxQueuedDepthSum} | ${options.remote ? "N/A" : value.serverActorMailboxQueuedCallsSum} | ${options.remote ? "N/A" : value.serverActorMailboxOneWayQueuedCallsSum} | ${options.remote ? "N/A" : value.serverActorMailboxMaxQueuedDepthSum} |`);
  }
  lines.push(
    "",
    "## GC 正式窗口增量",
    "",
    "| 部署 | 负载 | 玩家 | Server GC次数增量 | Server GC耗时增量(ms) | Server GC耗时(ms/s) | Load GC次数增量 | Load GC耗时增量(ms) | Load GC耗时(ms/s) |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const item of report.cases) {
    const value = item.median;
    lines.push(`| ${item.label} | ${item.workload} | ${item.players} | ${options.remote ? "N/A" : round(value.serverGcCountDelta)} | ${options.remote ? "N/A" : round(value.serverGcMsDelta, 3)} | ${options.remote ? "N/A" : round(value.serverGcMsPerSecond, 3)} | ${round(value.loadGcCount)} | ${round(value.loadGcMs, 3)} | ${round(value.loadGcMsPerSecond, 3)} |`);
  }
  if (options.outputPrefix === "soak") {
    lines.push(
      "",
      "## 服务端内存趋势",
      "",
      "| 进程 | 样本 | RSS 起点 | RSS 终点 | RSS 首尾折算/小时 | RSS 后1/4斜率/小时 | V8 Heap 起点 | V8 Heap 终点 | Heap 首尾折算/小时 | Heap 后1/4斜率/小时 |",
      "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    );
    for (const round of report.rounds) {
      for (const process of round.serverResources?.processes ?? []) {
        lines.push(`| ${process.process} | ${process.samples} | ${formatBytes(process.rssStartBytes)} | ${formatBytes(process.rssEndBytes)} | ${formatSignedBytes(process.rssGrowthBytesPerHour)} | ${formatSignedBytes(process.rssLastQuarterBytesPerHour)} | ${formatBytes(process.v8HeapStartBytes)} | ${formatBytes(process.v8HeapEndBytes)} | ${formatSignedBytes(process.v8HeapGrowthBytesPerHour)} | ${formatSignedBytes(process.v8HeapLastQuarterBytesPerHour)} |`);
      }
    }
    lines.push(
      "",
      "## 压测端内存趋势",
      "",
      "| 部署 | 玩家 | 负载 | 样本 | RSS 起点 | RSS 终点 | RSS 首尾折算/小时 | RSS 后1/4斜率/小时 | Heap 起点 | Heap 终点 | Heap 首尾折算/小时 | Heap 后1/4斜率/小时 |",
      "|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    );
    for (const round of report.rounds) {
      const load = round.loadGenerator;
      lines.push(`| ${round.label} | ${round.players} | ${round.workload} | ${load.memorySamples} | ${formatBytes(load.rssStartBytes)} | ${formatBytes(load.rssEndBytes)} | ${formatSignedBytes(load.rssGrowthBytesPerHour)} | ${formatSignedBytes(load.rssLastQuarterBytesPerHour)} | ${formatBytes(load.heapStartBytes)} | ${formatBytes(load.heapEndBytes)} | ${formatSignedBytes(load.heapGrowthBytesPerHour)} | ${formatSignedBytes(load.heapLastQuarterBytesPerHour)} |`);
    }
  }
  lines.push(
    "",
    "## 指标口径",
    "",
    "- `move/s` 是客户端发送移动到收到自身权威位置 Push 的闭环吞吐。",
    "- `business/s` 是真实 UseItem 与 CastSkill 请求的响应吞吐；`business成功/拒绝`按服务端业务响应分类，`business传输错`才表示连接、超时或协议层异常。",
    "- 业务负载默认交替使用1001道具和3005友方技能；压测客户端从EnterMap快照读取1001的ItemId，服务端仍是唯一权威。",
    "- `确认数` 统计所有匹配 `acknowledgedSequence` 的权威 Push；延迟分位数使用每玩家最多约 1024 个均匀样本，避免长稳工具自身内存线性增长。",
    "- `push/s` 是所有客户端实际收到的 EntityMove 数；当前仍为同地图全量可见，尚未启用 AOI。",
    "- Server CPU/RSS/队列来自各 Runtime 的 `/metrics` 采样；GC 使用正式窗口的累计计数器首尾差值，生命周期累计值只保留在 raw JSON 作诊断；若旧 Runtime 没有健康端点才回退到 `[process-metrics]` 日志，split 模式按进程汇总。",
    "- `GC 正式窗口增量` 的 `GC ms/s` 是正式窗口内的 GC 暂停时间除以窗口秒数；它不能直接等同于业务分配字节数。",
    "- `Queue峰值(启动至今)` 是进程启动以来的 Rust 队列 max_depth；当前队列深度另保存在 raw JSON，Backpressure/Inner超载/Inner超时为正式采样窗口内的累计事件。",
    "- `Mailbox低分配观测` 来自每个 Scene 的 Prometheus 序列汇总；单向消息排队应尽量接近零，Mailbox 峰值必须结合 stalled、P99 和业务语义判断。",
    "- Load CPU/RSS/GC 只代表压测客户端，独立压测机模式用于排除它与服务端争抢资源。",
    "- MapHost 发布 latest 移动状态；BroadcastHub 通过通用 `S2G_ClientBroadcast` 按 UnitId 聚合下行。",
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
  const outputPrefix = values.get("--output-prefix") ?? "full_chain";
  if (!/^[a-z0-9_-]+$/.test(outputPrefix)) throw new Error(`invalid --output-prefix: ${outputPrefix}`);
  return {
    mode,
    players: csvNumbers(values.get("--players") ?? "10,50,100"),
    moveRates: csvNumbers(values.get("--move-rates") ?? "2,0"),
    businessRate: nonNegative(values.get("--business-rate") ?? "0", "--business-rate"),
    duration: positive(values.get("--duration") ?? "60", "--duration"),
    warmup: nonNegative(values.get("--warmup") ?? "10", "--warmup"),
    rounds: positive(values.get("--rounds") ?? "3", "--rounds"),
    setupConcurrency: positive(values.get("--setup-concurrency") ?? "16", "--setup-concurrency"),
    host: values.get("--host") ?? "127.0.0.1",
    managerPort: positive(values.get("--manager-port") ?? "7000", "--manager-port"),
    remote: flags.has("--remote"),
    label: values.get("--label"),
    debugRuntime: flags.has("--debug-runtime"),
    outputPrefix,
  };
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true });
    activeCommands.add(child);
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", (error) => {
      activeCommands.delete(child);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      activeCommands.delete(child);
      if (code === 0) resolve(output);
      else reject(new Error(`${command} failed with code=${code} signal=${signal}\n${output}`));
    });
  });
}

async function handleInterrupt(signal) {
  if (interrupting) return;
  interrupting = true;
  console.error(`[full-chain] received ${signal}; stopping load generator and runtimes`);
  for (const child of activeCommands) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  await stopRuntimes([...activeRuntimes]);
  process.exit(130);
}

async function waitPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(host, port)) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${host}:${port}`);
}

async function waitReady(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${host}:${port}/ready`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 200) return;
    } catch {}
    await sleep(50);
  }
  throw new Error(`timed out waiting for http://${host}:${port}/ready`);
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

function onceExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function sum(values) { return values.reduce((total, value) => total + value, 0); }
function max(values) { return values.length === 0 ? 0 : Math.max(...values); }
function optionalMax(values) {
  const numeric = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  return numeric.length === 0 ? undefined : Math.max(...numeric);
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
// Required metrics must remain missing when any round lacks a numeric sample; do not turn missing data into zero.
// 必填指标只要有一轮缺少数值采样就保持缺失，不能把采集失败伪装成零。
function requiredMedian(items, selector) {
  const values = items.map(selector);
  return values.every((value) => typeof value === "number" && Number.isFinite(value))
    ? median(values)
    : undefined;
}
function csvNumbers(value) { return value.split(",").map((item) => Number(item.trim())); }
function positive(value, name) { const number = Number(value); if (!(number > 0)) throw new Error(`${name} must be > 0`); return number; }
function nonNegative(value, name) { const number = Number(value); if (!(number >= 0)) throw new Error(`${name} must be >= 0`); return number; }
function round(value, digits = 0) { const scale = 10 ** digits; return Math.round(value * scale) / scale; }
function formatBytes(value) { return `${(value / 1024 / 1024).toFixed(1)}MB`; }
function formatSignedBytes(value) { return `${value >= 0 ? "+" : ""}${formatBytes(value)}/h`; }
function resourceTrend(samples, key) {
  const values = samples.map((sample) => sample?.[key]);
  if (values.length === 0 || !values.every(isFiniteNumber)) return emptyResourceTrend();
  const startIndex = Math.min(samples.length - 1, Math.floor(samples.length * 0.1));
  const start = values[startIndex];
  const end = values.at(-1);
  const elapsedHours = Math.max(
    0,
    (samples.at(-1).timestampMs - samples[startIndex].timestampMs) / 3_600_000,
  );
  const growth = end - start;
  return {
    start,
    end,
    growth,
    perHour: elapsedHours > 0 ? growth / elapsedHours : 0,
    lastHalfPerHour: regressionPerHour(samples, key, 0.5),
    lastQuarterPerHour: regressionPerHour(samples, key, 0.75),
  };
}

function cumulativeWindow(samples, key, startedAt, endedAt) {
  if (!startedAt || !endedAt || samples.length === 0) return emptyCumulativeWindow();
  const sorted = [...samples].sort((left, right) => left.timestampMs - right.timestampMs);
  const before = sorted.filter((sample) => sample.timestampMs < startedAt).at(-1);
  const afterStart = sorted.find((sample) => sample.timestampMs >= startedAt);
  const end = sorted.filter((sample) => sample.timestampMs <= endedAt + 1_000).at(-1);
  const first = before ?? afterStart;
  if (!first || !end || !isFiniteNumber(first[key]) || !isFiniteNumber(end[key])) {
    return emptyCumulativeWindow();
  }
  const startValue = first[key];
  const endValue = end[key];
  const durationMs = Math.max(0, end.timestampMs - first.timestampMs);
  const delta = Math.max(0, endValue - startValue);
  return {
    start: startValue,
    end: endValue,
    delta,
    durationMs,
    perSecond: durationMs > 0 ? delta / (durationMs / 1_000) : 0,
  };
}

function regressionPerHour(samples, key, startFraction) {
  if (samples.length < 2 || !samples.every((sample) => isFiniteNumber(sample?.[key]))) return undefined;
  const startIndex = Math.min(samples.length - 2, Math.floor(samples.length * startFraction));
  const selected = samples.slice(startIndex);
  const firstTimestamp = selected[0].timestampMs;
  const xs = selected.map((sample) => (sample.timestampMs - firstTimestamp) / 3_600_000);
  const xMean = sum(xs) / xs.length;
  const yMean = sum(selected.map((sample) => sample[key])) / selected.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < selected.length; index += 1) {
    const dx = xs[index] - xMean;
    numerator += dx * (selected[index][key] - yMean);
    denominator += dx * dx;
  }
  return denominator > 0 ? numerator / denominator : 0;
}
function isFiniteNumber(value) { return typeof value === "number" && Number.isFinite(value); }
function emptyResourceTrend() {
  return {
    start: undefined,
    end: undefined,
    growth: undefined,
    perHour: undefined,
    lastHalfPerHour: undefined,
    lastQuarterPerHour: undefined,
  };
}
function emptyCumulativeWindow() {
  return { start: undefined, end: undefined, delta: undefined, durationMs: undefined, perSecond: undefined };
}
function timestamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_"); }
function machineInfo() {
  return { cpu: os.cpus()[0]?.model ?? "unknown", logicalCpus: os.cpus().length, memoryBytes: os.totalmem(), os: `${os.platform()} ${os.release()}` };
}
function writeJson(file, value) { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
