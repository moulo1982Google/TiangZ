import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, access, rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const engine = path.resolve(import.meta.dirname, "..");
const values = new Map();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  if (!["--duration", "--reload-every", "--restart-every"].includes(args[index]) || values.has(args[index]) || !args[index + 1]) throw new Error("用法：game_project_soak.mjs [--duration 60 --reload-every 15 --restart-every 0]，单位秒");
  values.set(args[index], Number(args[++index]));
}
const duration = number("--duration", 60, 10, 21600);
const reloadEvery = number("--reload-every", 15, 5, 3600);
const restartEvery = number("--restart-every", 0, 0, 21600);
if (restartEvery > 0 && restartEvery < 30) throw new Error("restart-every 必须为 0 或至少 30 秒");
await mkdir(path.join(engine, "temp"), { recursive: true });
const temporary = await mkdtemp(path.join(engine, "temp", "module-dev-soak-"));
const project = path.join(temporary, "game with spaces");
const reportFile = path.join(temporary, "report.json");
const report = { formatVersion: 1, status: "running", startedAt: new Date().toISOString(), requestedDurationSeconds: duration, project,
  driverPid: process.pid, probes: 0, reloads: 0, rejectedCandidates: 0, restarts: 0, connections: 0, samples: [], error: undefined };
let child;
let exited;
let connection;
let output = "";
let lineBuffer = "";
const events = { ready: 0, reload: 0, rejected: 0, restart: 0 };
let connect;
let port;
let health;
let original;
let modelOriginal;
let expected = 0;
let step = 1;
const behavior = path.join(project, "modules/starter/src/hotfix/counter/CounterComponentSystem.ts");
const model = path.join(project, "modules/starter/src/model/counter/CounterComponent.ts");
let cancelled = false;
const cancel = () => { cancelled = true; };
process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
process.stdout.write(`[module-dev-soak] 报告：${reportFile}\n`);
try {
  port = await freePort();
  do { health = await freePort(); } while (health === port);
  execFileSync(process.execPath, ["tools/create_game_project.mjs", "--path", project, "--id", "org.example.soak", "--port", String(port), "--health-port", String(health)], { cwd: engine, encoding: "utf8", windowsHide: true, timeout: 60000 });
  execFileSync(process.execPath, ["tools/create_module_component.mjs", "--project", project, "--module", "org.example.soak", "--name", "Probe", "--feature", "probe"], { cwd: engine, encoding: "utf8", windowsHide: true, timeout: 30000 });
  original = await readFile(behavior, "utf8"); modelOriginal = await readFile(model, "utf8");
  const probe = path.join(temporary, "client.mjs");
  await build({ stdin: { contents: `import "../modules/starter/generated/typescript/Core/Net/BrowserWebSocketTransport";
import { RpcSocket } from "../modules/starter/generated/typescript/Core/Net/RpcSocket";
import { StarterClient } from "../modules/starter/generated/typescript/starter/protocol/clients";
export async function connect(port) {
  const socket = new RpcSocket({ transport: "websocket", host: "127.0.0.1", port });
  const client = new StarterClient(socket);
  const pump = setInterval(() => socket.update(), 10);
  const close = () => { clearInterval(pump); socket.close(); };
  const timeout = setTimeout(close, 10000);
  try { await socket.connect(); } catch (error) { close(); throw error; } finally { clearTimeout(timeout); }
  return { increment: async () => (await client.increment({})).count, close };
}`, resolveDir: path.join(project, "tools"), sourcefile: "soak-client.ts", loader: "ts" }, bundle: true, platform: "node", format: "esm", outfile: probe, logLevel: "silent" });
  ({ connect } = await import(pathToFileURL(probe).href));
  await start();
  const deadline = Date.now() + duration * 1000;
  let nextReload = Date.now() + reloadEvery * 1000;
  let nextRestart = restartEvery ? Date.now() + restartEvery * 1000 : Infinity;
  let nextSample = Date.now();
  while (Date.now() < deadline && !cancelled) {
    await increment();
    if (Date.now() >= nextReload && deadline - Date.now() > 8000) {
      await writeFile(model, modelOriginal);
      if (report.reloads % 4 === 3) {
        const rejected = events.rejected;
        await writeFile(behavior, original.replace("this.count += 1", "this.count += ???"));
        await until(() => events.rejected > rejected, "错误候选未被拒绝");
        report.rejectedCandidates++;
        await increment();
      }
      const reload = events.reload;
      const nextStep = step === 1 ? 2 : 1;
      await writeFile(behavior, original.replace("this.count += 1", `this.count += ${nextStep}`));
      await until(() => events.reload > reload, "兼容行为未完成热更");
      step = nextStep; report.reloads++;
      await increment();
      connection.close(); connection = await connect(port); report.connections++;
      await increment();
      assert.equal(events.restart, report.restarts, "原样保存不应触发额外重启提示");
      nextReload = Date.now() + reloadEvery * 1000;
    }
    if (Date.now() >= nextRestart && deadline - Date.now() > 20000) {
      const restart = events.restart;
      modelOriginal = modelOriginal.replace(/\n  protected soakRevision = \d+;/, "").replace("protected count = 0;", `protected count = 0;\n  protected soakRevision = ${report.restarts + 1};`);
      await writeFile(model, modelOriginal);
      await until(() => events.restart > restart, "Model 变化没有要求重启");
      await increment();
      await stop();
      report.restarts++;
      await start();
      nextRestart = Date.now() + restartEvery * 1000;
    }
    if (Date.now() >= nextSample) {
      await sample();
      nextSample = Date.now() + 30000;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  await stop();
  report.status = cancelled ? "cancelled" : "passed";
  if (cancelled) process.exitCode = 1;
} catch (error) {
  report.status = "failed"; report.error = error.stack ?? String(error); process.exitCode = 1;
  process.stderr.write(`[module-dev-soak] ${error.message}\n${output.slice(-6000)}\n`);
} finally {
  try { await stop(); } catch (error) { report.status = "failed"; report.error = `${report.error ?? ""}\ncleanup: ${error.message}`; process.exitCode = 1; }
  process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
  report.finishedAt = new Date().toISOString();
  await writeFile(reportFile, JSON.stringify(report, null, 2));
  // Only remove this test's generated game after its tracked child is gone; keep the report and failed fixture for diagnosis.
  if (report.status === "passed") await rm(project, { recursive: true, force: true });
  process.stdout.write(`[module-dev-soak] ${report.status}: probes=${report.probes} reloads=${report.reloads} rejected=${report.rejectedCandidates} restarts=${report.restarts}; ${reportFile}\n`);
}

async function start() {
  const ready = events.ready;
  child = spawn(process.execPath, ["tools/dev_runtime.mjs", "--project", project], { cwd: engine, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  report.developmentPid = child.pid;
  child.stdout.on("data", log); child.stderr.on("data", log);
  child.stdin.on("error", () => {});
  child.once("error", error => { output += error.message; });
  exited = new Promise(resolve => child.once("close", resolve));
  await until(async () => events.ready > ready && (await fetch(`http://127.0.0.1:${health}/ready`, { signal: AbortSignal.timeout(500) }).catch(() => undefined))?.ok, "开发进程未就绪");
  connection = await connect(port); report.connections++;
  expected = 0;
  await increment();
}
async function stop() {
  connection?.close(); connection = undefined;
  if (!child) return;
  const owned = child;
  if (owned.exitCode === null && owned.signalCode === null) {
    owned.stdin.end("shutdown\n");
    try { assert.equal(await bounded(exited, 25000), 0); }
    catch (error) {
      if (process.platform === "win32") {
        try { execFileSync("taskkill", ["/PID", String(owned.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { owned.kill(); }
      } else { try { process.kill(-owned.pid, "SIGTERM"); } catch { owned.kill(); } }
      await bounded(exited, 5000);
      throw new Error(`停机未正常完成：${error.message}`);
    }
  }
  assert.equal(await bounded(exited, 5000), 0, "开发宿主异常退出不能视为正常停机");
  child = undefined;
  await assert.rejects(access(path.join(project, ".tiangz-dev.lock")), { code: "ENOENT" });
}
async function increment() {
  expected += step;
  assert.equal(await bounded(connection.increment(), 10000), expected, "热更/重连后的计数必须连续，不得丢失状态或重复执行");
  report.probes++;
}
async function sample() {
  const response = await fetch(`http://127.0.0.1:${health}/metrics`, { signal: AbortSignal.timeout(2000) });
  assert.equal(response.ok, true);
  const metrics = await response.text();
  const read = name => Number(new RegExp(`^${name}\\{[^\\n]*\\} (\\d+)`, "m").exec(metrics)?.[1] ?? NaN);
  report.samples.push({ at: new Date().toISOString(), probes: report.probes, reloads: report.reloads, restarts: report.restarts,
    rssBytes: read("tiangz_process_rss_bytes"), v8HeapUsedBytes: read("tiangz_process_v8_heap_used_bytes") });
  await writeFile(reportFile, JSON.stringify(report, null, 2));
  process.stdout.write(`[module-dev-soak] probes=${report.probes} reloads=${report.reloads} rejected=${report.rejectedCandidates} restarts=${report.restarts}\n`);
}
function log(bytes) {
  const text = bytes.toString("utf8"); output = (output + text).slice(-100000); lineBuffer += text;
  let newline;
  while ((newline = lineBuffer.indexOf("\n")) !== -1) {
    const line = lineBuffer.slice(0, newline); lineBuffer = lineBuffer.slice(newline + 1);
    if (line.includes("正在监听")) events.ready++;
    if (line.includes("Hotfix reload completed")) events.reload++;
    if (line.includes("候选未发布")) events.rejected++;
    if (line.includes("需要重启")) events.restart++;
  }
}
async function until(predicate, message) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    if (cancelled) throw new Error("持续验收已取消");
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${message}：进程已退出`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
async function bounded(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`等待超时 (${ms}ms)`)), ms); })]); }
  finally { clearTimeout(timer); }
}
function number(key, fallback, min, max) {
  const value = values.get(key) ?? fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} 必须是 ${min}..${max} 的整数`);
  return value;
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
