import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, cpSync, copyFileSync,
  existsSync, readdirSync, statSync, statfsSync } from "node:fs";
import { createHash } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { root, dbRoot, loadEnvironment, verifyContainers, sql, redis, command,
  containers, runtimeDatabase, contractDatabase, verifyCachePersistence } from "./local_validation_env.mjs";
import { cpuTotals, cpuPercent, resourceViolation, hasDroppedLogs, memoryPressure, cpuPressure } from "./local_validation_resources.mjs";

const mode = process.argv[2];
const base = path.resolve(root, "../.build-tmp/local-validation");
const runDir = path.resolve(process.argv[3] ?? path.join(base, new Date().toISOString().replace(/[:.]/g, "-")));
if (!runDir.startsWith(base + path.sep)) throw new Error("run directory must be below the dedicated validation root");
loadEnvironment();
process.env.TOKIO_WORKER_THREADS = "2";
verifyContainers();
verifyCachePersistence();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const children = new Set();
const services = new Map();
const runtimeSpecs = [["front", 17601], ["map1", 17606], ["map2", 17607], ["dungeon", 17609], ["location", 17610]];
let stopping = false;
let phase = "setup";
let sequence = 0;
let fatal;
let sampleTimer;
let previousCpu;
let previousSampleAt;
let previousMemory;
let nextPressureSnapshotAt = 0;
let nextDetailedSampleAt = 0;
let diskSample;
let metricsPending = false;
let nextMetricsAt = 0;
let diagnosticPromise;
const runId = path.basename(runDir).replace(/[^a-zA-Z0-9]/g, "").slice(0, 24).toLowerCase();
const event = (type, details = {}) => {
  const value = { at: new Date().toISOString(), type, phase, ...details };
  appendFileSync(path.join(runDir, "events.jsonl"), JSON.stringify(value) + "\n");
  console.log(JSON.stringify(value));
};
const json = file => JSON.parse(readFileSync(file, "utf8"));
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
function managed(name, executable, args, cwd = runDir, env = {}) {
  const child = spawn(executable, args, { cwd, env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  children.add(child);
  const log = path.join(runDir, `${name}.log`);
  let tail = "";
  let pendingLine = "";
  let size = 0;
  for (const pipe of [child.stdout, child.stderr]) pipe.on("data", chunk => {
    size += chunk.length;
    appendFileSync(log, chunk);
    tail = (tail + chunk.toString()).slice(-128 * 1024);
    if (name === "persistence-soak") {
      pendingLine += chunk.toString();
      const lines = pendingLine.split(/\r?\n/);
      pendingLine = lines.pop().slice(-128 * 1024);
      for (const line of lines) {
        if (line.startsWith("SOAK_CONTRACT_ERROR ")) {
          fatal = new Error("permanent persistence contract error; see persistence-soak.log");
        } else if (line.startsWith("SOAK_INTERVAL ")) {
          const total = JSON.parse(line.slice(14)).total;
          if (total.readsBehindAcknowledgedRevision > 0 || total.missingSnapshots > 0 || total.invariantErrors > 0) {
            fatal = new Error("persistence consistency violation; see persistence-soak.log");
          }
        }
      }
    }
    if (size > 256 * 1024 * 1024) { fatal = new Error(`${name}: log budget exceeded`); child.kill(); }
  });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => { children.delete(child); resolve(code); });
  });
  done.catch(() => {});
  return { child, done, log, tail: () => tail };
}
async function finish(task, timeoutMs, marker) {
  const timer = setTimeout(() => task.child.kill(), timeoutMs);
  try {
    const code = await task.done;
    if (code !== 0 || (marker && !task.tail().includes(marker))) {
      throw new Error(`probe failed (${code}); see ${task.log}\n${task.tail().slice(-2000)}`);
    }
    return task.tail();
  } finally { clearTimeout(timer); }
}
async function marker(task, expected, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (task.tail().includes(expected)) return;
    if (task.child.exitCode !== null) throw new Error(`missing ${expected}: ${task.tail().slice(-2000)}`);
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${expected}`);
}
async function ready(port, timeoutMs = 120_000, task) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (task && task.child.exitCode !== null) throw new Error(`service exited before readiness: ${task.log}\n${task.tail().slice(-2000)}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(2000) })).ok) return; } catch {}
    await sleep(500);
  }
  throw new Error(`readiness failed: ${port}`);
}
async function startService(name, port) {
  const db = name.startsWith("dbproxy");
  const binary = path.join(runDir, "bin", db ? "tiangz-dbproxy-server.exe" : "TiangZ.exe");
  const args = db ? ["--config", path.join(runDir, "configs", `${name}.json`)]
    : [path.join(runDir, "configs", `${name}.json`)];
  const task = managed(name, binary, args, runDir, db ? {} : { TIANGZ_WATCHER_CONTROL: "stdin" });
  services.set(name, { ...task, port });
  await ready(port,120_000,task);
}
async function killService(name) {
  const service = services.get(name);
  if (!service || service.child.exitCode !== null) throw new Error(`managed service not alive: ${name}`);
  service.child.kill("SIGKILL");
  await service.done;
  services.delete(name);
  event("process_killed", { name, pid: service.child.pid });
  return service.port;
}
async function restart(name) { const port = await killService(name); await startService(name, port); }
async function containersReady() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const state = JSON.parse(command("docker", ["inspect", ...containers]));
    if (state.every(c => c.State.Running && c.State.Health?.Status === "healthy")) return;
    await sleep(500);
  }
  throw new Error("local database containers not healthy");
}
function memorySample() {
  const now = Date.now();
  if (!diskSample || now >= nextDetailedSampleAt) {
    const disk = statfsSync(runDir);
    diskSample = { freeDiskBytes: disk.bavail * disk.bsize, artifactBytes: directoryBytes(runDir) };
    nextDetailedSampleAt = now + 60_000;
  }
  const cpu = cpuTotals();
  const sample = { at: new Date(now).toISOString(), availableMemoryBytes: os.freemem(), ...diskSample,
    systemCpuPercent: cpuPercent(previousCpu, cpu), controllerRssBytes: process.memoryUsage().rss,
    sampleGapMs: previousSampleAt === undefined ? null : now - previousSampleAt };
  previousCpu = cpu;
  previousSampleAt = now;
  appendFileSync(path.join(runDir, "resources.jsonl"), JSON.stringify(sample) + "\n");
  const violation = resourceViolation(sample);
  if (violation && !fatal) {
    fatal = new Error(`resource guard tripped: ${violation}; this run is not a pass`);
    event("resource_guard", { violation, sample });
    void captureDiagnostics("resource_guard");
    // Shed only our workload immediately, leaving stores available for cleanup.
    const servicePids = new Set([...services.values()].map(s => s.child.pid));
    for (const child of children) if (child.exitCode === null && !servicePids.has(child.pid)) child.kill();
  } else if (!fatal && now >= nextPressureSnapshotAt &&
      (memoryPressure(previousMemory, sample.availableMemoryBytes) || cpuPressure(sample.systemCpuPercent))) {
    nextPressureSnapshotAt = now + 60_000;
    event("resource_pressure", { previousMemoryBytes: previousMemory,
      memoryPressure: memoryPressure(previousMemory, sample.availableMemoryBytes),
      cpuPressure: cpuPressure(sample.systemCpuPercent), sample });
    void captureDiagnostics("resource_pressure", `resource-pressure-${now}.json`);
  }
  previousMemory = sample.availableMemoryBytes;
  return sample;
}

async function captureDiagnostics(reason, filename = "failure-diagnostics.json") {
  const failure = filename === "failure-diagnostics.json";
  if (failure && diagnosticPromise) return diagnosticPromise;
  const task = (async () => {
    const diagnostic = { at: new Date().toISOString(), reason, availableMemoryBytes: os.freemem(),
      services: [...services].map(([name, s]) => ({ name, pid: s.child.pid, exitCode: s.child.exitCode })) };
    try {
      // No command lines, environment variables or unrelated process mutation.
      const { stdout } = await promisify(execFile)(path.join(runDir, "bin/validation_resource_snapshot.exe"), [],
        { windowsHide: true, timeout: 30_000, maxBuffer: 256 * 1024 });
      const snapshot = JSON.parse(stdout);
      diagnostic.processes = snapshot.processes;
      diagnostic.cpuProcesses = snapshot.cpuProcesses;
      diagnostic.cpuSampleSeconds = snapshot.cpuSampleSeconds;
      diagnostic.logicalCpus = snapshot.logicalCpus;
    } catch (error) {
      diagnostic.processSnapshotError = String(error).slice(0, 1024);
      diagnostic.processSnapshotFailure = { code: error.code, signal: error.signal, killed: error.killed };
    }
    diagnostic.processSnapshotCompletedAt = new Date().toISOString();
    diagnostic.processSnapshotElapsedMs = Date.now() - Date.parse(diagnostic.at);
    save(path.join(runDir, filename), diagnostic);
    await metricsSample();
  })().catch(error => event("diagnostic_failed", { error: String(error) }));
  if (failure) diagnosticPromise = task;
  return task;
}
function directoryBytes(dir) {
  let sum = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error("unexpected symlink in validation evidence");
    sum += entry.isDirectory() ? directoryBytes(full) : statSync(full).size;
  }
  return sum;
}
async function checkedSleep(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fatal) throw fatal;
    if (existsSync(path.join(runDir, "STOP"))) stopping = true;
    if (stopping) throw new Error("validation interrupted");
    await sleep(Math.min(1000, until - Date.now()));
  }
}
async function metricsSample() {
  if (metricsPending) return;
  metricsPending = true;
  try {
    for (const port of [9090,9091,...runtimeSpecs.map(spec=>spec[1])]) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(2000) });
        const metrics = await response.text();
        appendFileSync(path.join(runDir, `metrics-${port}.log`), `# sampled_at ${new Date().toISOString()}\n${metrics}\n`);
        if(hasDroppedLogs(metrics)) {
          fatal=new Error(`runtime log loss detected on ${port}; evidence is incomplete`);
        }
      } catch { event("metrics_unavailable", { port }); }
    }
  } finally { metricsPending = false; }
}
async function assertIdle() {
  for (const port of [7800,7801,9090,9091]) {
    await new Promise((resolve,reject) => {
      const server=net.createServer(); server.once("error",reject);
      server.listen(port,"127.0.0.1",()=>server.close(resolve));
    });
  }
}
async function gameRound(players, seconds = 25, verify = true) {
  const epoch = ++sequence;
  event("game_round_started", { epoch, players, faultWindow: !verify });
  const results = [];
  for (const [mapId, suffix] of [[1, "a"], [100, "b"]]) {
    const count = Math.max(1, Math.floor(players / 2));
    const task = managed(`game-${epoch}-${mapId}`, path.join(runDir, "bin/map_probe_load.exe"), [
      "--host", "127.0.0.1", "--manager-port", "27000", "--players", String(count),
      "--setup-concurrency", "4", "--duration", String(seconds), "--warmup", "2",
      "--timeout", "10000", "--move-rate", "1", "--probe-rate", "0.2", "--business-rate", "0.1",
      "--map-id", String(mapId), "--account-prefix", `${runId}${suffix}`,
      "--recover-from-map", "1",
      "--reuse-accounts", "--operation-prefix", `${runId}:${epoch}`, "--movement-sequence-base", String(epoch * 10000),
    ]);
    results.push((async () => {
      const output = await finish(task, 180_000 + seconds * 1000, "RESULT_JSON ");
      const result = JSON.parse(output.split(/\r?\n/).findLast(line => line.startsWith("RESULT_JSON ")).slice(12));
      const healthy = result.setup?.count === count && result.players === count && result.enteredMapId === mapId &&
        result.enteredMapInstanceId === mapId && result.mapRecovery?.safeMapId === 1 &&
        Number.isInteger(result.mapRecovery?.fallbackPlayers) && result.mapRecovery.fallbackPlayers === result.mapRecovery.reenteredPlayers &&
        result.probe?.count > 0 && result.probe?.errors === 0 && result.movement?.errors === 0 &&
        result.business?.count > 0 && result.business?.transportErrors === 0;
      event("game_shard_finished", { epoch, mapId, faultWindow: !verify, healthy, result });
      if (verify && !healthy) throw new Error(`same-player business failure on map ${mapId}; see ${task.log}`);
      return result;
    })());
  }
  const completed = await Promise.allSettled(results);
  const failed = completed.filter(result => result.status === "rejected");
  if (failed.length) {
    event("game_round_failed", { epoch, faultWindow: !verify, errors: failed.map(result => String(result.reason)) });
    // Recovery callers may legitimately retry. Capture the final failure only
    // in the top-level catch, so an early retry cannot consume its evidence slot.
    if (verify) throw failed[0].reason;
  }
  return completed.filter(result => result.status === "fulfilled").map(result => result.value);
}
async function trade(cycle, verifyOnly = false) {
  const env = { TIANGZ_LOGIN_PORT: "27000", TIANGZ_TRADE_ACCOUNT_A: `lt${runId}${cycle}a`,
    TIANGZ_TRADE_ACCOUNT_B: `lt${runId}${cycle}b` };
  const task = managed(`trade-${cycle}-${verifyOnly ? "verify" : "commit"}`, process.execPath,
    [path.join(runDir, "dist/player_trade_persistence_probe.cjs"), verifyOnly ? "verify" : "commit"], runDir, env);
  await finish(task, 120_000, verifyOnly ? "Player trade restart recovery passed" : "Player trade durable commit passed");
  event("player_trade_passed", { cycle, verifyOnly });
}
async function dynamicFallback() {
  const task = managed(`dynamic-${sequence}`, process.execPath, [path.join(runDir, "dist/dynamic_map_fallback_probe.cjs"),
    "--login-host", "127.0.0.1", "--login-port", "27001", "--account-prefix", "localdyn_"]);
  try {
    await marker(task, "DYNAMIC_FALLBACK_READY");
    const port = await killService("dungeon");
    await checkedSleep(25_000);
    await startService("dungeon", port);
    task.child.stdin.write("continue\n");
    await finish(task, 120_000, "DYNAMIC_FALLBACK_PASSED");
    event("dynamic_fallback_passed");
  } finally { if (task.child.exitCode === null) task.child.kill(); }
}
async function inject(action) {
  phase = action;
  event("fault_started", { action });
  if (action === "postgres") {
    command("docker", ["stop", "--time", "5", containers[0]]);
    await checkedSleep(65_000); // Exceeds the reconnect grace; exercises final-offline/save/recovery overlap.
    command("docker", ["start", containers[0]]);
  } else if (action === "redis" || action === "cache") {
    const name = containers[action === "redis" ? 1 : 2];
    command("docker", ["kill", name]); await checkedSleep(35_000); command("docker", ["start", name]);
  } else if (action === "aof") {
    const prefix = `${runId}-aof-${sequence}`;
    const probe = async (mode, expected) => {
      const task = managed(`${prefix}-${mode}`, path.join(runDir, "bin/dbproxy_aof_probe.exe"), [mode, prefix]);
      const output = await finish(task, 160_000, expected);
      event("aof_probe", { mode, prefix, evidence: output.trim() });
    };
    command("docker", ["stop", "--time", "5", containers[0]]);
    await probe("enqueue", "AOF_ACK ");
    await probe("stats", "AOF_BACKLOG ");
    command("docker", ["kill", containers[1]]); await checkedSleep(5000);
    command("docker", ["start", containers[1]]); await checkedSleep(10_000);
    await probe("stats", "AOF_BACKLOG ");
    command("docker", ["start", containers[0]]);
    await containersReady();
    await probe("verify", "AOF_VERIFIED ");
    event("aof_backlog_survived", { prefix, acknowledged: 64, verified: 64 });
  } else if (action === "map2-orphan") {
    // Let existing clients disconnect and exceed Gate's reconnect grace. Do not
    // let an immediate reconnect hide an orphan stuck in final-offline cleanup.
    const port = await killService("map2");
    await checkedSleep(45_000);
    await startService("map2", port);
    await checkedSleep(30_000);
  } else if (action === "dynamic") await dynamicFallback();
  else await restart(action);
  await containersReady();
  await Promise.all([9090, 9091, ...runtimeSpecs.map(s => s[1])].map(port => ready(port)));
  event("infrastructure_recovered", { action });
}
async function prepare() {
  await assertIdle();
  if (existsSync(path.join(runDir, "manifest.json"))) throw new Error("refusing to overwrite an existing run");
  mkdirSync(path.join(runDir, "configs"), { recursive: true });
  mkdirSync(path.join(runDir, "bin"));
  mkdirSync(path.join(runDir, "dist"));
  await containersReady();
  // This opt-in resets only two explicitly named local databases, never the existing tiangz database.
  for (const database of [runtimeDatabase, contractDatabase]) {
    sql(`DROP DATABASE IF EXISTS ${database} WITH (FORCE); CREATE DATABASE ${database};`, "postgres");
  }
  for (const name of containers.slice(1)) redis(name, ["FLUSHALL", "SYNC"]);
  event("local_test_data_reset", { databases: [runtimeDatabase, contractDatabase], redis: containers.slice(1) });
  const front = json(path.join(root, "configs/deploy/external-2process/login-gate.json"));
  const world = json(path.join(root, "configs/deploy/external-2process/world.json"));
  const all = [...front.scenes, ...world.scenes].map(scene => ({ ...scene,
    bindIp: "127.0.0.1", innerIp: "127.0.0.1", ...(scene.outerIp ? { outerIp: "127.0.0.1", outerPort: scene.port } : {}) }));
  save(path.join(runDir, "configs/known-scenes.json"), { knownScenes: all });
  for (const [index, [name, port]] of runtimeSpecs.entries()) {
    const scenes = all.filter(scene => name === "front" ? ["LoginMgr", "Login", "Gate"].includes(scene.sceneType)
      : name === "map1" ? scene.name === "map_1" : name === "map2" ? scene.name === "map_2"
      : name === "dungeon" ? ["map_manager", "dungeon_1"].includes(scene.name) : scene.sceneType === "Location");
    // Dedicated dungeon host is the sole dynamic-map owner for deterministic crash tests.
    for (const scene of scenes) if (name === "map1" || name === "map2") scene.acceptDynamicMaps = false;
    save(path.join(runDir, `configs/${name}.json`), { process: {
      name: `local_validation_${name}`, identity: { originServerId: 1, workerId: index + 20 },
      persistence: { dbProxy: { endpoint: "127.0.0.1:7800", failoverEndpoints: ["127.0.0.1:7801"],
        authTokenEnv: "TIANGZ_DBPROXY_AUTH_TOKEN", clientPoolSize: 2, requestTimeoutMs: 5000 } },
      logging: { level: "info", format: "json", console: false,
        file: { enabled: true, directory: "runtime", rotation: "daily" } },
      observability: { health: { ip: "127.0.0.1", port }, latency: { enabled: true, sampleRate: 10 } },
    }, scenes, knownSceneFiles: ["known-scenes.json"] });
  }
  for (const [number, listen, metrics] of [[1,7800,9090],[2,7801,9091]]) {
    const config = json(path.join(dbRoot, "configs/local.json"));
    config.server.listenAddr = `127.0.0.1:${listen}`;
    config.observability.listenAddr = `127.0.0.1:${metrics}`;
    config.runtime.workerThreads = 2;
    config.storage.shards = 2;
    config.storage.cacheFallbackConcurrency = 4;
    config.storage.cacheRedisUrlEnv = "DBPROXY_CACHE_REDIS_URL";
    config.outboxRelay = { publishTimeoutMs: 5000, defaultPublisher: "local-events",
      publishers: [{ id: "local-events", backend: "redisStream", connectionEnv: "DBPROXY_EVENTS_REDIS_URL" }],
      sources: ["game", "achievement"].map(producer => ({ producer, version: 1, destination: "local.validation.events" })) };
    save(path.join(runDir, `configs/dbproxy${number}.json`), config);
  }
  for (const name of ["TiangZ.exe", "map_probe_load.exe", "validation_resource_snapshot.exe"]) copyFileSync(path.join(root, "target/release", name), path.join(runDir, "bin", name));
  for (const name of ["tiangz-dbproxy-server.exe", "dbproxy_fault_soak.exe", "dbproxy_relay_soak.exe", "dbproxy_aof_probe.exe"]) copyFileSync(path.join(dbRoot, "target/release", name), path.join(runDir, "bin", name));
  for (const name of ["model.js", "model.manifest.json", "hotfix.js", "hotfix.manifest.json",
    "player_trade_persistence_probe.cjs", "dynamic_map_fallback_probe.cjs"]) copyFileSync(path.join(root, "dist", name), path.join(runDir, "dist", name));
  cpSync(path.join(root, "dist/game-config"), path.join(runDir, "dist/game-config"), { recursive: true });
  cpSync(path.join(root, "navigation"), path.join(runDir, "navigation"), { recursive: true });
  mkdirSync(path.join(runDir,"controller-source"));
  for(const name of ["run_local_validation.mjs","local_validation_env.mjs","local_validation_resources.mjs"]) {
    copyFileSync(path.join(root,"tools/chaos",name),path.join(runDir,"controller-source",name));
  }
  const hashes = {};
  const hashDirectory = dir => {
    for(const entry of readdirSync(path.join(runDir,dir),{withFileTypes:true})) {
      const relative = `${dir}/${entry.name}`;
      if(entry.isDirectory()) hashDirectory(relative);
      else if(entry.isFile()) hashes[relative] = createHash("sha256").update(readFileSync(path.join(runDir,relative))).digest("hex");
      else throw new Error(`unexpected artifact type: ${relative}`);
    }
  };
  for (const dir of ["bin", "dist", "configs", "navigation", "controller-source"]) {
    hashDirectory(dir);
  }
  const revisions = {};
  for (const [name, cwd] of [["TiangZ", root], ["DBProxy", dbRoot]]) {
    const diff = command("git", ["diff", "HEAD"], { cwd });
    writeFileSync(path.join(runDir, `${name}.patch`), diff);
    revisions[name] = { head: command("git", ["rev-parse", "HEAD"], { cwd }).trim(),
      status: command("git", ["status", "--short"], { cwd }), patchHash: createHash("sha256").update(diff).digest("hex") };
  }
  save(path.join(runDir, "manifest.json"), { preparedAt: new Date().toISOString(), runId, hashes, revisions,
    scope: "local-only; frozen executables and bundles; remote seven-day run unchanged" });
  event("prepared", { runDir });
}
async function contracts() {
  await assertIdle();
  await finish(managed("contracts-controller", "node", ["--test", "tools/chaos/local_validation_env.test.mjs", "tools/chaos/local_validation_resources.test.mjs", "tools/chaos/validation_resource_snapshot.test.mjs"], root), 30_000);
  process.env.DBPROXY_POSTGRES_URL = process.env.DBPROXY_TEST_POSTGRES_URL;
  for (const [label, args] of [
    ["unit", ["test", "--workspace", "--locked", "-j1", "--", "--test-threads=1"]],
    ...["postgres_redis", "outbox_concurrency", "outbox_relay", "fault_matrix"].map(name => [name,
      ["test", "-p", "tiangz-dbproxy-storage", "--test", name, "--locked", "-j1", "--", "--ignored", "--test-threads=1"]]),
    ["postgres_redis_network", ["test", "-p", "tiangz-dbproxy-server", "--test", "postgres_redis_network", "--locked", "-j1", "--", "--ignored", "--test-threads=1"]],
  ]) {
    // Each integration suite owns a disposable database and Redis state; immutable
    // route registrations from another suite must not alter its startup contract.
    sql(`DROP DATABASE IF EXISTS ${contractDatabase} WITH (FORCE); CREATE DATABASE ${contractDatabase};`, "postgres");
    for (const name of containers.slice(1)) redis(name, ["FLUSHALL", "SYNC"]);
    const task = managed(`contracts-${label}`, "cargo", args, dbRoot);
    await finish(task, 15 * 60_000);
    event("contract_suite_passed", { label, summary: task.tail().split(/\r?\n/).filter(l => l.startsWith("test result:")) });
  }
  save(path.join(runDir, "contracts-passed.json"), { at: new Date().toISOString() });
}
async function run() {
  const seconds = Number(process.argv[4] ?? 10800);
  const players = Number(process.argv[5] ?? 100);
  const allowedActions = ["postgres","cache","redis","aof","map1","map2","map2-orphan","location","dbproxy1","dbproxy2","dynamic"];
  const actions = process.argv[6]?.split(",") ?? allowedActions;
  const faultGapMs = Number(process.argv[7] ?? 180_000);
  if (!actions.length || actions.some(action => !allowedActions.includes(action)) || !Number.isInteger(faultGapMs) || faultGapMs < 10_000 || faultGapMs > 600_000) throw new Error("invalid fault plan");
  if (!Number.isInteger(seconds) || seconds < 120 || seconds > 14400 || !Number.isInteger(players) || players < 2 || players > 200) throw new Error("invalid local duration/player limit");
  if (!existsSync(path.join(runDir, "contracts-passed.json"))) throw new Error("real database contract suites must pass before the long run");
  if (existsSync(path.join(runDir, "started.json"))) throw new Error("run already started; prepare another evidence directory");
  for (const [file, expected] of Object.entries(json(path.join(runDir, "manifest.json")).hashes)) {
    if (createHash("sha256").update(readFileSync(path.join(runDir,file))).digest("hex") !== expected) throw new Error(`frozen artifact changed: ${file}`);
    if (file.startsWith("controller-source/")) {
      const current = path.join(root, "tools/chaos", path.basename(file));
      if (createHash("sha256").update(readFileSync(current)).digest("hex") !== expected) {
        throw new Error(`controller changed after prepare: ${file}; prepare a new run`);
      }
    }
  }
  // Never attach to or kill an unrelated listener already using a validation port.
  for (const port of [7800,7801,9090,9091, ...runtimeSpecs.map(s => s[1]),27000,27001,27002,27201,27202,17100,17301,17302,17310,17401]) {
    await new Promise((resolve,reject) => { const server=net.createServer(); server.once("error",reject); server.listen(port,"127.0.0.1",()=>server.close(resolve)); });
  }
  const resources = memorySample();
  if (resources.availableMemoryBytes < 2.5 * 1024 ** 3) throw new Error("less than 2.5 GiB free before startup");
  sampleTimer = setInterval(() => {
    try { memorySample(); } catch (error) { fatal = error; }
    if (Date.now() >= nextMetricsAt) {
      nextMetricsAt = Date.now() + 60_000;
      void metricsSample().catch(error => { fatal = error; });
    }
  }, 5_000);
  await startService("dbproxy1",9090); await startService("dbproxy2",9091);
  for (const [name, port] of [...runtimeSpecs].reverse()) await startService(name,port);
  await checkedSleep(5000);
  await gameRound(players);
  await trade(0);
  const startedAt = Date.now();
  const deadline = startedAt + seconds * 1000;
  save(path.join(runDir, "started.json"), { startedAt: new Date(startedAt).toISOString(), deadlineAt: new Date(deadline).toISOString(), seconds, players, actions, faultGapMs, pid: process.pid });
  const soak = managed("persistence-soak",path.join(runDir,"bin/dbproxy_fault_soak.exe"),[
    "--endpoint","127.0.0.1:7800","--failover-endpoint","127.0.0.1:7801","--players","100",
    "--duration",String(seconds),"--cycle-ms","1000","--read-pool-size","4","--write-pool-size","2",
    "--trade-interval-cycles","120","--report-interval","60","--validation-timeout","240"]);
  const relay = managed("relay-soak",path.join(runDir,"bin/dbproxy_relay_soak.exe"),[],runDir,
    {DBPROXY_RELAY_SOAK_SECONDS:String(seconds), DBPROXY_RELAY_SOAK_PREFIX:runId, DBPROXY_RELAY_SOAK_INTERVAL_MS:"2000"});
  await marker(soak,"SOAK_READY"); await marker(relay,"RELAY_READY");
  event("validation_started",{seconds,players,persistencePlayers:100,deadlineAt:new Date(deadline).toISOString()});
  let actionIndex = 0;
  let nextFaultAt = startedAt + Math.min(faultGapMs, seconds * 1000 / 4);
  while (Date.now() < deadline - 180_000) {
    await checkedSleep(1);
    if (fatal) throw fatal;
    if (soak.child.exitCode !== null || relay.child.exitCode !== null) throw new Error("a persistence workload exited before its deadline");
    await gameRound(players);
    if (Date.now() >= nextFaultAt) {
      const action = actions[actionIndex++ % actions.length];
      // Keep real game traffic active across injection. Only this labelled
      // disruption window tolerates errors; post-recovery rounds remain strict.
      const duringFault = gameRound(players,20,false);
      await checkedSleep(5000);
      await inject(action);
      await duringFault;
      // Never replace a stuck account with a fresh generation to manufacture recovery.
      const recoveryDeadline = Date.now() + 180_000;
      let passing = 0;
      while (passing < 2) {
        try { await gameRound(players); passing++; }
        catch (error) { passing=0; event("business_recovery_retry",{action,error:String(error)}); if(Date.now()>recoveryDeadline) throw error; await checkedSleep(5000); }
      }
      await trade(0,true);
      event("business_recovered",{action,unchangedAccounts:true,passingRounds:2});
      if (actionIndex % 3 === 0) await trade(actionIndex);
      phase="healthy";
      nextFaultAt=Date.now()+faultGapMs;
    }
  }
  while (Date.now()<deadline) { await checkedSleep(1); await gameRound(players); }
  await finish(soak,300_000,'"passed":true');
  await finish(relay,300_000,'"passed":true');
  await trade(0,true);
  const relayFinal=JSON.parse(relay.tail().split(/\r?\n/).findLast(l=>l.startsWith("RELAY_FINAL ")).slice(12));
  const until=Date.now()+180_000;
  let counts;
  do {
    counts=sql(`SELECT count(*), count(*) FILTER (WHERE published_at IS NOT NULL), count(*) FILTER (WHERE dead_lettered_at IS NOT NULL) FROM dbproxy_outbox WHERE event_id LIKE '${runId}:%';`).trim().split("|").map(Number);
    if(counts[0]===relayFinal.committed && counts[1]===counts[0] && counts[2]===0) break;
    await checkedSleep(1000);
  } while(Date.now()<until);
  if(counts[0]!==relayFinal.committed || counts[1]!==counts[0] || counts[2]!==0) throw new Error("generic relay final SQL reconciliation failed");
  const entries=JSON.parse(redis(containers[1],["--json","XRANGE","local.validation.events","-","+"]));
  const seen=new Set(); let last=0;
  for(const [,fields] of entries) {
    const values=Object.fromEntries(Array.from({length:fields.length/2},(_,i)=>[fields[i*2],fields[i*2+1]]));
    if(!values.event_id?.startsWith(`${runId}:`))continue;
    if(seen.has(values.event_id))continue;
    const ordinal=Number(values.event_id.slice(runId.length+1));
    if(ordinal!==last+1)throw new Error("fan-in Stream lost or reordered an event");
    last=ordinal;seen.add(values.event_id);
  }
  if(seen.size!==relayFinal.committed)throw new Error("published rows do not match actual MQ events");
  const facts = sql(`SELECT
    (SELECT count(*) FROM dbproxy_snapshots WHERE namespace='relay_soak' AND record_key LIKE '${runId}:%'),
    (SELECT count(*) FROM dbproxy_snapshots WHERE namespace='relay_soak' AND record_key LIKE '${runId}:%' AND revision=1 AND (convert_from(payload,'UTF8')::jsonb->>'sequence')::bigint=split_part(record_key,':',2)::bigint),
    (SELECT count(*) FROM dbproxy_append_records WHERE namespace='relay_soak_audit' AND record_key LIKE '${runId}:%' AND operation_id=record_key AND (convert_from(payload,'UTF8')::jsonb->>'sequence')::bigint=split_part(record_key,':',2)::bigint);`).trim().split('|').map(Number);
  if(facts[0]!==relayFinal.committed*2 || facts[1]!==facts[0] || facts[2]!==relayFinal.committed) throw new Error("generic snapshots/immutable facts SQL reconciliation failed");
  const trades=sql(`SELECT count(*),count(*) FILTER (WHERE o.published_at IS NOT NULL AND o.operation_id=a.operation_id) FROM dbproxy_append_records a LEFT JOIN dbproxy_outbox o ON o.event_id=a.record_key || ':settled' WHERE a.namespace='player.trade.audit';`).trim().split('|').map(Number);
  if(trades[0]<1 || trades[1]!==trades[0]) throw new Error("game CommitRecords audit/event reconciliation failed");
  const tradeIds=sql("SELECT record_key || ':settled' FROM dbproxy_append_records WHERE namespace='player.trade.audit';").trim().split(/\r?\n/);
  const tradeEvents=JSON.parse(redis(containers[1],["--json","XRANGE","dbproxy:outbox:player.trade.settled","-","+"]));
  const publishedTrades=new Set(tradeEvents.map(([,fields])=>fields[fields.indexOf('event_id')+1]));
  if(tradeIds.some(id=>!publishedTrades.has(id))) throw new Error("game trade published rows are missing from the actual Stream");
  save(path.join(runDir,"final.json"),{passed:true,at:new Date().toISOString(),seconds,players,actions:actionIndex,relayFinal,sqlCounts:counts,streamUnique:seen.size,facts,trades});
  event("validation_completed",{passed:true,actions:actionIndex});
}
for (const signal of ["SIGINT","SIGTERM"]) process.once(signal,()=>{stopping=true;fatal=new Error(`received ${signal}`);});
try {
  if(mode==="--prepare")await prepare();
  else if(mode==="--contracts")await contracts();
  else if(mode==="--run")await run();
  else throw new Error("use --prepare, --contracts DIR, or --run DIR SECONDS PLAYERS");
} catch(error) {
  if(existsSync(runDir)) {
    const failure = { at:new Date().toISOString(), error:String(error), resourceError:fatal?.message,
      stopRequested:existsSync(path.join(runDir,"STOP")) };
    event("validation_failed",failure);
    save(path.join(runDir,"failure.json"),failure);
    if (mode === "--run") await captureDiagnostics("validation_failed");
  }
  process.exitCode=1;
} finally {
  clearInterval(sampleTimer);
  if(mode!=="--prepare") {
    for(const name of containers)try {command("docker",["start",name]);}catch{}
    // The runtime supports a private stdin shutdown channel on Windows. Keep
    // persistence alive while game processes finish their bounded final saves.
    for(const [name] of runtimeSpecs) {
      const service=services.get(name);
      if(service?.child.exitCode===null) {
        service.child.stdin.on("error",()=>{});
        service.child.stdin.end("shutdown\n");
      }
    }
    await Promise.all(runtimeSpecs.map(async ([name])=>{
      const service=services.get(name);
      if(service?.child.exitCode===null) {
        const timer=setTimeout(()=>service.child.kill(),40_000);
        try {await service.done;} finally {clearTimeout(timer);}
      }
    }));
    for(const child of children) { if(child.exitCode===null)child.kill(); }
  }
}
