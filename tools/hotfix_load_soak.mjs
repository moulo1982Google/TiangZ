import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, cp } from "node:fs/promises";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { immutableCandidateFromOutput } from "./build_result.mjs";
import { resolveModuleRuntimeBinary } from "./module_runtime_binary.mjs";
import { installActorQuotaFixture } from "./hotfix_actor_quota_fixture.mjs";
import { installLocalSceneQuotaFixture } from "./hotfix_local_scene_quota_fixture.mjs";
import { installHostOperationFixture } from "./hotfix_host_operation_fixture.mjs";
import { installRemoteDeadlineFixture } from "./hotfix_remote_deadline_fixture.mjs";
import { installControlIngressFixture } from "./hotfix_control_ingress_fixture.mjs";

// 独立本机夹具；所有写入都在本轮临时工程，保留报告和失败现场。
// Isolated local fixture; writes stay in this run's temporary project, retaining evidence.
const engine = path.resolve(import.meta.dirname, "..");
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!["--seconds", "--clients", "--reload-seconds", "--requests-per-second", "--rpc-timeout-ms", "--prepare-only"].includes(key) || options.has(key)) throw new Error(`未知或重复参数 ${key}`);
  options.set(key, Number(process.argv[i + 1]));
}
function option(key, fallback, min, max) {
  const value = options.get(key) ?? fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} 必须在 ${min}..${max}`);
  return value;
}
const seconds = option("--seconds", 60, 15, 86400);
const clients = option("--clients", 20, 1, 2000);
const reloadSeconds = option("--reload-seconds", 10, 5, 3600);
const rate = option("--requests-per-second", 2, 1, 10);
const rpcTimeoutMs = option("--rpc-timeout-ms", 30000, 100, 120000);
const prepareOnly = option("--prepare-only", 0, 0, 1) === 1;
if (seconds * clients * rate > 130_000_000) throw new Error("请求总预算超出夹具uint32序号容量，请降低负载或时长");
const env = { ...process.env, TIANGZ_SOAK_TOKEN: "local-hotfix-soak", TIANGZ_WATCHER_CONTROL: "stdin" };
for (const key of ["CC", "CXX"]) if (/^(gcc|g\+\+)(\.exe)?$/i.test(path.basename(env[key] ?? ""))) delete env[key];
await mkdir(path.join(engine, "temp"), { recursive: true });
const directory = await mkdtemp(path.join(engine, "temp", "hotfix-load-"));
const project = path.join(directory, "game");
const reportPath = path.join(directory, "report.json");
const report = { status: "running", directory, startedAt: new Date().toISOString(), seconds, clients, requestsPerSecondPerClient: rate,
  rpcTimeoutMs,
  reloadSeconds, requests: 0, responses: 0, responsesByPair: { 11: 0, 22: 0 }, rpcErrors: 0, duplicateResponses: 0, mixedPairs: 0, reloads: [], samples: [], maxRpcMs: 0, latencyBuckets: Array(9).fill(0), faults: [] };
let server, serverExit, log = "", cancelled = false, running = true;
const connections = [];
const seenChunks = new Map();
let maximumSequence = 0;
const limits = [1, 5, 10, 25, 50, 100, 500, 3000, Infinity];
process.once("SIGINT", () => { cancelled = true; running = false; });
process.once("SIGTERM", () => { cancelled = true; running = false; });
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
console.log(`[hotfix-load] ${reportPath}`);
await save();

function run(args, cwd = engine) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    const timer = setTimeout(() => child.kill(), 180000);
    child.stdout.on("data", bytes => { text += bytes; }); child.stderr.on("data", bytes => { text += bytes; });
    child.on("error", reject);
    child.on("close", code => { clearTimeout(timer); code === 0 ? resolve(text) : reject(new Error(`${args.join(" ")} exited ${code}\n${text.slice(-10000)}`)); });
  });
}
async function port() {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const value = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return value;
}
async function until(check, label, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end && !cancelled) {
    if (await check()) return;
    if (server && server.exitCode !== null) throw new Error(`server exited during ${label}\n${log.slice(-6000)}`);
    await sleep(25);
  }
  throw new Error(`timeout: ${label}`);
}

try {
  const wsPort = await port();
  let healthPort; do { healthPort = await port(); } while (wsPort === healthPort);
  await run(["tools/create_game_project.mjs", "--path", project, "--id", "org.example.hotfixload", "--port", String(wsPort), "--health-port", String(healthPort)]);
  const module = path.join(project, "modules/starter");
  const configPath = path.join(project, "configs/local/counter.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.process.lifecycle = { hotfixReloadTimeoutMs: 3000, hotfixOperations: { authTokenEnv: "TIANGZ_SOAK_TOKEN" } };
  await writeFile(configPath, JSON.stringify(config));
  const manifestPath = path.join(module, "tiangz.module.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.gameConfig = { project: "game_config/luban.conf", target: "server", generatedCode: "src/model/generated/config", generatedData: "game_config/generated" };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await mkdir(path.join(module, "game_config/Defines"), { recursive: true });
  await mkdir(path.join(module, "game_config/Data"), { recursive: true });
  await writeFile(path.join(module, "game_config/luban.conf"), JSON.stringify({ groups: [{ names: ["s"], default: true }], schemaFiles: [{ fileName: "Defines", type: "" }], dataDir: "Data", targets: [{ name: "server", manager: "Tables", groups: ["s"], topModule: "cfg" }], xargs: [] }));
  await writeFile(path.join(module, "game_config/Defines/rules.xml"), '<module name="rules"><bean name="Rule"><var name="id" type="int"/><var name="cost" type="int"/></bean><table name="TbRule" value="Rule" input="*rules@rules.json"/></module>');
  const rules = path.join(module, "game_config/Data/rules.json");
  const behavior = path.join(module, "src/hotfix/counter/CounterComponentSystem.ts");
  const handlerPath = path.join(module, "src/hotfix/counter/handlers/IncrementHandler.ts");
  const original = await readFile(behavior, "utf8");
  const setPair = async pair => {
    await writeFile(rules, JSON.stringify({ rules: [{ id: 1, cost: pair }] }));
    await writeFile(behavior, original.replace('import { systemFor }', 'import { ModuleConfigRegistry, systemFor }')
      .replace("return this.count;", `return this.count * 32 + ${pair * 10} + (ModuleConfigRegistry.Get("org.example.hotfixload").tables.rules_tbrule as readonly { cost: number }[])[0]!.cost;`));
    await writeFile(handlerPath, (await readFile(handlerPath, "utf8")).replace(/const codeVersion = \d+;/, `const codeVersion = ${pair * 10};`));
  };
  await setPair(1);
  // 夹具协议显式增加控制模式，走正式生成器；绝不手改生成SDK。
  const proto = path.join(module, "proto/Starter_C_40000.proto");
  await writeFile(proto, (await readFile(proto, "utf8")).replace(/message C2S_Increment \/\/ IRequest\r?\n\{/, "message C2S_Increment // IRequest\n{\n  uint32 mode = 1;"));
  await writeFile(path.join(module, "proto/Starter_S_22000.proto"), `syntax = "proto3";
package starter;
//ResponseType S2S_WorkResponse
// @ets.msg protocol=Starter method=Work
message S2S_Work // IRequest
{
  uint32 mode = 1;
}
message S2S_WorkResponse // IResponse
{
  uint32 count = 1;
}
`);
  await writeFile(path.join(module, "src/model/counter/CounterScene.ts"), `import { EntryScene, entryScene, DbProxyEntityRepository, ActorUnit, actor, Scene, scene } from "#tiangz/core";
@actor({ mailbox: "ordered" })
export class DrainActor extends ActorUnit {}
@scene({ sceneType: "DrainScene" })
export class DrainScene extends Scene {}
@entryScene()
export class CounterScene extends EntryScene {
  protected override readonly mailbox = "unordered" as const;
  holdResolve: (() => void) | null = null;
  completed = 0;
  drainActor: DrainActor | undefined;
  detachedState = 0;
  detachedValue = 0;
  spawnQuotaOwners: DrainScene[] = [];
  spawnQuotaRelease: (() => void) | undefined;
  disconnectedClients = 0;
  protected override onDisconnect(_connectionId: number): void { this.disconnectedClients += 1; }
  readonly repository = new DbProxyEntityRepository<number, number>({
    recordNamespace: ${JSON.stringify(`hotfix-fault-${path.basename(directory)}`)}, schema: "hotfix-fault", schemaVersion: 1,
    Capture: value => value, Encode: value => new Uint8Array([value]), Decode: bytes => bytes[0]!
  }, "hotfix-fault");
}
`);
  const modelIndex = path.join(module, "src/model/index.ts");
  await writeFile(modelIndex, (await readFile(modelIndex, "utf8"))
    .replace('import { CounterScene }', 'import { CounterScene, DrainActor, DrainScene }')
    .replace('export { CounterScene,', 'export { CounterScene, DrainActor, DrainScene,')
    .replace('modelExports: { CounterScene,', 'modelExports: { CounterScene, DrainActor, DrainScene,'));
  await writeFile(handlerPath, `import { rpcHandler, TimerSystem, type SceneRpcHandler } from "#tiangz/model";
import { CounterScene, CounterComponent, DrainActor, DrainScene, StarterProtocol, type C2S_Increment, type S2C_Increment } from "#tiangz/module";
@rpcHandler(CounterScene, StarterProtocol.Increment)
@rpcHandler(CounterScene, StarterProtocol.Work)
export class IncrementHandler implements SceneRpcHandler<CounterScene, C2S_Increment, S2C_Increment> {
  async handle(scene: CounterScene, request: C2S_Increment): Promise<S2C_Increment> {
    const codeVersion = 10;
    if (request.mode === 1) {
      if (scene.holdResolve) throw new Error("fixture already held");
      await new Promise<void>(resolve => { scene.holdResolve = resolve; });
      return { count: 0 };
    }
    if (request.mode === 2) { scene.holdResolve?.(); scene.holdResolve = null; return { count: 0 }; }
    if (request.mode === 3) return { count: scene.holdResolve ? 1 : 0 };
    if (request.mode === 9) return { count: scene.completed };
    if (request.mode === 13) return { count: (await scene.repository.Load("probe"))?.data ?? 0 };
    if (request.mode === 15) return { count: Number((await scene.repository.Load("ack-loss"))?.revision ?? 0n) };
    if (request.mode === 18) return { count: scene.detachedValue };
    if (request.mode === 19) return { count: scene.detachedState };
    if (request.mode === 33) return { count: scene.disconnectedClients };
    // 夹具刻意只观察结果，不用 Tasks.Spawn 代替 mailbox 自己的屏障计数。 / The fixture observes results without masking mailbox activity via Tasks.Spawn.
    if (request.mode === 16 || request.mode === 17) {
      if (scene.holdResolve || scene.detachedState === 1) throw new Error("fixture already held");
      const actor = scene.drainActor ??= scene.SpawnActor(99, DrainActor);
      scene.detachedState = 1;
      void Promise.resolve(scene.RunLocalActorMailbox(actor, async current => {
        await new Promise<void>(resolve => { scene.holdResolve = resolve; });
        if (current.IsDisposed) return 0;
        const encoded = scene.GetComponent(CounterComponent).Increment();
        scene.completed++;
        return Math.floor(encoded / 32) * 32 + codeVersion + (encoded % 32) % 10;
      })).then(value => { scene.detachedValue = value; scene.detachedState = 2; }, () => { scene.detachedState = 3; });
      if (request.mode === 17) { scene.DespawnActor(99); scene.drainActor = undefined; }
      return { count: 0 };
    }
    if (request.mode === 20) {
      scene.detachedState = 1;
      void scene.scenes.call(scene.scenes.byName("local-target"), StarterProtocol.Work, { mode: 1 })
        .then(() => { scene.detachedState = 2; }, () => { scene.detachedState = 3; });
      return { count: 0 };
    }
    if (request.mode === 21 || request.mode === 22) return scene.scenes.call(scene.scenes.byName("local-target"), StarterProtocol.Work, { mode: request.mode === 21 ? 3 : 2 });
    if (request.mode === 23) {
      if (scene.holdResolve || scene.detachedState === 1) throw new Error("fixture already held");
      const owner = scene.SpawnChildScene("drain-task", DrainScene);
      scene.detachedState = 1;
      await new Promise<void>(started => {
        owner.Tasks.Spawn("held-result", async ({ signal }) => {
          started();
          await new Promise<void>(resolve => { scene.holdResolve = resolve; });
          // 仅向仍存活的夹具记录结果；已取消时不再执行子 Scene 业务。 / Report to the live fixture without performing cancelled child Scene work.
          scene.detachedState = signal.aborted ? 2 : 3;
        });
      });
      if (!scene.DespawnChildScene("drain-task") || !owner.IsDisposed) throw new Error("child Scene must be disposed before acknowledgement");
      return { count: 0 };
    }
    if (request.mode === 24) {
      const owner = scene.SpawnChildScene("failed-task-admission", DrainScene);
      const timers = TimerSystem.Instance, original = timers.NewOnceTimer;
      const failure = new Error("injected watchdog registration failure");
      scene.detachedState = 0;
      try {
        // 只在此同步夹具栈内注入注册失败，返回请求前恢复原服务方法。 / Inject only within this synchronous fixture stack and restore before returning.
        timers.NewOnceTimer = () => { throw failure; };
        try {
          owner.Tasks.Spawn("must-not-run", () => { scene.detachedState = 99; });
          throw new Error("Spawn must propagate watchdog failure");
        } catch (error) { if (error !== failure) throw error; }
      } finally { timers.NewOnceTimer = original; }
      return { count: owner.Tasks.InFlightCount };
    }
    if (request.mode === 25) return { count: scene.DespawnChildScene("failed-task-admission") ? 1 : 0 };
    if (request.mode === 26) {
      if (scene.spawnQuotaOwners.length) throw new Error("spawn quota fixture already active");
      const result = new Promise<void>(resolve => { scene.spawnQuotaRelease = resolve; });
      for (let i = 0; i < 17; i++) {
        const owner = scene.SpawnChildScene("spawn-quota-" + i, DrainScene);
        scene.spawnQuotaOwners.push(owner);
        if (i < 16) for (let task = 0; task < 256; task++) owner.Tasks.Spawn("held-quota", () => result);
      }
      return { count: scene.spawnQuotaOwners.reduce((count, owner) => count + owner.Tasks.InFlightCount, 0) };
    }
    if (request.mode === 27) {
      scene.spawnQuotaOwners[16]!.Tasks.Spawn("probe-quota", () => { scene.detachedValue += 1; });
      return { count: 1 };
    }
    if (request.mode === 28) {
      scene.spawnQuotaRelease?.(); scene.spawnQuotaRelease = undefined;
      return { count: 0 };
    }
    if (request.mode === 29) return { count: scene.spawnQuotaOwners.reduce((count, owner) => count + owner.Tasks.InFlightCount, 0) };
    if (request.mode === 30) return { count: scene.detachedValue };
    if (request.mode === 31) {
      let removed = 0;
      for (let i = 0; i < 16; i++) if (scene.DespawnChildScene("spawn-quota-" + i)) removed++;
      return { count: removed };
    }
    if (request.mode === 32) {
      for (let i = 0; i < 17; i++) scene.DespawnChildScene("spawn-quota-" + i);
      scene.spawnQuotaOwners.length = 0;
      return { count: 0 };
    }
    if ((request.mode ?? 0) >= 1000) return scene.scenes.call(scene.scenes.byName("counter"), StarterProtocol.Work, { mode: (request.mode ?? 0) - 1000 }, { timeoutMs: 30000 });
    if (request.mode === 4) await scene.scenes.call(scene.scenes.byName("worker"), StarterProtocol.Work, { mode: 1 }, { timeoutMs: 30000 });
    if (request.mode === 10 && (await scene.repository.Load("probe"))?.data !== 42) throw new Error("stored fixture value changed");
    if (request.mode === 11) await scene.repository.SaveSnapshot("probe", 42, 0n);
    if (request.mode === 14) await scene.repository.SaveSnapshot("ack-loss", 42, 0n);
    await Promise.resolve(); // 在等待前捕获代码版本、等待后读配置，检测跨代混用。 / Capture code before awaiting and read config afterward.
    const encoded = scene.GetComponent(CounterComponent).Increment();
    scene.completed++;
    return { count: Math.floor(encoded / 32) * 32 + codeVersion + (encoded % 32) % 10 };
  }
}
`);
  await installActorQuotaFixture(module);
  await installLocalSceneQuotaFixture(module);
  await installHostOperationFixture(module);
  await installRemoteDeadlineFixture(module);
  await installControlIngressFixture(module);
  await run(["tools/game_project.mjs", "protocol-update", "--project", project]);
  await run(["tools/game_project.mjs", "build", "--project", project]);
  const candidates = [path.join(directory, "pair-1"), path.join(directory, "pair-2")];
  await cp(path.join(project, "dist"), candidates[0], { recursive: true });
  await setPair(2);
  await run(["tools/codegen_module_configs.mjs", "--modules-dir", path.join(project, "modules")]);
  const built = await run(["tools/build_runtime_bundles.mjs", "--host-profile", "modules", "--modules-dir", path.join(project, "modules"), "--out-dir", path.join(project, "dist"), "--hotfix-only"]);
  const second = immutableCandidateFromOutput(built, "hotfix", path.join(project, "dist"));
  await cp(second, candidates[1], { recursive: true });
  for (const [index, directory] of candidates.entries()) {
    const config = JSON.parse(await readFile(path.join(directory, "game-config/game-config.manifest.json"), "utf8"));
    assert.equal(JSON.parse(config.moduleConfigsJson)[0].tables.rules_tbrule[0].cost, index + 1, "fixture must package regenerated Luban data");
  }
  const probe = path.join(directory, "client.mjs");
  await build({ stdin: { contents: `import "../modules/starter/generated/typescript/Core/Net/BrowserWebSocketTransport";
import { RpcSocket } from "../modules/starter/generated/typescript/Core/Net/RpcSocket";
import { StarterClient } from "../modules/starter/generated/typescript/starter/protocol/clients";
import { StarterProtocol as InternalProtocol } from "../modules/starter/src/model/generated/protocol/starter/protocol/rpcs";
export const innerWorkProtocol = InternalProtocol.Work;
export async function connect(port) {
  const socket = new RpcSocket({ transport: "websocket", host: "127.0.0.1", port }, { defaultTimeoutMs: ${rpcTimeoutMs} });
  const client = new StarterClient(socket);
  const timer = setInterval(() => socket.update(), 10);
  const close = () => { clearInterval(timer); socket.close(); };
  try { await socket.connect(); } catch(error) { close(); throw error; }
  return { call: (mode = 0) => client.increment({ mode }), sendQuota: (actorIndex = 0) => client.actorQuota({ actorIndex }), sendLocalQuota: (sceneIndex = 0) => client.localQuota({ sceneIndex }), closed: () => socket.state === "closed", close };
}`, resolveDir: path.join(project, "tools"), sourcefile: "load-client.ts", loader: "ts" }, outfile: probe, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent" });
  const { connect } = await import(pathToFileURL(probe).href);
  const binary = await resolveModuleRuntimeBinary({ engineRoot: engine, modulesDirectory: path.join(project, "modules") });
  report.binarySha256 = createHash("sha256").update(await readFile(binary)).digest("hex");
  if (prepareOnly) {
    report.fixture = { project, candidates, probe, binary, configPath };
    report.status = "prepared";
  } else {
  server = spawn(binary, [`--runtime-root=${project}`, configPath], { cwd: project, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  server.stdout.on("data", bytes => { log += bytes; }); server.stderr.on("data", bytes => { log += bytes; });
  serverExit = new Promise((resolve, reject) => { server.once("close", resolve); server.once("error", reject); });
  const admin = async (action, body, expected = 200) => {
    const response = await fetch(`http://127.0.0.1:${healthPort}/admin/hotfix/${action}`, { method: body ? "POST" : "GET", headers: { Authorization: "Bearer local-hotfix-soak", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value;
  };
  const metrics = async () => {
    const response = await fetch(`http://127.0.0.1:${healthPort}/metrics`, { signal: AbortSignal.timeout(5000) });
    assert.ok(response.ok);
    return (await response.text()).split(/\r?\n/).filter(line => !line.startsWith("#") && /rss_bytes|v8_heap|queue.*depth|pending|connections/.test(line));
  };
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${healthPort}/ready`)).ok; } catch { return false; } }, "readiness");
  const control = await connect(wsPort); connections.push(control);
  const initial = await admin("status");
  report.initial = initial;
  // 真实在途Promise：不是 await 时间，由另一条业务请求显式完成。
  const held = control.call(1);
  await until(async () => (await control.call(3)).count === 1, "held request admitted");
  const start = performance.now();
  await admin("apply", { operationId: "drain-timeout", candidateDirectory: candidates[1] }, 422);
  const timeoutElapsed = performance.now() - start;
  assert.ok(timeoutElapsed >= 2800 && timeoutElapsed < 8000, `drain timeout must respect its budget, actual=${timeoutElapsed}`);
  report.faults.push({ name: "drain-timeout", elapsedMs: timeoutElapsed });
  assert.equal((await admin("status")).hotfix.generation, initial.hotfix.generation);
  await control.call(2); await held;
  const malformed = path.join(directory, "bad-pair");
  await cp(candidates[1], malformed, { recursive: true });
  await writeFile(path.join(malformed, "game-config/game-config.manifest.json"), "{}");
  await admin("apply", { operationId: "reject-bad-pair", candidateDirectory: malformed }, 422);
  assert.equal((await admin("status")).hotfix.generation, initial.hotfix.generation);
  report.faults.push({ name: "bad-pair-rejected" });
  const accept = response => {
    const pair = response.count % 32;
    if (pair !== 11 && pair !== 22) report.mixedPairs++;
    else report.responsesByPair[pair]++;
    const sequence = Math.floor(response.count / 32);
    const chunkId = Math.floor(sequence / 524288);
    let chunk = seenChunks.get(chunkId);
    if (!chunk) { chunk = new Uint8Array(65536); seenChunks.set(chunkId, chunk); }
    const within = sequence % 524288, offset = Math.floor(within / 8), bit = 1 << (within % 8);
    if (chunk[offset] & bit) report.duplicateResponses++;
    chunk[offset] |= bit; maximumSequence = Math.max(maximumSequence, sequence);
    report.responses++;
  };
  for (let i = 0; i < clients; i++) connections.push(await connect(wsPort));
  const loadStarted = Date.now();
  report.loadStartedAt = new Date(loadStarted).toISOString();
  const end = loadStarted + seconds * 1000;
  const loops = connections.slice(1).map(async (client, index) => {
    await sleep(index % 100);
    while (running && Date.now() < end && !cancelled) {
      const begin = performance.now(); report.requests++;
      try {
        accept(await client.call());
        const elapsed = performance.now() - begin;
        report.maxRpcMs = Math.max(report.maxRpcMs, elapsed);
        report.latencyBuckets[limits.findIndex(limit => elapsed <= limit)]++;
      } catch(error) { report.rpcErrors++; report.error ??= error.message; running = false; }
      await sleep(Math.max(0, 1000 / rate - (performance.now() - begin)));
    }
  });
  let nextReload = loadStarted + reloadSeconds * 1000;
  let nextSample = loadStarted;
  let pairIndex = 1;
  while (Date.now() < end && running && !cancelled) {
    if (Date.now() >= nextReload) {
      const result = await admin("apply", { operationId: `load-${report.reloads.length}`, candidateDirectory: candidates[pairIndex] });
      assert.ok(result.report.pauseMs < 3000, `observed pause exceeded budget: ${result.report.pauseMs}`);
      report.requests++;
      const published = await control.call();
      accept(published);
      assert.equal(published.count % 32, (pairIndex + 1) * 11, "published behavior and config must match the requested pair");
      report.reloads.push({ at: new Date().toISOString(), result });
      pairIndex = 1 - pairIndex;
      if (report.reloads.length === 2) {
        const stable = await admin("status");
        await admin("apply", { operationId: "bad-pair-under-load", candidateDirectory: malformed }, 422);
        const heldUnderLoad = control.call(1);
        await until(async () => (await control.call(3)).count === 1, "held under load");
        const faultStarted = performance.now();
        await admin("apply", { operationId: "timeout-under-load", candidateDirectory: candidates[pairIndex] }, 422);
        const elapsedMs = performance.now() - faultStarted;
        assert.equal((await admin("status")).hotfix.generation, stable.hotfix.generation);
        await control.call(2); await heldUnderLoad;
        report.faults.push({ name: "timeout-and-invalid-pair-under-load", elapsedMs });
      }
      nextReload = report.reloads.length >= Math.floor(seconds / reloadSeconds)
        ? Infinity : Math.min(loadStarted + (report.reloads.length + 1) * reloadSeconds * 1000, end - 1000);
    }
    if (Date.now() >= nextSample) {
      report.samples.push({ elapsedSeconds: (Date.now() - loadStarted) / 1000, responses: report.responses, maxRpcMs: report.maxRpcMs, driverMemory: process.memoryUsage(), runtimeMetrics: await metrics(), status: await admin("status") });
      console.log(`[hotfix-load] elapsed=${Math.round((Date.now() - loadStarted) / 1000)}s clients=${clients} responses=${report.responses} reloads=${report.reloads.length} errors=${report.rpcErrors}`);
      await save(); await writeFile(path.join(directory, "server.log"), log);
      nextSample += 30000;
    }
    await sleep(50);
  }
  running = false; await Promise.all(loops);
  assert.equal(cancelled, false, "test cancelled");
  await admin("rollback", { operationId: "paired-rollback" });
  report.requests++;
  const rolledBack = await control.call();
  accept(rolledBack);
  assert.equal(rolledBack.count % 32, (pairIndex + 1) * 11, "rollback must restore the previous behavior/config pair");
  report.final = await admin("status");
  report.finalMetrics = await metrics();
  assert.equal(report.rpcErrors, 0); assert.equal(report.mixedPairs, 0); assert.equal(report.duplicateResponses, 0);
  assert.equal(report.requests, report.responses); assert.equal(maximumSequence, report.responses, "server sequence must have no missing or unacknowledged execution");
  assert.ok(report.reloads.length >= Math.floor(seconds / reloadSeconds));
  report.completedLoadSeconds = (Date.now() - loadStarted) / 1000;
  report.status = "passed";
  }
} catch(error) {
  report.status = "failed"; report.error = error.stack; process.exitCode = 1;
  console.error(error);
} finally {
  running = false;
  for (const connection of connections) connection.close();
  if (server && server.exitCode === null) {
    server.stdin.end("shutdown\n");
    let stopTimer;
    try { await Promise.race([serverExit, new Promise(resolve => { stopTimer = setTimeout(resolve, 10000); })]); }
    finally { clearTimeout(stopTimer); }
    if (server.exitCode === null) {
      report.forcedStop = true;
      server.kill(); await serverExit;
    }
  }
  if (server) {
    report.serverExitCode = server.exitCode;
    if (report.forcedStop || server.exitCode !== 0) {
      report.status = "failed";
      report.error ??= `server did not stop cleanly: exit=${server.exitCode}, forced=${!!report.forcedStop}`;
      process.exitCode = 1;
    }
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(directory, "server.log"), log);
  await save(); console.log(`[hotfix-load] ${report.status}: ${reportPath}`);
}
