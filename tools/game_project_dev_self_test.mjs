import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm, access, cp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { atomicReleaseId } from "./atomic_release_identity.mjs";

const engine = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(engine, "temp"), { recursive: true });
const temporary = await mkdtemp(path.join(engine, "temp", "project-dev-"));
const project = path.join(temporary, "game with spaces");
let child;
let exited;
let logs = "";
let connection;
try {
  const port = await freePort();
  let health = await freePort();
  while (health === port) health = await freePort();
  execFileSync(process.execPath, ["tools/create_game_project.mjs", "--path", project, "--id", "org.example.devtest", "--port", String(port), "--health-port", String(health)], { cwd: engine, encoding: "utf8", windowsHide: true, timeout: 60000 });
  const probe = path.join(project, "tools", "dev-probe.ts");
  // 真进程验证：业务每次请求同时使用热更方法和 Luban 表值。 / Exercise live behavior and Luban data together on every RPC.
  const moduleRoot = path.join(project, "modules/starter");
  const processConfigPath = path.join(project, "configs/local/counter.json");
  const processConfig = JSON.parse(await readFile(processConfigPath, "utf8"));
  processConfig.process.lifecycle = { hotfixOperations: { authTokenEnv: "TIANGZ_TEST_PAIRED_TOKEN" } };
  await writeFile(processConfigPath, JSON.stringify(processConfig));
  const admin = async (operation, body) => {
    const response = await fetch(`http://127.0.0.1:${health}/admin/hotfix/${operation}`, {
      method: body ? "POST" : "GET", headers: { Authorization: "Bearer paired-fixture", "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000),
    });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result;
  };
  const moduleManifestPath = path.join(moduleRoot, "tiangz.module.json");
  const moduleManifest = JSON.parse(await readFile(moduleManifestPath, "utf8"));
  moduleManifest.gameConfig = { project: "game_config/luban.conf", target: "server",
    generatedCode: "src/model/generated/config", generatedData: "game_config/generated" };
  await writeFile(moduleManifestPath, JSON.stringify(moduleManifest, null, 2));
  await mkdir(path.join(moduleRoot, "game_config/Defines"), { recursive: true });
  await mkdir(path.join(moduleRoot, "game_config/Data"), { recursive: true });
  await writeFile(path.join(moduleRoot, "game_config/luban.conf"), JSON.stringify({
    groups: [{ names: ["s"], default: true }], schemaFiles: [{ fileName: "Defines", type: "" }], dataDir: "Data",
    targets: [{ name: "server", manager: "Tables", groups: ["s"], topModule: "cfg" }], xargs: [],
  }));
  await writeFile(path.join(moduleRoot, "game_config/Defines/rules.xml"), '<module name="rules"><bean name="Rule"><var name="id" type="int"/><var name="cost" type="int"/></bean><table name="TbRule" value="Rule" input="*rules@rules.json"/></module>');
  const rulesPath = path.join(moduleRoot, "game_config/Data/rules.json");
  await writeFile(rulesPath, JSON.stringify({ rules: [{ id: 1, cost: 1 }] }));
  const behaviorPath = path.join(moduleRoot, "src/hotfix/counter/CounterComponentSystem.ts");
  await writeFile(behaviorPath, (await readFile(behaviorPath, "utf8"))
    .replace('import { systemFor }', 'import { ModuleConfigRegistry, systemFor }')
    .replace('this.count += 1;', 'this.count += 1 * (ModuleConfigRegistry.Get("org.example.devtest").tables.rules_tbrule as readonly { cost: number }[])[0]!.cost;'));
  await writeFile(probe, `import "../modules/starter/generated/typescript/Core/Net/BrowserWebSocketTransport";
import { RpcSocket } from "../modules/starter/generated/typescript/Core/Net/RpcSocket";
import { StarterClient } from "../modules/starter/generated/typescript/starter/protocol/clients";
export async function connect(port: number) {
  const socket = new RpcSocket({ transport: "websocket", host: "127.0.0.1", port });
  const client = new StarterClient(socket);
  const timer = setInterval(() => socket.update(), 10);
  try { await socket.connect(); } catch (error) { clearInterval(timer); socket.close(); throw error; }
  return { increment: () => client.increment({}), close: () => { clearInterval(timer); socket.close(); } };
}
`);
  const output = path.join(temporary, "dev-probe.mjs");
  await build({ entryPoints: [probe], outfile: output, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent" });
  child = spawn(process.execPath, ["tools/game_project.mjs", "dev", "--project", project], { cwd: engine, env: { ...process.env, TIANGZ_TEST_PAIRED_TOKEN: "paired-fixture" }, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.on("data", bytes => { logs += bytes; });
  child.stderr.on("data", bytes => { logs += bytes; });
  child.on("error", error => { logs += error.message; });
  exited = new Promise(resolve => child.once("close", resolve));
  await until(async () => {
    if (!logs.includes("正在监听")) return false;
    try { return (await fetch(`http://127.0.0.1:${health}/ready`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
  }, "initial readiness");
  connection = await (await import(pathToFileURL(output).href)).connect(port);
  assert.equal((await connection.increment()).count, 1);
  const behavior = path.join(project, "modules/starter/src/hotfix/counter/CounterComponentSystem.ts");
  const original = await readFile(behavior, "utf8");
  const model = path.join(project, "modules/starter/src/model/counter/CounterComponent.ts");
  const modelOriginal = await readFile(model, "utf8");
  await writeFile(model, modelOriginal);
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.doesNotMatch(logs, /需要重启/, "identical Model save must not disable behavior development");
  let checkpoint = logs.length;
  await writeFile(behavior, original.replace("this.count += 1", "this.count += 2"));
  await until(() => logs.slice(checkpoint).includes("Hotfix reload completed"), "behavior reload");
  assert.equal((await connection.increment()).count, 3, "same process preserved the old count and installed new behavior");
  const beforeConfig = await admin("status");
  checkpoint = logs.length;
  await writeFile(rulesPath, JSON.stringify({ rules: [{ id: 1, cost: 3 }] }));
  await until(() => logs.slice(checkpoint).includes("Hotfix reload completed"), "config-only paired reload");
  assert.equal((await connection.increment()).count, 9, "config-only release installed new tables with the active behavior, preserving count");
  const afterConfig = await admin("status");
  assert.notEqual(afterConfig.hotfix.bundleVersion, beforeConfig.hotfix.bundleVersion, "config-only changes get a distinct release identity");
  await admin("rollback", { operationId: "paired-config-rollback" });
  assert.equal((await connection.increment()).count, 11, "rollback restored the previous behavior/config pair, without rewinding business state");
  assert.equal((await admin("status")).hotfix.bundleVersion, beforeConfig.hotfix.bundleVersion);
  await admin("rollback", { operationId: "paired-config-roll-forward" });
  assert.equal((await admin("status")).hotfix.bundleVersion, afterConfig.hotfix.bundleVersion);
  // 文件哈希正确但缺表的候选也必须拒绝，活动代次不能变化。 / Reject schema-invalid data even with valid hashes, preserving the active generation.
  const invalidDirectory = path.join(temporary, "invalid-pair");
  await cp(afterConfig.hotfix.activeCandidateDirectory, invalidDirectory, { recursive: true });
  const configManifestPath = path.join(invalidDirectory, "game-config/game-config.manifest.json");
  const configManifest = JSON.parse(await readFile(configManifestPath, "utf8"));
  const payload = JSON.parse(configManifest.moduleConfigsJson);
  delete payload[0].tables.rules_tbrule;
  const hash = value => createHash("sha256").update(value).digest("hex");
  configManifest.moduleConfigsJson = JSON.stringify(payload);
  configManifest.moduleConfigsHash = hash(configManifest.moduleConfigsJson);
  const configBytes = JSON.stringify(configManifest);
  await writeFile(configManifestPath, configBytes);
  const hotfixManifestPath = path.join(invalidDirectory, "hotfix.manifest.json");
  const invalidManifest = JSON.parse(await readFile(hotfixManifestPath, "utf8"));
  invalidManifest.gameConfigHash = hash(configBytes);
  invalidManifest.releaseId = atomicReleaseId(invalidManifest);
  invalidManifest.bundleVersion = `${invalidManifest.bundleVersion.split("+")[0]}+${invalidManifest.releaseId}`;
  await writeFile(hotfixManifestPath, JSON.stringify(invalidManifest));
  const stableStatus = await admin("status");
  for (const [index, candidateDirectory] of [invalidDirectory, path.join(invalidDirectory, "game-config")].entries()) {
    const rejection = await fetch(`http://127.0.0.1:${health}/admin/hotfix/apply`, {
      method: "POST", headers: { Authorization: "Bearer paired-fixture", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: `paired-reject-${index}`, candidateDirectory }), signal: AbortSignal.timeout(20000),
    });
    assert.equal(rejection.status, 422, await rejection.text());
    assert.equal((await admin("status")).hotfix.generation, stableStatus.hotfix.generation);
    assert.equal((await admin("status")).hotfix.bundleVersion, stableStatus.hotfix.bundleVersion);
  }
  checkpoint = logs.length;
  await writeFile(behavior, original.replace("this.count += 1", "this.count += ???"));
  await until(() => logs.slice(checkpoint).includes("候选未发布"), "invalid candidate rejection");
  assert.equal((await connection.increment()).count, 17, "failed build kept the active behavior and tables");
  await writeFile(behavior, original.replace("this.count += 1", "this.count += 2"));
  checkpoint = logs.length;
  await writeFile(model, (await readFile(model, "utf8")).replace("protected count = 0;", "protected count = 0;\n  protected revision = 0;"));
  await until(() => logs.slice(checkpoint).includes("需要重启"), "Model restart notice");
  assert.equal((await connection.increment()).count, 23, "Model edit did not silently restart/reset runtime state");
  const lock = await readFile(path.join(project, ".tiangz-dev.lock"), "utf8");
  const request = execFileSync(process.execPath, ["tools/tiangz.mjs", "request"], { cwd: project, encoding: "utf8", windowsHide: true, timeout: 20000 });
  assert.match(request, /\[request\] count=29/);
  assert.equal(await readFile(path.join(project, ".tiangz-dev.lock"), "utf8"), lock, "request must not acquire or replace the running dev lock");
  connection.close(); connection = undefined;
  child.stdin.write("shutdown\n");
  assert.equal(await deadline(exited, 20000), 0, logs);
  await assert.rejects(access(path.join(project, ".tiangz-dev.lock")), { code: "ENOENT" });
  assert.doesNotMatch(logs, /cargo run|Compiling TiangZ/, "TS dev must not invoke Cargo");
  const checkBegins = [...logs.matchAll(/^\[tiangz-dev-check\] begin\r?$/gm)].length;
  const checkEnds = [...logs.matchAll(/^\[tiangz-dev-check\] end\r?$/gm)].length;
  assert.ok(checkBegins >= 3, "initial build, successful Hotfix and rejected candidate each delimit diagnostics");
  assert.equal(checkEnds, checkBegins, "failed checks also close their diagnostic cycle");
  child = spawn(process.execPath, ["tools/dev_runtime.mjs", "--project", project], { cwd: engine, env: { ...process.env, TIANGZ_TEST_PAIRED_TOKEN: "paired-fixture" }, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.on("data", bytes => { logs += bytes; });
  child.stderr.on("data", bytes => { logs += bytes; });
  exited = new Promise(resolve => child.once("close", resolve));
  child.stdin.end();
  assert.equal(await deadline(exited, 30000), 0, logs);
  await assert.rejects(access(path.join(project, ".tiangz-dev.lock")), { code: "ENOENT" });
  process.stdout.write("module project dev passed: real live Hotfix/config pair, config-only identity, paired rollback preserving state, syntax rejection, Model restart notice, graceful shutdown/early EOF and lock release\n");
} finally {
  connection?.close();
  if (child && child.exitCode === null) {
    child.stdin.end("shutdown\n");
    try { await deadline(exited, 20000); } catch {
      if (process.platform === "win32") {
        try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { child.kill(); }
      } else { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); } }
      await deadline(exited, 5000);
    }
  }
  await rm(temporary, { recursive: true, force: true });
}

async function until(predicate, description) {
  const timeout = Date.now() + 45000;
  while (Date.now() < timeout) {
    if (await predicate()) return;
    if (child.exitCode !== null) throw new Error(`${description}: development process exited\n${logs}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${description} timed out\n${logs}`);
}
async function deadline(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`development process timeout\n${logs}`)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
