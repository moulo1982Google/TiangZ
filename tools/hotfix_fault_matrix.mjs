import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

// 只控制本轮创建的进程与代理；真实DBProxy只写唯一测试namespace，不停库、不清库。
// Controls only owned processes/proxies; an optional real DBProxy gets one unique test namespace.
const root = path.resolve(import.meta.dirname, "..");
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!["--rounds", "--dbproxy-endpoint", "--dbproxy-env-file"].includes(key) || args.has(key) || !process.argv[i + 1]) throw new Error(`invalid argument ${key}`);
  args.set(key, process.argv[i + 1]);
}
const rounds = Number(args.get("--rounds") ?? 3);
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 20);
const endpoint = args.get("--dbproxy-endpoint");
if (endpoint && !/^127\.0\.0\.1:\d+$/.test(endpoint)) throw new Error("only an explicitly selected loopback DBProxy is supported");
if (!endpoint && args.has("--dbproxy-env-file")) throw new Error("env file requires --dbproxy-endpoint");
// 暂停检查依赖热更 INFO 事件，不能继承外部 warn/off 过滤而错过释放时机。
// Pause coordination needs Hotfix INFO events even when the caller filters logs at warn/off.
const env = { ...process.env, RUST_LOG: "warn,tiangz::hotfix=info", TIANGZ_SOAK_TOKEN: "local-hotfix-soak", TIANGZ_WATCHER_CONTROL: "stdin" };
if (endpoint && args.has("--dbproxy-env-file")) {
  const content = await readFile(path.resolve(args.get("--dbproxy-env-file")), "utf8");
  const token = /^(?:SLG_)?DBPROXY_AUTH_TOKEN=(.+)$/m.exec(content)?.[1]?.trim().replace(/^(['"])(.*)\1$/, "$2");
  if (!token) throw new Error("DBProxy token missing (value is never logged)");
  env.TIANGZ_DBPROXY_AUTH_TOKEN = token;
}
if (endpoint && !env.TIANGZ_DBPROXY_AUTH_TOKEN) throw new Error("set TIANGZ_DBPROXY_AUTH_TOKEN or provide --dbproxy-env-file");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const handled = promise => { promise.catch(() => {}); return promise; };
async function until(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await sleep(10); }
  throw new Error(`timeout: ${label}`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function run(commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, commandArgs, { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => child.kill(), 240000);
    child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { output += bytes; });
    child.once("error", reject);
    child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output.slice(-12000))); });
  });
}
const preparation = await run(["tools/hotfix_load_soak.mjs", "--prepare-only", "1"]);
const sourceReport = /\[hotfix-load\] prepared: (.+)/.exec(preparation)?.[1]?.trim();
assert.ok(sourceReport, preparation);
const fixtureReport = JSON.parse(await readFile(sourceReport, "utf8"));
const { project, candidates, probe, binary, configPath } = fixtureReport.fixture;
const directory = path.dirname(sourceReport);
const reportPath = path.join(directory, "fault-report.json");
const report = { status: "running", startedAt: new Date().toISOString(), binarySha256: fixtureReport.binarySha256,
  rounds, cases: [], dbProxy: endpoint ? "real, isolated proxy and unique namespace" : "not requested", checkedResponses: 0 };
const driverStarted = performance.now(), driverCpuStarted = process.cpuUsage();
if (endpoint) report.storageRecords = { namespace: `hotfix-fault-${path.basename(directory)}`, keys: ["probe", "ack-loss"] };
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2));
const { connect } = await import(pathToFileURL(probe).href);
const processes = [], clients = [];
let proxy, cancelled = false;
const cancel = () => {
  cancelled = true; proxy?.release();
  for (const client of clients) client.close();
  for (const state of processes) if (state.child.stdin.writable && !state.child.stdin.writableEnded) state.child.stdin.end("shutdown\n");
};
process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
console.log(`[hotfix-faults] ${reportPath}`);
function start(config, name) {
  if (cancelled) throw new Error("test cancelled");
  const child = spawn(binary, [`--runtime-root=${project}`, config], { cwd: project, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const state = { child, name, log: "", forced: false };
  child.stdout.on("data", bytes => { state.log += bytes; }); child.stderr.on("data", bytes => { state.log += bytes; });
  state.exited = handled(new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); }));
  processes.push(state);
  return state;
}
async function stop(state) {
  if (state.child.exitCode === null) {
    if (!state.child.stdin.writableEnded) state.child.stdin.end("shutdown\n");
    let timer;
    try { await Promise.race([state.exited, new Promise(resolve => { timer = setTimeout(resolve, 10000); })]); }
    finally { clearTimeout(timer); }
    if (state.child.exitCode === null) { state.forced = true; state.child.kill(); await state.exited; }
  }
  assert.equal(state.forced, false, `${state.name} required force stop`);
  assert.equal(state.child.exitCode, 0, `${state.name} exit code`);
}
async function open(port) { const client = await connect(port); clients.push(client); return client; }
async function responseProxy(upstream) {
  const sockets = new Set(), buffered = [];
  let held = false, unavailable = false;
  const server = net.createServer(down => {
    if (unavailable) { down.destroy(); return; }
    const up = net.connect({ host: "127.0.0.1", port: Number(upstream.split(":")[1]) });
    sockets.add(down); sockets.add(up);
    down.pipe(up);
    up.on("data", bytes => { if (held) buffered.push([down, bytes]); else down.write(bytes); });
    for (const [socket, peer] of [[down, up], [up, down]]) {
      socket.on("error", () => peer.destroy());
      socket.on("close", () => { sockets.delete(socket); peer.destroy(); });
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    endpoint: `127.0.0.1:${server.address().port}`,
    hold() { assert.equal(buffered.length, 0); held = true; },
    pending() { return buffered.length; },
    release() { held = false; for (const [socket, bytes] of buffered.splice(0)) if (!socket.destroyed) socket.write(bytes); },
    drop(rejectReconnect = false) { unavailable = rejectReconnect; buffered.length = 0; held = false; for (const socket of sockets) socket.destroy(); },
    online() { unavailable = false; },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}
try {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  // 独立 Rust 总预算容纳 64 MiB 包及传输副本；TS 单批 64 MiB 硬上限保持不变。
  // An independent Rust budget holds the 64 MiB packet and transport copies; the TS 64 MiB packet limit remains unchanged.
  config.process.network = { ...config.process.network, maxOutboundBufferedBytes: 256 * 1024 * 1024 };
  assert.notEqual(config.process.observability.tracing?.enabled, true, "exact packet fixture expects tracing disabled");
  const mainScene = { ...config.scenes[0], protocol: "auto", audience: "mixed" };
  const usedPorts = new Set([mainScene.port, config.process.observability.health.port]);
  const uniquePort = async () => { let port; do { port = await freePort(); } while (usedPorts.has(port)); usedPorts.add(port); return port; };
  const workerScene = { ...mainScene, name: "worker", port: await uniquePort() };
  const localScene = { ...mainScene, name: "local-target", port: await uniquePort() };
  const workerLocalScene = { ...mainScene, name: "worker-local-quota", port: await uniquePort() };
  const quotaScenes = [];
  for (let i = 0; i < 5; i++) quotaScenes.push({ ...mainScene, name: `local-quota-${i}`, port: await uniquePort() });
  const workerHealth = await uniquePort();
  config.scenes = [mainScene, localScene, ...quotaScenes]; config.knownScenes = [workerScene];
  if (endpoint) {
    proxy = await responseProxy(endpoint);
    config.process.persistence = { dbProxy: { endpoint: proxy.endpoint, authTokenEnv: "TIANGZ_DBPROXY_AUTH_TOKEN", clientPoolSize: 1, requestTimeoutMs: 8000, connectTimeoutMs: 5000 } };
  }
  const workerConfig = { ...config, process: { ...config.process, name: "fault-worker", identity: { originServerId: 93, workerId: 0 },
    persistence: undefined, observability: { health: { ip: "127.0.0.1", port: workerHealth } } }, scenes: [workerScene, workerLocalScene], knownScenes: [mainScene] };
  await writeFile(configPath, JSON.stringify(config));
  const workerPath = path.join(project, "configs/local/fault-worker.json");
  await writeFile(workerPath, JSON.stringify(workerConfig));
  const worker = start(workerPath, "worker");
  let main = start(configPath, "main");
  const ready = async port => until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, "ready");
  await ready(workerHealth); await ready(config.process.observability.health.port);
  const control = await open(mainScene.port), workerControl = await open(workerScene.port);
  const peers = await Promise.all(Array.from({ length: 500 }, () => open(mainScene.port)));
  const admin = async (action, body, expected = 200, healthPort = config.process.observability.health.port) => {
    const response = await fetch(`http://127.0.0.1:${healthPort}/admin/hotfix/${action}`, {
      method: body ? "POST" : "GET", headers: { Authorization: "Bearer local-hotfix-soak", "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(12000),
    });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  };
  let operation = 0, activePair = 11;
  const seen = new Set();
  const checked = (client, mode = 0, pair = activePair) => handled(client.call(mode).then(value => {
    assert.equal(value.count % 32, pair, "request mixed or unexpected generation");
    const seq = Math.floor(value.count / 32); assert.ok(!seen.has(seq), "duplicate execution"); seen.add(seq);
    report.checkedResponses++; return value;
  }));
  const checkpoint = async () => {
    const count = (await control.call(9)).count;
    assert.equal(count, seen.size, "missing or unacknowledged execution");
    for (let i = 1; i <= count; i++) assert.ok(seen.has(i), `missing ${i}`);
  };
  const begin = (candidate = activePair === 11 ? 1 : 0, expected = 200) => {
    const offset = main.log.length;
    const pending = handled(admin("apply", { operationId: `fault-${operation++}`, candidateDirectory: candidates[candidate] }, expected));
    return { pending, paused: () => until(() => main.log.slice(offset).includes("Hotfix ingress pause started"), "active pause") };
  };
  const holdRemote = async () => {
    const pending = checked(control, 4);
    await until(async () => (await workerControl.call(3)).count === 1, "remote request admitted");
    return { pending };
  };
  const commit = async operation => {
    const result = await operation.pending;
    assert.ok(result.report.pauseMs < 3000);
    activePair = activePair === 11 ? 22 : 11;
    return result.report.pauseMs;
  };
  const test = async (name, fn) => {
    const start = performance.now(); const detail = await fn();
    await checkpoint(); report.cases.push({ name, elapsedMs: performance.now() - start, driverRssBytes: process.memoryUsage().rss, ...detail });
    await save(); console.log(`[hotfix-faults] passed ${name}`);
  };
  await test("malformed-tcp-and-websocket-release-connections", async () => {
    const activeConnections = async () => {
      const response = await fetch(`http://127.0.0.1:${config.process.observability.health.port}/metrics`, { signal: AbortSignal.timeout(2000) });
      assert.ok(response.ok);
      const line = (await response.text()).split(/\r?\n/).find(line => line.startsWith("tiangz_process_active_connections{"));
      return line ? Number(line.split(" ").at(-1)) : undefined;
    };
    await until(async () => (await activeConnections()) >= peers.length + 1, "initial connection metrics published");
    const baseline = await activeConnections();
    for (let attempt = 0; attempt < 4; attempt++) {
      const socket = net.connect({ host: "127.0.0.1", port: mainScene.port });
      let closed = false; socket.on("error", () => {}); socket.on("close", () => { closed = true; }); socket.resume();
      try {
        await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
        // Deliberately invalid framing, not a handwritten business protocol codec.
        if (attempt % 2) socket.end(new Uint8Array([0, 0, 0, 10, 0]));
        else socket.write(new Uint8Array([0, 0, 0, 1, 0]));
        await until(() => closed, "malformed TCP peer must be closed", 1500);
      } finally { socket.destroy(); }
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const tunnel = await responseProxy(`127.0.0.1:${mainScene.port}`);
      const socket = new WebSocket(`ws://${tunnel.endpoint}`);
      try {
        await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
        socket.send(attempt % 2 ? new Uint8Array([0]) : "invalid text frame");
        await until(() => socket.readyState === WebSocket.CLOSED, "malformed WebSocket peer must be closed", 1500);
      } finally { await tunnel.close(); }
    }
    await until(async () => (await activeConnections()) === baseline, "invalid connection writers must return to baseline");
    await checked(control);
    return { rejectedConnections: 8 };
  });
  for (const [mode, name] of [[16, "direct-actor-drain-timeout"], [17, "disposed-actor-drain-timeout"], [20, "local-unordered-scene-drain-timeout"], [23, "disposed-scene-spawn-drain-timeout"]]) {
    await test(name, async () => {
      assert.equal((await control.call(mode)).count, 0, "starting request must already have returned");
      assert.equal((await control.call(mode === 20 ? 21 : 3)).count, 1, "owned work must still await its result");
      const before = await admin("status"), started = performance.now(), op = begin(undefined, 422);
      await op.paused();
      const rejected = await op.pending;
      assert.equal(rejected.status, "rejected");
      assert.match(rejected.error, /drain deadline exceeded/);
      assert.match(rejected.error, /pendingAsync=true/);
      assert.ok(performance.now() - started >= 2800, "live work must hold the drain until its deadline");
      assert.equal((await admin("status")).hotfix.generation, before.hotfix.generation);
      await control.call(mode === 20 ? 22 : 2);
      await until(async () => (await control.call(19)).count === (mode === 17 ? 3 : 2), "detached work completion");
      if (mode === 16) await checked(control, 18);
      return { startedRequestCompleted: true, ownerDisposed: mode === 17 || mode === 23, generationPreserved: true };
    });
  }
  await test("failed-scene-spawn-does-not-block-hotfix", async () => {
    try {
      assert.equal((await control.call(24)).count, 0, "rejected admission must leave no phantom task");
      assert.equal((await control.call(19)).count, 0, "rejected task body must not execute");
      const before = await admin("status");
      const op = begin();
      await op.paused();
      const pauseMs = await commit(op);
      assert.equal((await admin("status")).hotfix.generation, before.hotfix.generation + 1);
      return { rejectedTaskCount: 0, taskBodyStarted: false, generationAdvanced: true, pauseMs };
    } finally { assert.equal((await control.call(25)).count, 1); }
  });
  await test("process-spawn-quota-rejects-recovers-and-retains-disposed-work", async () => {
    const taskMetrics = async () => {
      const response = await fetch(`http://127.0.0.1:${config.process.observability.health.port}/metrics`, { signal: AbortSignal.timeout(2000) });
      assert.ok(response.ok);
      const lines = (await response.text()).split(/\r?\n/);
      return Object.fromEntries(["in_flight", "capacity", "max_in_flight", "rejected_total"].map(name => {
        const matching = lines.filter(line => line.startsWith(`tiangz_scene_tasks_${name}{`));
        assert.equal(matching.length, 1, "Spawn metrics have one Process series, independent of Scene count");
        return [name, Number(matching[0].split(" ").at(-1))];
      }));
    };
    try {
      const beforeBodies = (await control.call(30)).count;
      assert.equal((await control.call(26)).count, 4096);
      await assert.rejects(control.call(27), error => error.code === 1011 && /process scene task capacity exceeded/.test(error.message) && error.response.rpcId > 0);
      assert.equal((await control.call(31)).count, 16);
      await assert.rejects(control.call(27), error => error.code === 1011);
      assert.equal((await control.call(30)).count, beforeBodies, "rejected task bodies must not execute");
      await until(async () => (await taskMetrics()).in_flight === 4096, "disposed Spawn tasks remain in actual Process metrics");
      assert.deepEqual(await taskMetrics(), { in_flight: 4096, capacity: 4096, max_in_flight: 4096, rejected_total: 2 });
      // 独立 Process 仍可接受工作；总额度不是全机共享的全局变量。 / An independent Process still admits work; the quota is not machine-global.
      assert.equal((await workerControl.call(23)).count, 0);
      await workerControl.call(2);
      await until(async () => (await workerControl.call(19)).count === 2, "independent Process task completion");
      const before = await admin("status"), op = begin(undefined, 422);
      await op.paused();
      const rejected = await op.pending;
      assert.equal(rejected.status, "rejected");
      assert.match(rejected.error, /drain deadline exceeded/);
      assert.equal((await admin("status")).hotfix.generation, before.hotfix.generation);
      await control.call(28);
      await until(async () => (await control.call(29)).count === 0, "all held tasks actually finish");
      assert.equal((await control.call(27)).count, 1, "released quota permits a new Spawn");
      await until(async () => (await control.call(30)).count === beforeBodies + 1, "recovered task body executes once");
      await until(async () => (await taskMetrics()).in_flight === 0, "quota metrics return to baseline");
      const recovery = begin(); await recovery.paused(); await commit(recovery);
      assert.equal((await admin("status")).hotfix.generation, before.hotfix.generation + 1);
      return { admittedTasks: 4096, disposedOwners: 16, overloadResponses: 2, recovered: true };
    } finally { await control.call(28); await control.call(32); }
  });
  await test("actor-mailbox-quotas-propagate-rejection-and-retain-disposed-work", async () => {
    const quotaMetrics = async () => {
      const response = await fetch(`http://127.0.0.1:${config.process.observability.health.port}/metrics`, { signal: AbortSignal.timeout(2000) });
      assert.ok(response.ok);
      const lines = (await response.text()).split(/\r?\n/);
      return Object.fromEntries(["in_flight", "capacity", "per_actor_capacity", "max_in_flight", "actor_rejected_total", "process_rejected_total"].map(name => {
        const matching = lines.filter(line => line.startsWith(`tiangz_process_actor_mailbox_tasks_${name}{`));
        assert.equal(matching.length, 1, "Actor task quotas have one Process series");
        return [name, Number(matching[0].split(" ").at(-1))];
      }));
    };
    const closeSource = async actorIndex => {
      const before = (await control.call(33)).count, victim = await open(mainScene.port);
      try {
        await victim.sendQuota(actorIndex);
        await until(victim.closed, "overloaded one-way physical source is closed by server");
        await until(async () => (await control.call(33)).count === before + 1, "real Disconnect reaches TS");
        assert.equal(control.closed(), false, "unrelated control connection survives overload");
      } finally { victim.close(); }
    };
    try {
      const probes = (await control.call(42)).count;
      assert.equal((await control.call(34)).count, 4096);
      await assert.rejects(control.call(36), error => error.code === 1011 && /actor mailbox capacity exceeded/.test(error.message) && error.response.rpcId > 0);
      await assert.rejects(control.call(45), error => error.code === 1011 && error.response.rpcId > 0);
      await closeSource(0);
      assert.equal((await control.call(35)).count, 16384);
      await assert.rejects(control.call(37), error => error.code === 1011 && /process actor mailbox capacity exceeded/.test(error.message) && error.response.rpcId > 0);
      await assert.rejects(control.call(46), error => error.code === 1011 && error.response.rpcId > 0);
      await closeSource(4);
      assert.equal((await control.call(43)).count, 16384, "only admitted Actor bodies started");
      assert.equal((await control.call(38)).count, 4);
      await assert.rejects(control.call(37), error => error.code === 1011);
      await until(async () => (await quotaMetrics()).process_rejected_total === 4, "Actor quota HTTP metrics update");
      assert.deepEqual(await quotaMetrics(), { in_flight: 16384, capacity: 16384, per_actor_capacity: 4096,
        max_in_flight: 16384, actor_rejected_total: 3, process_rejected_total: 4 });
      assert.equal((await control.call(42)).count, probes, "rejected Actor probes never execute");
      assert.equal((await workerControl.call(34)).count, 4096, "another Process has an independent Actor quota");
      await workerControl.call(39);
      await until(async () => (await workerControl.call(40)).count === 0, "independent Process Actors complete");
      assert.equal((await workerControl.call(44)).count, 0);
      await workerControl.call(41);
      const before = await admin("status"), op = begin(undefined, 422);
      await op.paused();
      assert.match((await op.pending).error, /drain deadline exceeded/);
      assert.equal((await admin("status")).hotfix.generation, before.hotfix.generation);
      await control.call(39);
      await until(async () => (await control.call(40)).count === 0, "disposed Actor waits actually finish");
      assert.equal((await control.call(37)).count, 1);
      assert.equal((await control.call(42)).count, probes + 1, "released quota permits exactly one probe");
      assert.equal((await control.call(44)).count, 0, "only expected disposal failures occurred");
      await until(async () => (await quotaMetrics()).in_flight === 0, "Actor quotas return to zero");
      const recovery = begin(); await recovery.paused(); await commit(recovery);
      assert.equal((await admin("status")).hotfix.generation, before.hotfix.generation + 1);
      return { admittedCalls: 16384, disposedOwners: 4, rpcOverloads: 5, publicSendOverloads: 2, oneWaySourceClosures: 2, recovered: true };
    } finally {
      for (const client of [control, workerControl]) {
        await client.call(39);
        await until(async () => (await client.call(40)).count === 0, "quota fixture drain");
        await client.call(41);
      }
    }
  });
  await test("local-scene-quotas-retain-void-work-and-allow-host-completion", async () => {
    const targets = await Promise.all(quotaScenes.map(scene => open(scene.port)));
    const quotaMetrics = async () => {
      const response = await fetch(`http://127.0.0.1:${config.process.observability.health.port}/metrics`, { signal: AbortSignal.timeout(2000) });
      assert.ok(response.ok);
      const lines = (await response.text()).split(/\r?\n/);
      return Object.fromEntries(["in_flight", "capacity", "per_scene_capacity", "max_in_flight", "scene_rejected_total", "process_rejected_total"].map(name => {
        const matching = lines.filter(line => line.startsWith(`tiangz_local_scene_mailbox_tasks_${name}{`));
        assert.equal(matching.length, 1, "local quotas are aggregated once for the Process");
        return [name, Number(matching[0].split(" ").at(-1))];
      }));
    };
    const rejectOneWay = async index => {
      const victim = await open(mainScene.port), disconnected = (await control.call(33)).count;
      try {
        await victim.sendLocalQuota(index);
        await until(victim.closed, "local Scene overload closes its physical forwarding source");
        await until(async () => (await control.call(33)).count === disconnected + 1, "local quota Disconnect delivery");
        assert.equal(control.closed(), false);
      } finally { victim.close(); }
    };
    try {
      assert.equal((await control.call(49)).count, 2048, "RPC half has completion promises; void half already returned");
      assert.equal((await targets[0].call(57)).count, 4096);
      for (const mode of [51, 52]) await assert.rejects(control.call(mode), error => error.code === 1011 && error.response.rpcId > 0);
      await rejectOneWay(0);
      assert.equal((await control.call(50)).count, 8192);
      await until(async () => (await workerControl.call(60)).count === 4, "all four targets await real Worker RPC results");
      for (const mode of [53, 54]) await assert.rejects(control.call(mode), error => error.code === 1011 && error.response.rpcId > 0);
      await rejectOneWay(4);
      await until(async () => (await quotaMetrics()).process_rejected_total === 3, "local quota metrics update");
      assert.deepEqual(await quotaMetrics(), { in_flight: 16384, capacity: 16384, per_scene_capacity: 4096,
        max_in_flight: 16384, scene_rejected_total: 3, process_rejected_total: 3 });
      assert.equal((await targets[4].call(57)).count, 0, "rejected messages never reach the fifth target");
      assert.equal((await workerControl.call(62)).count, 1, "independent Process still admits local calls");
      const before = await admin("status"), failed = begin(undefined, 422);
      await failed.paused();
      assert.match((await failed.pending).error, /drain deadline exceeded/);
      assert.equal((await admin("status")).hotfix.generation, before.hotfix.generation);
      // 主进程再次暂停时释放远程结果；验证真实 Host completion 在满额/暂停期间仍能排空。
      // Release remote results while the main Process is paused again, proving real Host completion drains full quotas.
      const recovery = begin(); await recovery.paused();
      await workerControl.call(55);
      await commit(recovery);
      await until(async () => (await control.call(56)).count === 0, "all local RPC callers finish");
      for (let i = 0; i < 4; i++) assert.equal((await targets[i].call(58)).count, 4096, "RPC and void target work both actually complete");
      assert.equal((await control.call(59)).count, 0);
      assert.equal((await control.call(53)).count, 1, "released Process capacity permits a new local RPC");
      assert.equal((await targets[4].call(57)).count, 1);
      await until(async () => (await quotaMetrics()).in_flight === 0, "local call quota returns to zero");
      assert.equal((await admin("status")).hotfix.generation, before.hotfix.generation + 1);
      return { admittedCalls: 16384, rpcCalls: 8192, voidCalls: 8192, rpcOverloads: 4, oneWaySourceClosures: 2, completionDuringPause: true };
    } finally {
      await workerControl.call(55);
      await until(async () => (await quotaMetrics()).in_flight === 0, "local quota cleanup drain");
      for (const client of [control, ...targets, workerControl]) await client.call(61);
      for (const client of targets) client.close();
    }
  });
  await test("local-deadline-release-keeps-timed-out-business-in-hotfix-drain", async () => {
    const target = await open(quotaScenes[0].port);
    const inFlight = async () => {
      const response = await fetch(`http://127.0.0.1:${config.process.observability.health.port}/metrics`, { signal: AbortSignal.timeout(2000) });
      assert.ok(response.ok);
      const line = (await response.text()).split(/\r?\n/).find(value => value.startsWith("tiangz_local_scene_mailbox_tasks_in_flight{"));
      assert.ok(line);
      return Number(line.split(" ").at(-1));
    };
    const completedBefore = (await target.call(58)).count;
    try {
      let fastStarted = performance.now();
      assert.equal((await control.call(65)).count, 1000, "fast explicit-deadline calls remain usable");
      let fastCallMs = performance.now() - fastStarted;
      await assert.rejects(control.call(64), error => error.code === 1006 && /timed out after 50ms/.test(error.message));
      await until(async () => (await workerControl.call(60)).count === 1, "timed-out local caller still has a real Worker result outstanding");
      await until(async () => (await inFlight()) === 1, "caller timeout does not return target admission");
      assert.equal((await target.call(58)).count, completedBefore);
      const before = await admin("status"), failed = begin(undefined, 422);
      await failed.paused();
      assert.match((await failed.pending).error, /drain deadline exceeded/);
      assert.equal((await admin("status")).hotfix.generation, before.hotfix.generation);
      const recovery = begin(); await recovery.paused();
      await workerControl.call(55);
      await commit(recovery);
      await until(async () => (await inFlight()) === 0, "actual target completion releases admission");
      assert.equal((await target.call(58)).count, completedBefore + 1);
      fastStarted = performance.now();
      assert.equal((await control.call(65)).count, 1000, "explicit-deadline calls recover after real completion");
      fastCallMs += performance.now() - fastStarted;
      assert.equal((await admin("status")).hotfix.generation, before.hotfix.generation + 1);
      return { fastCalls: 2000, fastCallMs, timeoutCode: 1006, retainedCallsAfterTimeout: 1, completionDuringPause: true };
    } finally {
      await workerControl.call(55);
      await until(async () => (await inFlight()) === 0, "deadline fixture target drain");
      for (const client of [control, target, workerControl]) await client.call(61);
      target.close();
    }
  });
  await test("remote-host-shared-admission-preserves-count-and-byte-full-batches", async () => {
    const metrics = async () => {
      const response = await fetch(`http://127.0.0.1:${config.process.observability.health.port}/metrics`, { signal: AbortSignal.timeout(2000) });
      assert.ok(response.ok);
      const lines = (await response.text()).split(/\r?\n/);
      const values = Object.fromEntries(["queued", "queued_bytes", "pending_replies", "queue_capacity", "queue_byte_capacity", "pending_capacity",
        "queue_count_rejected_total", "queue_bytes_rejected_total", "pending_rejected_total", "invalid_frames_total", "submit_failures_total"].map(key => {
        const matching = lines.filter(line => line.startsWith(`tiangz_host_scene_operations_${key}{`));
        assert.equal(matching.length, 1, "Host operation metrics have one Process series");
        return [key, Number(matching[0].split(" ").at(-1))];
      }));
      for (const key of ["reserved_slots", "max_reserved_slots", "slot_capacity", "rejections_total"]) {
        const matching = lines.filter(line => line.startsWith(`tiangz_host_scene_batch_${key}{`));
        assert.equal(matching.length, 1, "Native batch metrics have one Process series");
        values[`native_${key}`] = Number(matching[0].split(" ").at(-1));
      }
      return values;
    };
    await workerControl.call(71);
    await until(async () => (await metrics()).native_reserved_slots === 0, "previous Native batch containers have drained");
    const before = await metrics();
    assert.equal((await control.call(66)).count, 2, "both public send and call reject the full count queue");
    await until(async () => (await workerControl.call(67)).count === 65536, "all accepted one-way frames reach Worker", 30000);
    assert.equal((await workerControl.call(68)).count, 65536, "every accepted sequence arrives");
    assert.equal((await workerControl.call(69)).count, 0, "no duplicated accepted messages");
    assert.equal((await workerControl.call(75)).count, 0, "rejected RPC never executes");
    await until(async () => (await metrics()).queue_count_rejected_total === before.queue_count_rejected_total + 2, "shared count rejection metrics");
    assert.equal((await control.call(76)).count, 1, "remote RPC recovers after flush");
    assert.equal((await workerControl.call(75)).count, 1);
    assert.equal((await control.call(72)).count, 2, "both public send and call reject the exact byte-full queue");
    await until(async () => (await workerControl.call(73)).count === 64, "all byte-full batch payloads reach Worker", 30000);
    const payloadBytes = 67108864 - 4 - 64 * (17 + 6);
    assert.equal((await workerControl.call(74)).count, payloadBytes);
    assert.equal((await workerControl.call(67)).count, 65536, "byte rejection did not deliver the extra one-way frame");
    assert.equal((await workerControl.call(75)).count, 1, "byte rejection did not execute the extra RPC");
    await until(async () => (await metrics()).queue_bytes_rejected_total === before.queue_bytes_rejected_total + 2, "shared byte rejection metrics");
    assert.equal((await control.call(76)).count, 1);
    await until(async () => { const current = await metrics(); return current.queued === 0 && current.queued_bytes === 0 && current.pending_replies === 0 && current.native_reserved_slots === 0; }, "Host operation and Native batch drain");
    const after = await metrics();
    assert.equal(after.queue_capacity, 65536); assert.equal(after.queue_byte_capacity, 67108864); assert.equal(after.pending_capacity, 65536);
    assert.equal(after.native_slot_capacity, 65536); assert.equal(after.native_max_reserved_slots, 65536);
    assert.equal(after.native_rejections_total, before.native_rejections_total);
    for (const key of ["pending_rejected_total", "invalid_frames_total", "submit_failures_total"]) assert.equal(after[key], before[key], key);
    const status = await admin("status"); await commit(begin());
    assert.equal((await admin("status")).hotfix.generation, status.hotfix.generation + 1);
    await workerControl.call(71);
    return { acceptedMessages: 65536, blobMessages: 64, packedBytes: 67108864, payloadBytes, publicOverloads: 4, nativePeakSlots: after.native_max_reserved_slots, nativeSlotsAfter: after.native_reserved_slots, recovered: true };
  });
  await test("remote-queued-deadline-expires-before-network-slots-are-released", async () => {
    const deadlineMetrics = async () => {
      const response = await fetch(`http://127.0.0.1:${config.process.observability.health.port}/metrics`, { signal: AbortSignal.timeout(2000) });
      assert.equal(response.status, 200);
      const lines = (await response.text()).split("\n");
      const queued = lines.filter(line => line.startsWith("tiangz_host_scene_operations_queue_timeouts_total{"));
      assert.equal(queued.length, 1);
      const reserved = lines.filter(line => line.startsWith("tiangz_host_scene_batch_reserved_slots{"));
      assert.equal(reserved.length, 1);
      const native = traffic => lines.filter(line => line.startsWith("tiangz_transport_inner_timeouts_by_route_total{") &&
        line.includes(`source="${mainScene.name}",target="worker",traffic="${traffic}",stage="host_queue"`))
        .reduce((sum, line) => sum + Number(line.split(" ").at(-1)), 0);
      return { queued: Number(queued[0].split(" ").at(-1)), call: native("call"), send: native("send"), reserved: Number(reserved[0].split(" ").at(-1)) };
    };
    await control.call(87); await workerControl.call(87); await workerControl.call(71);
    const before = await deadlineMetrics(), started = performance.now(), request = handled(control.call(78));
    try {
      await until(async () => (await control.call(84)).count === 1, "short RPC expires in the native queue", 1500);
      const expiredAfterMs = performance.now() - started;
      assert.ok(expiredAfterMs < 1500, "short deadline must finish before held 30-second RPCs");
      await until(async () => (await workerControl.call(86)).count === 256, "all long RPCs wait on real Worker results");
      assert.equal((await control.call(83)).count, 256);
      assert.equal((await workerControl.call(85)).count, 0, "expired RPC did not execute");
      assert.equal((await workerControl.call(67)).count, 0, "expired one-way frame did not execute");
      await until(async () => {
        const current = await deadlineMetrics();
        return current.call === before.call + 1 && current.send === before.send + 1;
      }, "both expirations are recorded in the native host_queue stage");
      assert.equal((await deadlineMetrics()).queued, before.queued, "fixture expiry happened after TS submission");
      assert.equal((await deadlineMetrics()).reserved, 258, "partly completed batch retains its original metadata slots");
      await workerControl.call(81);
      assert.equal((await request).count, 256, "previously started RPCs still finish normally");
      assert.equal((await control.call(83)).count, 0);
      assert.equal((await workerControl.call(86)).count, 0);
      assert.equal((await control.call(76)).count, 1, "fresh remote RPC recovers");
      assert.equal((await workerControl.call(85)).count, 0);
      assert.equal((await workerControl.call(67)).count, 0);
      await until(async () => (await deadlineMetrics()).reserved === 0, "completed Native batch containers release their slots");
      return { heldRpcCalls: 256, shortTimeoutMs: 80, expiredAfterMs, nativeQueuedTimeouts: 2, nativeRetainedSlots: 258, nativeSlotsAfter: 0, expiredOneWayDelivered: 0, recovered: true };
    } finally {
      await workerControl.call(81).catch(() => {});
      await request.catch(() => {});
      await control.call(87); await workerControl.call(87);
    }
  });
  await test("disconnected-in-flight-rpc-does-not-refill-response-cache", async () => {
    const sourceMetrics = async () => {
      const response = await fetch(`http://127.0.0.1:${config.process.observability.health.port}/metrics`, { signal: AbortSignal.timeout(2000) });
      assert.ok(response.ok);
      const lines = (await response.text()).split(/\r?\n/);
      return Object.fromEntries(["dropped_responses_after_disconnect_total", "connected_async_sources", "connection_id_cache_entries"].map(key => {
        const line = lines.find(line => line.startsWith("tiangz_scene_custom_metric_") && line.includes('name="connection_ingress"') && line.includes(`scene="${mainScene.name}"`) && line.includes(`key="${key}"`));
        assert.ok(line, `actual V8 source metric missing: ${key}`);
        return [key, Number(line.split(" ").at(-1))];
      }));
    };
    const baseline = await sourceMetrics(), disconnects = (await control.call(33)).count;
    const victim = await open(mainScene.port), waiting = handled(victim.call(1));
    try {
      await until(async () => (await control.call(3)).count === 1, "RPC body is waiting before disconnect");
      victim.close();
      await assert.rejects(waiting, error => error.name === "ClientConnectionClosedError");
      await until(async () => (await control.call(33)).count > disconnects, "TS receives the real connection close");
      assert.equal((await control.call(3)).count, 1, "disconnect must not fake business completion");
      const before = await admin("status"), op = begin(undefined, 422);
      await op.paused();
      const rejected = await op.pending;
      assert.equal(rejected.status, "rejected");
      assert.match(rejected.error, /drain deadline exceeded/);
      assert.equal((await admin("status")).hotfix.generation, before.hotfix.generation);
      await control.call(2);
      await until(async () => {
        const current = await sourceMetrics();
        return current.dropped_responses_after_disconnect_total === baseline.dropped_responses_after_disconnect_total + 1 &&
          current.connection_id_cache_entries === baseline.connection_id_cache_entries && current.connected_async_sources === 0;
      }, "late response suppressed and cache stays at connected baseline");
      const recovery = begin(); await recovery.paused(); await commit(recovery);
      assert.equal((await admin("status")).hotfix.generation, before.hotfix.generation + 1);
      return { suppressedResponses: 1, cacheReturnedToBaseline: true, realTaskDrainPreserved: true };
    } finally { victim.close(); await control.call(2); await waiting.catch(() => {}); }
  });
  for (let round = 0; round < rounds; round++) {
    await test(`remote-completion-and-500-queued-${round}`, async () => {
      const held = await holdRemote(), op = begin(); await op.paused();
      let completed = 0;
      const queued = peers.map(client => handled(checked(client, 0, activePair === 11 ? 22 : 11).then(value => { completed++; return value; })));
      await sleep(150); assert.equal(completed, 0, "new ingress bypassed pause");
      await workerControl.call(2); await held.pending;
      const pauseMs = await commit(op); await Promise.all(queued);
      return { queued: queued.length, pauseMs };
    });
    await test(`inner-capacity-safe-abort-${round}`, async () => {
      const held = await holdRemote(), before = await admin("status"), op = begin(undefined, 422); await op.paused();
      const forwarded = Array.from({ length: 256 }, () => checked(workerControl, 1000));
      const rejected = await op.pending;
      assert.match(JSON.stringify(rejected), /deferred inner request capacity/);
      assert.equal((await admin("status")).hotfix.generation, before.hotfix.generation);
      await workerControl.call(2); await held.pending; await Promise.all(forwarded);
      return { forwarded: forwarded.length };
    });
    await test(`disconnect-during-pause-${round}`, async () => {
      const held = await holdRemote(), op = begin(); await op.paused();
      const departed = await open(mainScene.port);
      const abandoned = departed.call().then(() => { throw new Error("disconnected queued request unexpectedly returned"); }, () => {});
      await sleep(60); departed.close(); await abandoned; await sleep(60);
      await workerControl.call(2); await held.pending; const pauseMs = await commit(op);
      await checked(control); // checkpoint detects any abandoned frame that executed late.
      return { pauseMs };
    });
  }
  await test("both-processes-paused-dependent-call-aborts-safely", async () => {
    const held = await holdRemote(), before = await admin("status"), workerBefore = await admin("status", undefined, 200, workerHealth);
    const op = begin(undefined, 422); await op.paused();
    const offset = worker.log.length;
    const workerApply = handled(admin("apply", { operationId: `worker-${operation++}`, candidateDirectory: candidates[1] }, 422, workerHealth));
    await until(() => worker.log.slice(offset).includes("Hotfix ingress pause started"), "worker pause");
    let released = false;
    const release = handled(workerControl.call(2).then(() => { released = true; }));
    await sleep(80); assert.equal(released, false, "worker release request must obey its admission pause");
    assert.match(JSON.stringify(await op.pending), /drain deadline exceeded/);
    assert.match(JSON.stringify(await workerApply), /drain deadline exceeded/);
    await release; await held.pending;
    assert.equal((await admin("status")).hotfix.generation, before.hotfix.generation);
    assert.equal((await admin("status", undefined, 200, workerHealth)).hotfix.generation, workerBefore.hotfix.generation);
    await checked(control);
    return { bothGenerationsPreserved: true };
  });
  if (proxy) {
    assert.equal((await control.call(13)).count, 0, "fixture namespace must be new");
    await test("real-db-save-response-delayed", async () => {
      proxy.hold(); const write = checked(control, 11); await until(() => proxy.pending() > 0, "DB save response buffered");
      const op = begin(); await op.paused(); await sleep(150); proxy.release();
      await write; const pauseMs = await commit(op); assert.equal((await control.call(13)).count, 42);
      return { pauseMs };
    });
    await test("real-db-read-exceeds-drain-deadline", async () => {
      proxy.hold(); const read = checked(control, 10); await until(() => proxy.pending() > 0, "DB read response buffered");
      const before = await admin("status"), op = begin(undefined, 422); await op.paused();
      const queued = peers.map(client => checked(client));
      assert.match(JSON.stringify(await op.pending), /drain deadline exceeded/);
      assert.equal((await admin("status")).hotfix.generation, before.hotfix.generation);
      proxy.release(); await read; await Promise.all(queued);
      return { queued: queued.length };
    });
    await test("real-db-reconnect-while-paused", async () => {
      proxy.hold(); const read = checked(control, 10);
      await until(() => proxy.pending() > 0, "DB reply buffered before drop");
      const op = begin(); await op.paused(); proxy.drop();
      await read; // SDK retries the same read after one reconnect; old code/config must remain pinned until completion.
      const pauseMs = await commit(op);
      assert.equal((await control.call(13)).count, 42, "reconnected DB must preserve committed value");
      return { pauseMs };
    });
    await test("real-db-unavailable-fails-and-recovers", async () => {
      proxy.hold(); const failed = control.call(10).then(() => false, () => true);
      await until(() => proxy.pending() > 0, "DB response held before outage");
      const op = begin(); await op.paused(); proxy.drop(true);
      assert.equal(await failed, true, "persistent unavailability must report failure");
      const pauseMs = await commit(op); proxy.online();
      assert.equal((await control.call(13)).count, 42); await checked(control);
      return { pauseMs };
    });
    await test("real-db-committed-write-loses-ack-only-once", async () => {
      assert.equal((await control.call(15)).count, 0);
      proxy.hold(); const write = checked(control, 14);
      await until(() => proxy.pending() > 0, "committed save response buffered");
      const op = begin(); await op.paused(); proxy.drop();
      await write; const pauseMs = await commit(op);
      assert.equal((await control.call(15)).count, 1, "same-ID retry must not advance persisted revision twice");
      return { pauseMs, persistedRevision: 1 };
    });
  }
  await checkpoint();
  const beforeStop = await admin("status"), held = await holdRemote(), op = begin(undefined, 422);
  await op.paused();
  const stopStarted = performance.now();
  const stopped = handled(stop(main));
  await sleep(100); await workerControl.call(2);
  await stopped; await held.pending.catch(() => {}); await op.pending.catch(() => {});
  assert.ok(!main.log.slice(main.log.lastIndexOf("Hotfix ingress pause started")).includes("Hotfix ingress resumed success=true"), "shutdown must not commit a waiting candidate");
  report.cases.push({ name: "shutdown-while-reload-pending", elapsedMs: performance.now() - stopStarted, previousGeneration: beforeStop.hotfix.generation });
  main = start(configPath, "main-restarted"); await ready(config.process.observability.health.port);
  const restarted = await open(mainScene.port);
  assert.equal((await restarted.call()).count, 43, "restart loads deployed initial pair, not a half-staged candidate");
  if (proxy) {
    assert.equal((await restarted.call(13)).count, 42, "restart must preserve real DB data");
    assert.equal((await restarted.call(15)).count, 1, "lost-ACK write must stay committed once after restart");
  }
  report.cases.push({ name: "restart-initial-pair-and-persistent-read" });
  assert.equal(cancelled, false, "test cancelled");
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = error.stack; process.exitCode = 1; console.error(error);
} finally {
  proxy?.release();
  for (const client of clients) client.close();
  for (const state of processes) {
    try { await stop(state); } catch (error) { report.status = "failed"; report.cleanupError = String(error); process.exitCode = 1; }
    await writeFile(path.join(directory, `${state.name}.log`), state.log);
  }
  if (proxy) await proxy.close();
  report.processes = processes.map(state => ({ name: state.name, exitCode: state.child.exitCode, forced: state.forced }));
  const cpu = process.cpuUsage(driverCpuStarted);
  report.driver = { elapsedMs: performance.now() - driverStarted, cpuMs: (cpu.user + cpu.system) / 1000, memory: process.memoryUsage() };
  report.finishedAt = new Date().toISOString(); await save();
  console.log(`[hotfix-faults] ${report.status}: ${reportPath}`);
}
