import { execFile } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const options = parseOptions(process.argv.slice(2));
mkdirSync(options.runDir, { recursive: true });
const statePath = path.join(options.runDir, "log-audit-state.json");
const samplesPath = path.join(options.runDir, "log-audit.jsonl");
const journalArchivePath = path.join(options.runDir, "service-journal.jsonl");
const containerArchivePath = path.join(options.runDir, "container-logs.jsonl");
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopping = true;
  });
}

if (process.platform !== "linux") {
  throw new Error("external validation log audit is supported only on Linux");
}

if (options.finalOnly) {
  await audit(true);
} else {
  const deadlineAt = options.deadlineAt ?? Date.now() + options.durationSeconds * 1_000;
  while (!stopping && Date.now() < deadlineAt) {
    await audit(false);
    await sleepUntil(Math.min(deadlineAt, Date.now() + options.intervalSeconds * 1_000));
  }
  await audit(true);
}

async function audit(final) {
  const state = loadState();
  state.maxDroppedLogs ??= {};
  state.maxApplicationMetricDuplicateSeries ??= 0;
  state.maxApplicationMetricConflictingSeries ??= 0;
  state.prometheusCounterIncreases ??= {};
  state.prometheusCounterResets ??= 0;
  state.lastPrometheusCounters ??= {};
  state.filesystemSamples ??= [];
  state.captureErrors ??= [];
  const capture = await captureExternalLogs(state);
  const snapshot = await collectSnapshot(capture, final);
  if (!state.baseline) state.baseline = snapshot;
  state.last = snapshot;
  state.sampleCount += 1;
  for (const [processName, value] of Object.entries(snapshot.droppedLogs)) {
    if (typeof value === "number") {
      state.maxDroppedLogs[processName] = Math.max(state.maxDroppedLogs[processName] ?? 0, value);
    }
  }
  state.maxApplicationMetricDuplicateSeries = Math.max(
    state.maxApplicationMetricDuplicateSeries,
    snapshot.metrics.application.duplicateSeries,
  );
  state.maxApplicationMetricConflictingSeries = Math.max(
    state.maxApplicationMetricConflictingSeries,
    snapshot.metrics.application.conflictingSeries,
  );
  for (const [name, value] of Object.entries(snapshot.metrics.prometheus.counters)) {
    if (typeof value !== "number") continue;
    const previous = state.lastPrometheusCounters[name];
    if (typeof previous === "number") {
      if (value >= previous) {
        state.prometheusCounterIncreases[name] =
          (state.prometheusCounterIncreases[name] ?? 0) + value - previous;
      } else {
        state.prometheusCounterResets += 1;
      }
    }
    state.lastPrometheusCounters[name] = value;
  }
  state.filesystemSamples.push({ at: snapshot.at, ...snapshot.filesystem });
  state.filesystemSamples = state.filesystemSamples.slice(-2_100);
  state.captureErrors.push(...capture.errors);
  state.captureErrors = state.captureErrors.slice(-100);
  appendFileSync(samplesPath, `${JSON.stringify(snapshot)}\n`, "utf8");
  saveState(state);
  if (final) writeFinalReport(state);
}

async function captureExternalLogs(state) {
  const errors = [];
  let journalEntries = 0;
  const journalArgs = [];
  for (const unit of options.units) journalArgs.push("--unit", unit);
  journalArgs.push("--output=json", "--no-pager");
  if (state.journalCursor) journalArgs.push(`--after-cursor=${state.journalCursor}`);
  else journalArgs.push(`--since=@${Math.floor(state.startedAt / 1_000)}`);
  try {
    const output = await command("journalctl", journalArgs, 32 * 1024 * 1024);
    for (const line of output.stdout.split(/\r?\n/).filter(Boolean)) {
      const entry = JSON.parse(line);
      state.journalCursor = entry.__CURSOR ?? state.journalCursor;
      appendFileSync(journalArchivePath, `${JSON.stringify({
        realtimeTimestamp: entry.__REALTIME_TIMESTAMP,
        cursor: entry.__CURSOR,
        unit: entry._SYSTEMD_UNIT,
        priority: entry.PRIORITY,
        identifier: entry.SYSLOG_IDENTIFIER,
        pid: entry._PID,
        message: normalizeJournalMessage(entry.MESSAGE),
      })}\n`, "utf8");
      journalEntries += 1;
    }
  } catch (error) {
    errors.push(`journal capture failed: ${errorMessage(error)}`);
  }

  let containerLines = 0;
  const dockerBoundary = new Date().toISOString();
  for (const container of options.containers) {
    try {
      const output = await command("docker", [
        "logs",
        "--timestamps",
        "--since",
        state.dockerSince,
        "--until",
        dockerBoundary,
        container,
      ], 16 * 1024 * 1024);
      for (const line of `${output.stdout}${output.stderr}`.split(/\r?\n/).filter(Boolean)) {
        appendFileSync(containerArchivePath, `${JSON.stringify({
          capturedAt: new Date().toISOString(),
          container,
          line,
        })}\n`, "utf8");
        containerLines += 1;
      }
    } catch (error) {
      errors.push(`${container} log capture failed: ${errorMessage(error)}`);
    }
  }
  if (!errors.some((error) => error.includes("log capture failed"))) {
    state.dockerSince = dockerBoundary;
  }
  return { journalEntries, containerLines, errors };
}

async function collectSnapshot(capture, stableFilesystem) {
  const [filesystem, services, applicationMetrics, prometheusMetrics, journalBytes, runtimeBytes, runBytes, dockerBytes] =
    await Promise.all([
      filesystemUsage(options.runDir, stableFilesystem),
      serviceStates(),
      applicationMetricHealth(),
      prometheusMetricHealth(),
      directoriesSize(["/var/log/journal", "/run/log/journal"]),
      directorySize(options.runtimeLogDir),
      directorySize(options.runDir),
      dockerLogBytes(),
    ]);
  return {
    at: new Date().toISOString(),
    filesystem,
    bytes: {
      journal: journalBytes,
      runtime: runtimeBytes,
      evidence: runBytes,
      docker: dockerBytes,
    },
    services,
    droppedLogs: applicationMetrics.droppedLogs,
    metrics: {
      application: applicationMetrics.series,
      prometheus: prometheusMetrics,
    },
    capture,
  };
}

async function filesystemUsage(target, stable = false) {
  if (stable) {
    const samples = [];
    for (let index = 0; index < 5; index += 1) {
      samples.push(await filesystemUsage(target, false));
      if (index < 4) await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    return samples.sort((left, right) => left.usedBytes - right.usedBytes)[2];
  }
  const { stdout } = await command("df", ["-B1", "--output=size,used,avail,pcent,target", target]);
  const rows = stdout.trim().split(/\r?\n/);
  const values = rows.at(-1)?.trim().split(/\s+/) ?? [];
  return {
    totalBytes: Number(values[0] ?? 0),
    usedBytes: Number(values[1] ?? 0),
    availableBytes: Number(values[2] ?? 0),
    usedPercent: values[3],
    mount: values[4],
  };
}

async function serviceStates() {
  const result = {};
  for (const unit of options.units) {
    try {
      const { stdout } = await command("systemctl", [
        "show",
        unit,
        "--property=ActiveState,SubState,NRestarts,MainPID,MemoryCurrent,CPUUsageNSec",
      ]);
      result[unit] = Object.fromEntries(stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }));
    } catch (error) {
      result[unit] = { error: errorMessage(error) };
    }
  }
  return result;
}

async function applicationMetricHealth() {
  const droppedLogs = {};
  const byPort = {};
  let duplicateSeries = 0;
  let conflictingSeries = 0;
  for (const port of options.metricsPorts) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/metrics`, {
        signal: AbortSignal.timeout(2_000),
      });
      const metrics = await response.text();
      const matches = [...metrics.matchAll(/^tiangz_process_dropped_logs_total\{process="([^"]+)"\}\s+(\d+)$/gm)];
      for (const match of matches) droppedLogs[match[1]] = Number(match[2]);
      const health = inspectPrometheusSeries(metrics);
      byPort[port] = health;
      duplicateSeries += health.duplicateSeries;
      conflictingSeries += health.conflictingSeries;
    } catch (error) {
      const failure = { error: errorMessage(error) };
      droppedLogs[`port:${port}`] = failure;
      byPort[port] = failure;
    }
  }
  return {
    droppedLogs,
    series: { byPort, duplicateSeries, conflictingSeries },
  };
}

async function prometheusMetricHealth() {
  try {
    const response = await fetch(options.prometheusMetricsUrl, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const metrics = await response.text();
    return {
      counters: {
        duplicateTimestampSamples: metricFamilySum(
          metrics,
          "prometheus_target_scrapes_sample_duplicate_timestamp_total",
        ),
        outOfOrderSamples: metricFamilySum(
          metrics,
          "prometheus_target_scrapes_sample_out_of_order_total",
        ),
      },
    };
  } catch (error) {
    return { counters: {}, error: errorMessage(error) };
  }
}

function inspectPrometheusSeries(metrics) {
  const seen = new Map();
  let samples = 0;
  let duplicateSeries = 0;
  let conflictingSeries = 0;
  for (const line of metrics.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+([^\s]+)(?:\s+\d+)?$/);
    if (!match) continue;
    samples += 1;
    const key = `${match[1]}${match[2] ?? ""}`;
    const previous = seen.get(key);
    if (previous !== undefined) {
      duplicateSeries += 1;
      if (previous !== match[3]) conflictingSeries += 1;
    } else {
      seen.set(key, match[3]);
    }
  }
  return { samples, uniqueSeries: seen.size, duplicateSeries, conflictingSeries };
}

function metricFamilySum(metrics, name) {
  let total = 0;
  for (const line of metrics.split(/\r?\n/)) {
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^}]*\})?\s+([^\s]+)(?:\s+\d+)?$/);
    if (match?.[1] === name) total += Number(match[2]);
  }
  return total;
}

async function dockerLogBytes() {
  let total = 0;
  for (const container of options.containers) {
    try {
      const { stdout } = await command("docker", [
        "inspect",
        "--format",
        "{{.Id}}\t{{.HostConfig.LogConfig.Type}}\t{{.LogPath}}",
        container,
      ]);
      const [containerId, driver, logPath] = stdout.trim().split("\t");
      if (logPath && existsSync(logPath)) {
        total += statSync(logPath).size;
      } else if (driver === "local" && containerId) {
        // Docker's bounded `local` driver intentionally leaves `.LogPath` empty.
        // Count its private log directory so capacity projections do not silently
        // omit PostgreSQL and Redis logs (including rotated chunks).
        total += await directorySize(path.join(
          "/var/lib/docker/containers",
          containerId,
          "local-logs",
        ));
      }
    } catch {}
  }
  return total;
}

async function directorySize(target) {
  if (!existsSync(target)) return 0;
  const { stdout } = await command("du", ["-sb", target]);
  return Number(stdout.trim().split(/\s+/)[0] ?? 0);
}

async function directoriesSize(targets) {
  let total = 0;
  for (const target of targets) total += await directorySize(target);
  return total;
}

function writeFinalReport(state) {
  const baseline = state.baseline;
  const latest = state.last;
  const elapsedHours = Math.max(1 / 60, (
    Date.parse(latest.at) - Date.parse(baseline.at)
  ) / 3_600_000);
  const growth = {};
  let projectedKnownSevenDayGrowthBytes = 0;
  for (const name of ["journal", "runtime", "evidence", "docker"]) {
    const delta = Math.max(0, latest.bytes[name] - baseline.bytes[name]);
    const projected = Math.ceil(delta / elapsedHours * 168);
    growth[name] = { observedBytes: delta, bytesPerHour: Math.ceil(delta / elapsedHours), projectedSevenDayBytes: projected };
    projectedKnownSevenDayGrowthBytes += projected;
  }
  const filesystemDelta = Math.max(0, latest.filesystem.usedBytes - baseline.filesystem.usedBytes);
  const filesystemBytesPerHour = Math.max(0, theilSenBytesPerHour(state.filesystemSamples));
  const firstFilesystemSample = state.filesystemSamples[0];
  const transientFilesystemHeadroomBytes = Math.max(0, ...state.filesystemSamples.map((sample) => {
    const hours = Math.max(0, (Date.parse(sample.at) - Date.parse(firstFilesystemSample.at)) / 3_600_000);
    return sample.usedBytes - firstFilesystemSample.usedBytes - filesystemBytesPerHour * hours;
  }));
  const projectedFilesystemSevenDayGrowthBytes = Math.ceil(
    filesystemBytesPerHour * 168 + transientFilesystemHeadroomBytes,
  );
  growth.filesystemUsed = {
    observedBytes: filesystemDelta,
    bytesPerHour: Math.ceil(filesystemBytesPerHour),
    projectedSevenDayBytes: projectedFilesystemSevenDayGrowthBytes,
    estimator: "theil-sen",
    transientHeadroomBytes: Math.ceil(transientFilesystemHeadroomBytes),
  };
  // The whole-filesystem delta also covers PostgreSQL, Redis, Prometheus, Loki,
  // Tempo and anything else outside the explicitly measured log directories.
  // Use the larger projection: this is conservative without double-counting
  // every known directory on top of the filesystem-wide measurement.
  const projectedSevenDayGrowthBytes = Math.max(
    projectedKnownSevenDayGrowthBytes,
    projectedFilesystemSevenDayGrowthBytes,
  );
  const game = inspectGame(path.join(options.runDir, "game", "game-events.jsonl"));
  const faults = inspectFaults(path.join(options.runDir, "control", "fault-events.jsonl"));
  const soak = inspectSoak(path.join(options.runDir, "dbproxy-soak.log"));
  const droppedTotal = Object.values(state.maxDroppedLogs)
    .filter((value) => typeof value === "number")
    .reduce((sum, value) => sum + value, 0);
  const reserveAfterProjection = latest.filesystem.availableBytes - projectedSevenDayGrowthBytes;
  const applicationMetricsReadable = Object.values(latest.metrics.application.byPort)
    .every((value) => !value.error);
  const prometheusIngestionClean = !latest.metrics.prometheus.error &&
    state.prometheusCounterResets === 0 &&
    Number(state.prometheusCounterIncreases.duplicateTimestampSamples ?? 0) === 0 &&
    Number(state.prometheusCounterIncreases.outOfOrderSamples ?? 0) === 0;
  const checks = {
    noApplicationLogDrops: droppedTotal === 0,
    journalCaptureContinuous: state.captureErrors.length === 0,
    evidenceWithinBudget: latest.bytes.evidence <= options.evidenceBudgetBytes,
    sevenDayProjectionLeavesReserve: reserveAfterProjection >= options.diskReserveBytes,
    structuredEvidenceParseable: game.malformed === 0 && faults.malformed === 0,
    applicationMetricsReadable,
    noApplicationMetricDuplicates: state.maxApplicationMetricDuplicateSeries === 0 &&
      state.maxApplicationMetricConflictingSeries === 0,
    prometheusIngestionClean,
    gameRecoveryPassed: game.runnerCompleted && game.finalShardsHealthy,
    faultPlanPassed: faults.orchestratorCompleted && faults.actionsStarted > 0 &&
      faults.actionsStarted === faults.actionsPassed && faults.actionsFailed === 0 &&
      faults.baselineRecoveryFailures === 0,
    finalSoakReconciliationPassed: soak.final?.validation?.passed === true,
  };
  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    startedAt: new Date(state.startedAt).toISOString(),
    elapsedHours,
    sampleCount: state.sampleCount,
    status: Object.values(checks).every(Boolean) ? "passed" : "needs-review",
    checks,
    bytes: latest.bytes,
    filesystem: latest.filesystem,
    growth,
    projectedKnownSevenDayGrowthBytes,
    projectedFilesystemSevenDayGrowthBytes,
    projectedSevenDayGrowthBytes,
    projectedFreeBytesAfterSevenDays: reserveAfterProjection,
    droppedLogs: { latest: latest.droppedLogs, maximumObserved: state.maxDroppedLogs },
    metrics: {
      latest: latest.metrics,
      maximumApplicationDuplicateSeries: state.maxApplicationMetricDuplicateSeries,
      maximumApplicationConflictingSeries: state.maxApplicationMetricConflictingSeries,
      prometheusCounterIncreases: state.prometheusCounterIncreases,
      prometheusCounterResets: state.prometheusCounterResets,
    },
    captureErrors: state.captureErrors,
    evidence: { game, faults, soak },
  };
  atomicWrite(path.join(options.runDir, "log-budget-final.json"), report);
}

function readJsonLineEvents(file) {
  if (!existsSync(file)) {
    return { present: false, lines: 0, malformed: 0, eventTypes: {}, events: [] };
  }
  let lines = 0;
  let malformed = 0;
  const eventTypes = {};
  const events = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)) {
    lines += 1;
    try {
      const event = JSON.parse(line);
      events.push(event);
      const type = String(event.type ?? "unknown");
      eventTypes[type] = (eventTypes[type] ?? 0) + 1;
    } catch {
      malformed += 1;
    }
  }
  return { present: true, lines, malformed, eventTypes, events };
}

function inspectGame(file) {
  const parsed = readJsonLineEvents(file);
  const shards = new Map();
  let recoveryGenerationAdvances = 0;
  for (const event of parsed.events) {
    if (event.type === "shard_account_generation_advanced") {
      recoveryGenerationAdvances += 1;
    }
    if (event.type !== "shard_finished") continue;
    const current = shards.get(event.shard) ?? {
      shard: event.shard,
      completed: 0,
      healthy: 0,
      unhealthy: 0,
      everUnhealthy: false,
    };
    current.completed += Number(Boolean(event.completed));
    current.healthy += Number(Boolean(event.healthy));
    current.unhealthy += Number(!event.healthy);
    current.everUnhealthy ||= !event.healthy;
    current.last = {
      at: event.at,
      epoch: event.epoch,
      healthy: Boolean(event.healthy),
      mapId: event.mapId,
      enteredMapId: event.result?.enteredMapId,
      spatialMode: event.result?.movement?.spatialMode,
      healthIssues: event.healthIssues ?? [],
    };
    shards.set(event.shard, current);
  }
  const finalShards = [...shards.values()];
  const runner = parsed.events.findLast((event) =>
    event.type === "runner_completed" || event.type === "runner_stopped"
  );
  return {
    present: parsed.present,
    lines: parsed.lines,
    malformed: parsed.malformed,
    eventTypes: parsed.eventTypes,
    runnerCompleted: runner?.type === "runner_completed",
    runner,
    recoveryGenerationAdvances,
    finalShardsHealthy: finalShards.length > 0 && finalShards.every((item) => item.last?.healthy),
    unresolvedShards: finalShards.filter((item) => !item.last?.healthy).map((item) => item.shard),
    shards: finalShards,
  };
}

function inspectFaults(file) {
  const parsed = readJsonLineEvents(file);
  return {
    present: parsed.present,
    lines: parsed.lines,
    malformed: parsed.malformed,
    eventTypes: parsed.eventTypes,
    orchestratorCompleted: parsed.eventTypes.orchestrator_completed === 1,
    actionsStarted: parsed.eventTypes.action_started ?? 0,
    actionsPassed: parsed.eventTypes.action_passed ?? 0,
    actionsFailed: parsed.eventTypes.action_failed ?? 0,
    baselineRecoveryFailures: parsed.eventTypes.baseline_recovery_failed ?? 0,
  };
}

function inspectSoak(file) {
  if (!existsSync(file)) return { present: false };
  const text = readFileSync(file, "utf8");
  const finalLine = text.split(/\r?\n/).findLast((line) => line.startsWith("SOAK_FINAL "));
  let final;
  if (finalLine) {
    try {
      final = JSON.parse(finalLine.slice("SOAK_FINAL ".length));
    } catch {
      final = { malformed: true };
    }
  }
  return {
    present: true,
    bytes: Buffer.byteLength(text),
    reports: text.split(/\r?\n/).filter((line) => line.startsWith("SOAK_INTERVAL ")).length,
    final,
  };
}

function theilSenBytesPerHour(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return 0;
  const selected = evenlySample(samples, 512);
  const slopes = [];
  for (let left = 0; left < selected.length - 1; left += 1) {
    for (let right = left + 1; right < selected.length; right += 1) {
      const hours = (Date.parse(selected[right].at) - Date.parse(selected[left].at)) / 3_600_000;
      if (hours > 0) {
        slopes.push((selected[right].usedBytes - selected[left].usedBytes) / hours);
      }
    }
  }
  if (slopes.length === 0) return 0;
  slopes.sort((left, right) => left - right);
  const middle = Math.floor(slopes.length / 2);
  return slopes.length % 2 === 0
    ? (slopes[middle - 1] + slopes[middle]) / 2
    : slopes[middle];
}

function evenlySample(values, limit) {
  if (values.length <= limit) return values;
  const selected = [];
  let previousIndex = -1;
  for (let index = 0; index < limit; index += 1) {
    const sourceIndex = Math.round(index * (values.length - 1) / (limit - 1));
    if (sourceIndex !== previousIndex) selected.push(values[sourceIndex]);
    previousIndex = sourceIndex;
  }
  return selected;
}

function normalizeJournalMessage(message) {
  const text = Array.isArray(message)
    ? Buffer.from(message).toString("utf8")
    : typeof message === "string" ? message : JSON.stringify(message ?? "");
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function loadState() {
  if (existsSync(statePath)) return JSON.parse(readFileSync(statePath, "utf8"));
  const startedAt = Date.now();
  return {
    schemaVersion: 2,
    startedAt,
    dockerSince: new Date(startedAt).toISOString(),
    journalCursor: undefined,
    sampleCount: 0,
    maxDroppedLogs: {},
    maxApplicationMetricDuplicateSeries: 0,
    maxApplicationMetricConflictingSeries: 0,
    prometheusCounterIncreases: {},
    prometheusCounterResets: 0,
    lastPrometheusCounters: {},
    filesystemSamples: [],
    captureErrors: [],
    baseline: undefined,
    last: undefined,
  };
}

function saveState(state) {
  atomicWrite(statePath, state);
}

function atomicWrite(file, value) {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, file);
}

async function command(executable, args, maxBuffer = 4 * 1024 * 1024) {
  return execFileAsync(executable, args, { encoding: "utf8", maxBuffer });
}

function parseOptions(args) {
  const values = new Map();
  let finalOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--final") {
      finalOnly = true;
      continue;
    }
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`invalid argument near ${key ?? "<end>"}`);
    }
    values.set(key, value);
    index += 1;
  }
  const number = (name, fallback) => {
    const value = Number(values.get(name) ?? fallback);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be > 0`);
    return value;
  };
  const deadlineText = values.get("--deadline");
  const deadlineAt = deadlineText ? Date.parse(deadlineText) : undefined;
  if (deadlineText && !Number.isFinite(deadlineAt)) throw new Error("--deadline must be an ISO timestamp");
  return {
    finalOnly,
    deadlineAt,
    durationSeconds: number("--duration-seconds", 604_800),
    intervalSeconds: number("--interval-seconds", 300),
    runDir: path.resolve(values.get("--run-dir") ?? "/var/log/tiangz-chaos/current-validation"),
    runtimeLogDir: path.resolve(values.get("--runtime-log-dir") ?? "/var/log/tiangz-chaos/runtime"),
    evidenceBudgetBytes: number("--evidence-budget-bytes", 2 * 1024 ** 3),
    diskReserveBytes: number("--disk-reserve-bytes", 12 * 1024 ** 3),
    prometheusMetricsUrl: values.get("--prometheus-metrics-url") ?? "http://127.0.0.1:19090/metrics",
    metricsPorts: (values.get("--metrics-ports") ?? "17601,17602,17603,17604,17605,17606,17607,17608,17609,17610")
      .split(",").map(Number),
    units: (values.get("--units") ?? "tiangz-external.service,tiangz-dbproxy@1.service,tiangz-dbproxy@2.service,tiangz-overnight-game.service,tiangz-overnight-soak.service,tiangz-overnight-faults.service")
      .split(",").filter(Boolean),
    containers: (values.get("--containers") ?? "tiangz-dbproxy-postgres,tiangz-dbproxy-redis")
      .split(",").filter(Boolean),
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function sleepUntil(timestamp) {
  while (!stopping && Date.now() < timestamp) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, timestamp - Date.now())));
  }
}
