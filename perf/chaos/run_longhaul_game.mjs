import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const options = parseOptions(process.argv.slice(2));
const client = path.join(root, "dist", "full_chain_load_test.cjs");
if (!existsSync(client)) {
  throw new Error(`missing ${client}; run npm run build:perf:full-chain first`);
}

mkdirSync(options.runDir, { recursive: true });
const statePath = path.join(options.runDir, "state.json");
const eventsPath = path.join(options.runDir, "game-events.jsonl");
const driverLogPath = path.join(options.runDir, "game-driver.log");
const driverLogFd = openSync(driverLogPath, "a");
const activeChildren = new Set();
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopping = true;
    writeEvent({ type: "runner_signal", signal });
    for (const child of activeChildren) child.kill("SIGTERM");
  });
}

const state = loadOrCreateState();
writeEvent({
  type: "runner_started",
  resumed: state.epoch > 0,
  startedAt: state.startedAt,
  deadlineAt: state.deadlineAt,
  parameters: publicOptions(),
});

try {
  while (!stopping && Date.now() < state.deadlineAt) {
    state.epoch += 1;
    saveState();
    const remainingSeconds = Math.floor((state.deadlineAt - Date.now()) / 1000);
    const durationSeconds = Math.min(options.sessionSeconds, remainingSeconds - options.warmupSeconds);
    if (durationSeconds <= 0) break;
    const epochStartedAt = Date.now();
    const operationPrefix = `${options.accountPrefix}:${state.epoch.toString(36)}`;
    const firstPlayers = Math.ceil(options.players / 2);
    const shards = [
      {
        name: "map-1",
        mapId: 1,
        spatialMode: "grid2d",
        players: firstPlayers,
        suffix: "a",
        shard: 1,
      },
      {
        name: "map-100",
        mapId: 100,
        spatialMode: "navmesh3d",
        players: options.players - firstPlayers,
        suffix: "b",
        shard: 2,
      },
    ].filter((item) => item.players > 0);

    writeEvent({
      type: "epoch_started",
      epoch: state.epoch,
      durationSeconds,
      remainingSeconds,
    });
    const outcomes = await Promise.all(shards.map((shard) => runShard(
      shard,
      durationSeconds,
      operationPrefix,
    )));
    const succeeded = outcomes.filter((item) => item.ok).length;
    const failed = outcomes.length - succeeded;
    state.successfulShards += succeeded;
    state.failedShards += failed;
    state.lastCompletedAt = Date.now();
    saveState();
    writeEvent({
      type: "epoch_finished",
      epoch: state.epoch,
      elapsedSeconds: (Date.now() - epochStartedAt) / 1000,
      succeeded,
      failed,
    });
    console.log(
      `[chaos-game] epoch=${state.epoch} shards_ok=${succeeded}/${outcomes.length} ` +
      `remaining=${Math.max(0, Math.round((state.deadlineAt - Date.now()) / 1000))}s`,
    );
    if (!stopping && Date.now() < state.deadlineAt) {
      await sleep(failed > 0 ? options.failureRetrySeconds * 1000 : options.epochGapSeconds * 1000);
    }
  }
  writeEvent({
    type: stopping ? "runner_stopped" : "runner_completed",
    epoch: state.epoch,
    successfulShards: state.successfulShards,
    failedShards: state.failedShards,
  });
} finally {
  closeSync(driverLogFd);
}

async function runShard(shard, durationSeconds, operationPrefix) {
  const args = [
    client,
    "--host", options.host,
    "--manager-port", String(options.managerPort),
    "--players", String(shard.players),
    "--setup-concurrency", String(Math.min(options.setupConcurrency, shard.players)),
    "--duration", String(durationSeconds),
    "--warmup", String(options.warmupSeconds),
    "--timeout", String(options.timeoutMs),
    "--movement-timeout", String(options.movementTimeoutMs),
    "--move-rate", String(options.moveRate),
    "--probe-rate", String(options.probeRate),
    "--business-rate", String(options.businessRate),
    "--map-id", String(shard.mapId),
    "--account-prefix", `${options.accountPrefix}${shard.suffix}`,
    "--operation-prefix", operationPrefix,
    "--reuse-accounts",
    "--label", `${options.label}-s${shard.shard}`,
  ];
  const startedAt = Date.now();
  const hardTimeoutMs = (
    options.setupTimeoutSeconds + options.warmupSeconds + durationSeconds + 30
  ) * 1000;
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  activeChildren.add(child);
  let outputTail = "";
  const capture = (chunk) => {
    const text = chunk.toString("utf8");
    outputTail = (outputTail + text).slice(-64 * 1024);
    appendFileSync(driverLogFd, `[${new Date().toISOString()}][${shard.name}] ${text}`);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const timer = setTimeout(() => {
    capture(`hard timeout after ${hardTimeoutMs}ms\n`);
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  }, hardTimeoutMs);

  const { code, signal } = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
  }).finally(() => {
    clearTimeout(timer);
    activeChildren.delete(child);
  });
  const resultLine = outputTail.split(/\r?\n/).findLast((line) => line.startsWith("RESULT_JSON "));
  let result;
  if (resultLine) {
    try {
      result = JSON.parse(resultLine.slice("RESULT_JSON ".length));
      if (result?.loadGenerator) delete result.loadGenerator.memoryTrendSamples;
    } catch {
      result = undefined;
    }
  }
  const completed = code === 0 && Boolean(result);
  const healthIssues = completed ? evaluateHealth(shard, result) : [
    result ? `load generator exited with code=${code} signal=${signal}` : "missing RESULT_JSON",
  ];
  const healthy = completed && healthIssues.length === 0;
  const event = {
    type: "shard_finished",
    epoch: state.epoch,
    shard: shard.name,
    mapId: shard.mapId,
    players: shard.players,
    ok: healthy,
    completed,
    healthy,
    healthIssues,
    code,
    signal,
    elapsedSeconds: (Date.now() - startedAt) / 1000,
    result,
    errorTail: healthy ? undefined : outputTail.slice(-8 * 1024),
  };
  writeEvent(event);
  return event;
}

function evaluateHealth(shard, result) {
  const issues = [];
  if (result.players !== shard.players) {
    issues.push(`players=${result.players}, expected=${shard.players}`);
  }
  if (result.targetMapId !== shard.mapId) {
    issues.push(`mapId=${result.targetMapId}, expected=${shard.mapId}`);
  }
  if (result.setup?.count !== shard.players) {
    issues.push(`setup.count=${result.setup?.count}, expected=${shard.players}`);
  }
  if (result.movement?.spatialMode !== shard.spatialMode) {
    issues.push(
      `movement.spatialMode=${result.movement?.spatialMode}, expected=${shard.spatialMode}`,
    );
  }
  if (options.moveRate > 0) {
    const sent = Number(result.movement?.count ?? 0);
    const acknowledged = Number(result.movement?.acknowledged ?? 0);
    if (sent <= 0) issues.push("movement sent no measured requests");
    if (Number(result.movement?.errors ?? 0) !== 0) {
      issues.push(`movement.errors=${result.movement?.errors}`);
    }
    if (sent > 0 && acknowledged / sent < 0.99) {
      issues.push(`movement acknowledgement ratio=${(acknowledged / sent).toFixed(4)}`);
    }
    if (Number(result.movement?.entityMovePushes ?? 0) <= 0) {
      issues.push("movement received no authoritative pushes");
    }
  }
  if (options.probeRate > 0) {
    if (Number(result.probe?.count ?? 0) <= 0) issues.push("probe sent no measured requests");
    if (Number(result.probe?.errors ?? 0) !== 0) {
      issues.push(`probe.errors=${result.probe?.errors}`);
    }
  }
  if (options.businessRate > 0) {
    if (Number(result.business?.count ?? 0) <= 0) {
      issues.push("business sent no measured requests");
    }
    if (Number(result.business?.transportErrors ?? 0) !== 0) {
      issues.push(`business.transportErrors=${result.business?.transportErrors}`);
    }
  }
  return issues;
}

function loadOrCreateState() {
  if (existsSync(statePath)) {
    const loaded = JSON.parse(readFileSync(statePath, "utf8"));
    if (loaded.schemaVersion !== 2) {
      throw new Error(`existing ${statePath} uses unsupported schema ${loaded.schemaVersion}`);
    }
    if (loaded.parametersFingerprint !== parametersFingerprint()) {
      throw new Error(`existing ${statePath} belongs to different parameters`);
    }
    return loaded;
  }
  const startedAt = Date.now();
  return {
    schemaVersion: 2,
    parametersFingerprint: parametersFingerprint(),
    startedAt,
    deadlineAt: startedAt + options.totalHours * 3_600_000,
    epoch: 0,
    successfulShards: 0,
    failedShards: 0,
    lastCompletedAt: undefined,
  };
}

function saveState() {
  writeFileSync(`${statePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(`${statePath}.tmp`, statePath);
}

function writeEvent(event) {
  appendFileSync(eventsPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8");
}

function publicOptions() {
  return {
    host: options.host,
    managerPort: options.managerPort,
    players: options.players,
    totalHours: options.totalHours,
    sessionSeconds: options.sessionSeconds,
    warmupSeconds: options.warmupSeconds,
    setupConcurrency: options.setupConcurrency,
    setupTimeoutSeconds: options.setupTimeoutSeconds,
    timeoutMs: options.timeoutMs,
    movementTimeoutMs: options.movementTimeoutMs,
    moveRate: options.moveRate,
    probeRate: options.probeRate,
    businessRate: options.businessRate,
    failureRetrySeconds: options.failureRetrySeconds,
    epochGapSeconds: options.epochGapSeconds,
    accountPrefix: options.accountPrefix,
    label: options.label,
  };
}

function parametersFingerprint() {
  return JSON.stringify(publicOptions());
}

function parseOptions(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key?.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
    values.set(key, value);
    index += 1;
  }
  const positive = (name, fallback) => {
    const value = Number(values.get(name) ?? fallback);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be > 0`);
    return value;
  };
  const nonNegative = (name, fallback) => {
    const value = Number(values.get(name) ?? fallback);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be >= 0`);
    return value;
  };
  const accountPrefix = values.get("--account-prefix") ?? "chaos7d";
  if (!/^[A-Za-z0-9_-]{1,26}$/.test(accountPrefix)) {
    throw new Error("--account-prefix must use 1-26 ASCII letters, digits, _ or -");
  }
  const defaultRunDir = path.join(root, "perf", "results", "chaos", timestamp());
  return {
    host: values.get("--host") ?? "127.0.0.1",
    managerPort: Math.floor(positive("--manager-port", 27000)),
    players: Math.floor(positive("--players", 500)),
    totalHours: positive("--total-hours", 168),
    sessionSeconds: Math.floor(positive("--session-seconds", 300)),
    warmupSeconds: Math.floor(nonNegative("--warmup-seconds", 10)),
    setupConcurrency: Math.floor(positive("--setup-concurrency", 32)),
    setupTimeoutSeconds: Math.floor(positive("--setup-timeout-seconds", 180)),
    timeoutMs: Math.floor(positive("--timeout-ms", 15_000)),
    movementTimeoutMs: Math.floor(positive("--movement-timeout-ms", 5_000)),
    moveRate: nonNegative("--move-rate", 1),
    probeRate: nonNegative("--probe-rate", 0.05),
    businessRate: nonNegative("--business-rate", 0.02),
    failureRetrySeconds: positive("--failure-retry-seconds", 15),
    epochGapSeconds: nonNegative("--epoch-gap-seconds", 2),
    accountPrefix,
    label: values.get("--label") ?? "external-chaos",
    runDir: path.resolve(values.get("--run-dir") ?? defaultRunDir),
  };
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
