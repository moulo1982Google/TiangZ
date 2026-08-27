import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const options = parseOptions(process.argv.slice(2));
const actions = [
  "redis-outage",
  "map-1-crash",
  "postgres-outage",
  "map-2-crash",
  "dbproxy-1-crash",
  "dynamic-map-fallback",
  "dbproxy-2-crash",
  "aof-backlog-recovery",
  "storage-joint-outage",
];
const healthUrls = [
  17601, 17602, 17603, 17604, 17605,
  17606, 17607, 17608, 17609, 17610,
  9090, 9091,
].map((port) => `http://127.0.0.1:${port}/ready`);
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopping = true;
    if (options.execute) writeEvent({ type: "orchestrator_signal", signal });
  });
}

if (options.preflight) {
  await preflight();
} else if (!options.execute) {
  printDryRun();
} else {
  await run();
}

async function preflight() {
  if (process.platform !== "linux") throw new Error("fault preflight is supported only on Linux");
  await assertBaselineHealthy();
  const watcherPid = await runtimeMainPid();
  const children = {};
  for (const configName of [
    "login-mgr.json",
    "manager.json",
    "login-1.json",
    "login-2.json",
    "gate-1.json",
    "gate-2.json",
    "map-1.json",
    "map-2.json",
    "dungeon-1.json",
    "location.json",
  ]) {
    children[configName] = await findDirectChild(watcherPid, configName);
  }
  const dynamicProbe = path.resolve(root, options.dynamicProbe);
  if (!existsSync(dynamicProbe)) throw new Error(`missing dynamic fallback probe ${dynamicProbe}`);
  console.log(JSON.stringify({
    status: "ready",
    runtimeService: options.runtimeService,
    watcherPid,
    children,
    dynamicProbe,
    safetyMarkerPresent: existsSync(options.markerPath),
  }));
}

async function run() {
  if (process.platform !== "linux") throw new Error("fault execution is supported only on Linux");
  if (!existsSync(options.markerPath)) {
    throw new Error(`refusing fault injection without marker ${options.markerPath}`);
  }
  mkdirSync(options.runDir, { recursive: true });
  const state = loadOrCreateState();
  if (state.inFlightAction) {
    writeEvent({ type: "interrupted_action_detected", action: state.inFlightAction });
    await recoverBaseline();
    state.inFlightAction = undefined;
    state.nextActionAt = Date.now() + 300_000;
    saveState(state);
  }
  writeEvent({
    type: "orchestrator_started",
    resumed: state.actionIndex > 0,
    startedAt: state.startedAt,
    deadlineAt: state.deadlineAt,
    actionIndex: state.actionIndex,
    parameters: publicOptions(),
  });

  while (!stopping && Date.now() < state.deadlineAt) {
    await sleepUntil(Math.min(state.nextActionAt, state.deadlineAt));
    if (stopping || Date.now() >= state.deadlineAt) break;
    const planned = plannedAction(state);
    state.inFlightAction = planned;
    saveState(state);
    writeEvent({ type: "action_started", action: planned, actionIndex: state.actionIndex });
    try {
      await assertBaselineHealthy();
      await executeAction(planned);
      await assertBaselineHealthy();
      writeEvent({ type: "action_passed", action: planned, actionIndex: state.actionIndex });
      state.passedActions += 1;
    } catch (error) {
      writeEvent({
        type: "action_failed",
        action: planned,
        actionIndex: state.actionIndex,
        error: errorMessage(error),
      });
      state.failedActions += 1;
      await recoverBaseline().catch((recoveryError) => writeEvent({
        type: "baseline_recovery_failed",
        error: errorMessage(recoveryError),
      }));
    }
    state.actionIndex += 1;
    state.inFlightAction = undefined;
    state.rngState = nextRandom(state.rngState);
    const ratio = state.rngState / 0xffff_ffff;
    const gapMs = options.minGapMinutes * 60_000 +
      ratio * (options.maxGapMinutes - options.minGapMinutes) * 60_000;
    state.nextActionAt = Date.now() + Math.round(gapMs);
    saveState(state);
  }
  writeEvent({
    type: stopping ? "orchestrator_stopped" : "orchestrator_completed",
    actionIndex: state.actionIndex,
    passedActions: state.passedActions,
    failedActions: state.failedActions,
  });
}

function plannedAction(state) {
  const candidate = actions[state.actionIndex % actions.length];
  const elapsedHours = (Date.now() - state.startedAt) / 3_600_000;
  return candidate === "storage-joint-outage" && elapsedHours < options.jointAfterHours
    ? "redis-outage"
    : candidate;
}

async function executeAction(action) {
  switch (action) {
    case "redis-outage":
      await containerOutage("tiangz-dbproxy-redis", options.redisOutageSeconds);
      return;
    case "postgres-outage":
      await containerOutage("tiangz-dbproxy-postgres", options.postgresOutageSeconds);
      return;
    case "storage-joint-outage":
      await jointStorageOutage();
      return;
    case "aof-backlog-recovery":
      await validateAofBacklogRecovery();
      return;
    case "map-1-crash":
      await crashRuntimeChild("map-1.json", "http://127.0.0.1:17606/ready", 30_000);
      return;
    case "map-2-crash":
      await crashRuntimeChild("map-2.json", "http://127.0.0.1:17607/ready", 30_000);
      return;
    case "dbproxy-1-crash":
      await crashSystemdPeer("tiangz-dbproxy@1.service", "http://127.0.0.1:9090/ready");
      return;
    case "dbproxy-2-crash":
      await crashSystemdPeer("tiangz-dbproxy@2.service", "http://127.0.0.1:9091/ready");
      return;
    case "dynamic-map-fallback":
      await validateDynamicMapFallback();
      return;
    default:
      throw new Error(`unknown action ${action}`);
  }
}

async function containerOutage(container, outageSeconds) {
  await command("docker", ["stop", "--time", "0", container]);
  await sleepResponsive(outageSeconds * 1000);
  await command("docker", ["start", container]);
  await waitContainerHealthy(container, 180_000);
  await waitAllUrls(["http://127.0.0.1:9090/ready", "http://127.0.0.1:9091/ready"], 180_000);
}

async function jointStorageOutage() {
  await Promise.all([
    command("docker", ["stop", "--time", "0", "tiangz-dbproxy-redis"]),
    command("docker", ["stop", "--time", "0", "tiangz-dbproxy-postgres"]),
  ]);
  await sleepResponsive(options.jointOutageSeconds * 1000);
  await Promise.all([
    command("docker", ["start", "tiangz-dbproxy-redis"]),
    command("docker", ["start", "tiangz-dbproxy-postgres"]),
  ]);
  await Promise.all([
    waitContainerHealthy("tiangz-dbproxy-redis", 180_000),
    waitContainerHealthy("tiangz-dbproxy-postgres", 180_000),
  ]);
  await waitAllUrls(["http://127.0.0.1:9090/ready", "http://127.0.0.1:9091/ready"], 180_000);
}

async function validateAofBacklogRecovery() {
  await command("docker", ["stop", "--time", "0", "tiangz-dbproxy-postgres"]);
  const beforeRedisRestart = await waitMetric(
    "dbproxy_backlog_pending",
    (values) => Math.max(...values) >= 1,
    120_000,
  );
  await command("docker", ["stop", "--time", "0", "tiangz-dbproxy-redis"]);
  await sleepResponsive(15_000);
  await command("docker", ["start", "tiangz-dbproxy-redis"]);
  await waitContainerHealthy("tiangz-dbproxy-redis", 120_000);
  const afterRedisRestart = await waitMetric(
    "dbproxy_backlog_pending",
    (values) => Math.max(...values) >= 1,
    120_000,
  );
  await command("docker", ["start", "tiangz-dbproxy-postgres"]);
  await waitContainerHealthy("tiangz-dbproxy-postgres", 180_000);
  await waitAllUrls(["http://127.0.0.1:9090/ready", "http://127.0.0.1:9091/ready"], 180_000);
  const drained = await waitMetric(
    "dbproxy_backlog_pending",
    (values) => values.every((value) => value === 0),
    300_000,
  );
  writeEvent({
    type: "aof_backlog_recovery_passed",
    beforeRedisRestart,
    afterRedisRestart,
    drained,
  });
}

async function crashRuntimeChild(configName, readyUrl, timeoutMs) {
  const parentPid = await runtimeMainPid();
  const previousPid = await findDirectChild(parentPid, configName);
  process.kill(previousPid, "SIGKILL");
  const replacementPid = await waitChildReplacement(parentPid, configName, previousPid, timeoutMs);
  await waitAllUrls([readyUrl], timeoutMs);
  writeEvent({ type: "runtime_child_replaced", configName, previousPid, replacementPid });
}

async function crashSystemdPeer(service, readyUrl) {
  const previousPid = await serviceMainPid(service);
  await command("systemctl", ["kill", "--kill-who=main", "--signal=SIGKILL", service]);
  const deadline = Date.now() + 60_000;
  let replacementPid = 0;
  while (Date.now() < deadline) {
    replacementPid = await serviceMainPid(service).catch(() => 0);
    if (replacementPid > 0 && replacementPid !== previousPid) break;
    await sleep(250);
  }
  if (!replacementPid || replacementPid === previousPid) {
    throw new Error(`${service} did not replace pid ${previousPid}`);
  }
  await waitAllUrls([readyUrl], 120_000);
  writeEvent({ type: "dbproxy_peer_replaced", service, previousPid, replacementPid });
}

async function validateDynamicMapFallback() {
  const probePath = path.resolve(root, options.dynamicProbe);
  if (!existsSync(probePath)) throw new Error(`missing dynamic fallback probe ${probePath}`);
  const probe = spawn(process.execPath, [
    probePath,
    "--login-host", "127.0.0.1",
    "--login-port", "27001",
    "--account-prefix", "dynchaos_",
  ], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  const capture = (chunk) => {
    const text = chunk.toString("utf8");
    output = (output + text).slice(-128 * 1024);
    appendFileSync(path.join(options.runDir, "dynamic-probe.log"), text, "utf8");
  };
  probe.stdout.on("data", capture);
  probe.stderr.on("data", capture);
  try {
    const ready = await waitForMarker(probe, () => output, "DYNAMIC_FALLBACK_READY", 60_000);
    const parentPid = await runtimeMainPid();
    const managerPid = await findDirectChild(parentPid, "manager.json");
    const dungeonPid = await findDirectChild(parentPid, "dungeon-1.json");
    process.kill(managerPid, "SIGKILL");
    process.kill(dungeonPid, "SIGKILL");
    const restartedManagerPid = await waitChildReplacement(
      parentPid,
      "manager.json",
      managerPid,
      30_000,
    );
    await waitAllUrls(["http://127.0.0.1:17609/ready"], 30_000);
    await sleepResponsive(21_000);
    probe.stdin.write("continue\n");
    const passed = await waitForMarker(probe, () => output, "DYNAMIC_FALLBACK_PASSED", 60_000);
    const code = await waitForExit(probe, 15_000);
    if (code !== 0) throw new Error(`dynamic fallback probe exited ${code}: ${output}`);
    const restartedDungeonPid = await waitChildReplacement(
      parentPid,
      "dungeon-1.json",
      dungeonPid,
      45_000,
    );
    await waitAllUrls(["http://127.0.0.1:17610/ready"], 30_000);
    writeEvent({
      type: "dynamic_fallback_passed",
      previousMapInstanceId: ready.mapInstanceId,
      safeMapInstanceId: passed.safeMapInstanceId,
      managerPid,
      restartedManagerPid,
      dungeonPid,
      restartedDungeonPid,
    });
  } finally {
    if (probe.exitCode === null) probe.kill("SIGKILL");
  }
}

async function assertBaselineHealthy() {
  await Promise.all([
    waitContainerHealthy("tiangz-dbproxy-redis", 30_000),
    waitContainerHealthy("tiangz-dbproxy-postgres", 30_000),
  ]);
  for (const service of [
    options.runtimeService,
    "tiangz-dbproxy@1.service",
    "tiangz-dbproxy@2.service",
  ]) {
    const active = (await command("systemctl", ["is-active", service])).trim();
    if (active !== "active") throw new Error(`${service} is ${active}`);
  }
  await waitAllUrls(healthUrls, 60_000);
}

async function recoverBaseline() {
  for (const container of ["tiangz-dbproxy-redis", "tiangz-dbproxy-postgres"]) {
    await command("docker", ["start", container], true);
  }
  for (const service of [
    "tiangz-dbproxy@1.service",
    "tiangz-dbproxy@2.service",
    options.runtimeService,
  ]) {
    await command("systemctl", ["start", service], true);
  }
  await assertBaselineHealthy();
  writeEvent({ type: "baseline_recovered" });
}

async function waitContainerHealthy(container, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await command("docker", [
      "inspect",
      "--format",
      "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
      container,
    ], true);
    if (state.trim() === "running|healthy" || state.trim() === "running|none") return;
    await sleep(500);
  }
  throw new Error(`${container} did not become healthy`);
}

async function waitAllUrls(urls, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(urls);
  while (pending.size > 0 && Date.now() < deadline) {
    for (const url of [...pending]) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) pending.delete(url);
      } catch {}
    }
    if (pending.size > 0) await sleep(500);
  }
  if (pending.size > 0) throw new Error(`health endpoints not ready: ${[...pending].join(", ")}`);
}

async function waitMetric(name, predicate, timeoutMs) {
  const urls = ["http://127.0.0.1:9090/metrics", "http://127.0.0.1:9091/metrics"];
  const deadline = Date.now() + timeoutMs;
  let latest = [];
  while (Date.now() < deadline) {
    latest = [];
    for (const url of urls) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        const text = await response.text();
        const match = new RegExp(`^${name}\\s+([-+0-9.eE]+)$`, "m").exec(text);
        if (match) latest.push(Number(match[1]));
      } catch {}
    }
    if (latest.length === urls.length && predicate(latest)) return latest;
    await sleep(1_000);
  }
  throw new Error(`${name} did not reach the expected state; latest=${JSON.stringify(latest)}`);
}

async function runtimeMainPid() {
  const servicePid = await serviceMainPid(options.runtimeService);
  const rows = await processTable();
  const serviceRow = rows.find((row) => row.pid === servicePid);
  if (serviceRow && isRuntimeWatcher(serviceRow)) return servicePid;

  const childrenByParent = new Map();
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? [];
    children.push(row);
    childrenByParent.set(row.ppid, children);
  }
  const candidates = [];
  const pending = [...(childrenByParent.get(servicePid) ?? [])];
  while (pending.length > 0) {
    const row = pending.shift();
    if (isRuntimeWatcher(row)) candidates.push(row);
    pending.push(...(childrenByParent.get(row.pid) ?? []));
  }
  if (candidates.length !== 1) {
    throw new Error(
      `expected one TiangZ Watcher below ${options.runtimeService} pid ${servicePid}: ` +
      JSON.stringify(candidates),
    );
  }
  return candidates[0].pid;
}

async function processTable() {
  const output = await command("ps", ["-eo", "pid=,ppid=,comm=,args="]);
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) throw new Error(`cannot parse process row: ${line}`);
    return {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3],
      args: match[4],
    };
  });
}

function isRuntimeWatcher(row) {
  const argumentsList = row.args.trim().split(/\s+/);
  return path.basename(row.command) === "TiangZ" &&
    argumentsList.some((argument) => path.basename(argument) === "StartMachine.json");
}

async function serviceMainPid(service) {
  const value = Number((await command("systemctl", ["show", "--property", "MainPID", "--value", service])).trim());
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${service} has no main pid`);
  return value;
}

async function directChildren(parentPid) {
  const output = await command("ps", ["-o", "pid=,args=", "--ppid", String(parentPid)]);
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return { pid: Number(match?.[1]), args: match?.[2] ?? "" };
  });
}

async function findDirectChild(parentPid, configName) {
  const rows = await directChildren(parentPid);
  const matches = rows.filter((row) => row.args.split(/\s+/).some(
    (argument) => path.basename(argument) === configName,
  ));
  if (matches.length !== 1) {
    throw new Error(`expected one ${configName} child under ${parentPid}: ${JSON.stringify(rows)}`);
  }
  return matches[0].pid;
}

async function waitChildReplacement(parentPid, configName, previousPid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await directChildren(parentPid);
    const replacement = rows.find((row) => row.pid !== previousPid && row.args.split(/\s+/).some(
      (argument) => path.basename(argument) === configName,
    ));
    if (replacement) return replacement.pid;
    await sleep(100);
  }
  throw new Error(`${configName} did not replace pid ${previousPid}`);
}

function waitForMarker(child, output, marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const inspect = () => {
      const line = output().split(/\r?\n/).find((entry) => entry.startsWith(`${marker} `));
      if (line) return resolve(JSON.parse(line.slice(marker.length + 1)));
      if (child.exitCode !== null) return reject(new Error(`probe exited before ${marker}: ${output()}`));
      if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${marker}: ${output()}`));
      setTimeout(inspect, 50);
    };
    inspect();
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("probe did not exit")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

async function command(executable, args, allowFailure = false) {
  try {
    const { stdout, stderr } = await execFileAsync(executable, args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    if (stderr?.trim()) writeEvent({ type: "command_stderr", executable, args, stderr: stderr.trim() });
    return stdout;
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

function loadOrCreateState() {
  const statePath = path.join(options.runDir, "fault-state.json");
  if (existsSync(statePath)) {
    const loaded = JSON.parse(readFileSync(statePath, "utf8"));
    if (loaded.parametersFingerprint !== parametersFingerprint()) {
      throw new Error(`existing ${statePath} belongs to different parameters`);
    }
    return loaded;
  }
  const startedAt = Date.now();
  return {
    schemaVersion: 1,
    parametersFingerprint: parametersFingerprint(),
    startedAt,
    deadlineAt: startedAt + options.durationHours * 3_600_000,
    nextActionAt: startedAt + options.warmupMinutes * 60_000,
    actionIndex: 0,
    passedActions: 0,
    failedActions: 0,
    rngState: options.seed >>> 0,
    inFlightAction: undefined,
  };
}

function saveState(state) {
  const statePath = path.join(options.runDir, "fault-state.json");
  const temporary = `${statePath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temporary, statePath);
}

function writeEvent(event) {
  mkdirSync(options.runDir, { recursive: true });
  appendFileSync(
    path.join(options.runDir, "fault-events.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
    "utf8",
  );
}

function printDryRun() {
  let at = Date.now() + options.warmupMinutes * 60_000;
  let rngState = options.seed >>> 0;
  console.log("[chaos-fault] dry run; add --execute and create the safety marker to inject faults");
  for (let index = 0; index < 16; index += 1) {
    const elapsedHours = (at - Date.now()) / 3_600_000;
    const candidate = actions[index % actions.length];
    const action = candidate === "storage-joint-outage" && elapsedHours < options.jointAfterHours
      ? "redis-outage"
      : candidate;
    console.log(`${new Date(at).toISOString()} ${action}`);
    rngState = nextRandom(rngState);
    const ratio = rngState / 0xffff_ffff;
    at += Math.round((
      options.minGapMinutes + ratio * (options.maxGapMinutes - options.minGapMinutes)
    ) * 60_000);
  }
}

function publicOptions() {
  return {
    durationHours: options.durationHours,
    warmupMinutes: options.warmupMinutes,
    minGapMinutes: options.minGapMinutes,
    maxGapMinutes: options.maxGapMinutes,
    redisOutageSeconds: options.redisOutageSeconds,
    postgresOutageSeconds: options.postgresOutageSeconds,
    jointOutageSeconds: options.jointOutageSeconds,
    jointAfterHours: options.jointAfterHours,
    seed: options.seed,
    runtimeService: options.runtimeService,
    dynamicProbe: options.dynamicProbe,
  };
}

function parametersFingerprint() {
  return JSON.stringify(publicOptions());
}

function parseOptions(args) {
  const values = new Map();
  let execute = false;
  let preflight = false;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--execute") {
      execute = true;
      continue;
    }
    if (key === "--preflight") {
      preflight = true;
      continue;
    }
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`invalid argument near ${key ?? "<end>"}`);
    }
    values.set(key, value);
    index += 1;
  }
  const positive = (name, fallback) => {
    const value = Number(values.get(name) ?? fallback);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be > 0`);
    return value;
  };
  const minGapMinutes = positive("--min-gap-minutes", 45);
  const maxGapMinutes = positive("--max-gap-minutes", 120);
  if (maxGapMinutes < minGapMinutes) throw new Error("max gap must be >= min gap");
  if (execute && preflight) throw new Error("--execute and --preflight are mutually exclusive");
  return {
    execute,
    preflight,
    durationHours: positive("--duration-hours", 168),
    warmupMinutes: positive("--warmup-minutes", 30),
    minGapMinutes,
    maxGapMinutes,
    redisOutageSeconds: positive("--redis-outage-seconds", 30),
    postgresOutageSeconds: positive("--postgres-outage-seconds", 45),
    jointOutageSeconds: positive("--joint-outage-seconds", 45),
    jointAfterHours: positive("--joint-after-hours", 24),
    seed: Math.floor(positive("--seed", 2_026_082_7)),
    runDir: path.resolve(values.get("--run-dir") ?? "/var/log/tiangz-chaos/control"),
    markerPath: path.resolve(values.get("--marker") ?? "/etc/tiangz/chaos-enabled"),
    runtimeService: values.get("--runtime-service") ?? "tiangz-external.service",
    dynamicProbe: values.get("--dynamic-probe") ?? "dist/dynamic_map_fallback_probe.cjs",
  };
}

function nextRandom(state) {
  return (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
}

function errorMessage(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

async function sleepUntil(timestamp) {
  while (!stopping && Date.now() < timestamp) {
    await sleep(Math.min(30_000, timestamp - Date.now()));
  }
}

async function sleepResponsive(ms) {
  const deadline = Date.now() + ms;
  await sleepUntil(deadline);
  if (stopping) throw new Error("fault action interrupted by signal");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
