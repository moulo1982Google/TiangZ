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
const env = { ...process.env, TIANGZ_SOAK_TOKEN: "local-hotfix-soak", TIANGZ_WATCHER_CONTROL: "stdin" };
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
  const mainScene = { ...config.scenes[0], protocol: "auto", audience: "mixed" };
  const usedPorts = new Set([mainScene.port, config.process.observability.health.port]);
  const uniquePort = async () => { let port; do { port = await freePort(); } while (usedPorts.has(port)); usedPorts.add(port); return port; };
  const workerScene = { ...mainScene, name: "worker", port: await uniquePort() };
  const workerHealth = await uniquePort();
  config.scenes = [mainScene]; config.knownScenes = [workerScene];
  if (endpoint) {
    proxy = await responseProxy(endpoint);
    config.process.persistence = { dbProxy: { endpoint: proxy.endpoint, authTokenEnv: "TIANGZ_DBPROXY_AUTH_TOKEN", clientPoolSize: 1, requestTimeoutMs: 8000, connectTimeoutMs: 5000 } };
  }
  const workerConfig = { ...config, process: { ...config.process, name: "fault-worker", identity: { originServerId: 93, workerId: 0 },
    persistence: undefined, observability: { health: { ip: "127.0.0.1", port: workerHealth } } }, scenes: [workerScene], knownScenes: [mainScene] };
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
