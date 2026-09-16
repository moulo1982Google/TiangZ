import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

// Only starts owned memory-backend processes; never accepts an existing database endpoint.
const root = path.resolve(import.meta.dirname, "..");
const dbRoot = path.resolve(root, "../TiangZ-DBProxy");
const suffix = process.platform === "win32" ? ".exe" : "";
await mkdir(path.join(root, "temp"), { recursive: true });
const fixture = await mkdtemp(path.join(root, "temp/global-id-runtime-"));
const moduleRoot = path.join(fixture, "modules/probe");
const modules = path.dirname(moduleRoot);
const output = path.join(fixture, "dist");
const children = [];
const token = randomBytes(32).toString("hex");
const run = args => execFileSync(process.execPath, args, { cwd: root, encoding: "utf8", windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TIANGZ_MODULES_DIR: modules }, timeout: 60000 });

try {
  await mkdir(path.join(fixture, "configs"));
  run(["tools/create_game_module.mjs", "--id", "org.example.idprobe", "--path", moduleRoot]);
  await writeFile(path.join(moduleRoot, "src/model/index.ts"), `import { EntryScene, entryScene, defineGameModule, GlobalIdSystem } from "#tiangz/core";
// Fixture-only frozen clock makes same-second restarts deterministic.
Date.now = () => 1790000000000;
@entryScene()
export class IdProbeScene extends EntryScene {
  private readonly constructedId = GlobalIdSystem.Instance.Next();
  protected override onStart(): void {
    const ids = [this.constructedId];
    for (let i = 0; i < 8; i++) ids.push(GlobalIdSystem.Instance.Next());
    this.logger.info("GLOBAL_ID_PROBE " + ids.map(id => id.toString()).join(","));
  }
}
defineGameModule({ id: "org.example.idprobe", version: "0.1.0", modelExports: { IdProbeScene } });
`);
  await writeFile(path.join(moduleRoot, "src/hotfix/index.ts"), "export {};\n");
  run(["tools/prepare_game_modules.mjs", "--modules-dir", modules]);
  run(["tools/build_runtime_bundles.mjs", "--modules-dir", modules, "--out-dir", output]);
  run(["tools/build_game_config_data.mjs", "--modules-dir", modules, "--out-dir", output, "--initial"]);

  const dbPort = await freePort();
  const config = JSON.parse(await readFile(path.join(dbRoot, "configs/perf-memory-4.json"), "utf8"));
  delete config.$schema; delete config.observability;
  config.server.listenAddr = `127.0.0.1:${dbPort}`;
  config.server.authTokenEnv = "ID_PROBE_TOKEN";
  await writeFile(path.join(fixture, "dbproxy.json"), JSON.stringify(config));
  const db = launch(path.join(dbRoot, `target/debug/tiangz-dbproxy-server${suffix}`), ["--config", path.join(fixture, "dbproxy.json")]);
  await until(() => /TiangZ DBProxy started/.test(db.logs()), db, "memory DBProxy listener");

  const first = await probe("first", dbPort);
  const restart = await probe("restart", dbPort);
  const concurrent = await Promise.all([probe("parallel-a", dbPort), probe("parallel-b", dbPort)]);
  const ids = [...first, ...restart, ...concurrent.flat()];
  assert.equal(new Set(ids).size, ids.length, "processes shared persistent IDs");
  for (const id of ids.map(BigInt)) {
    assert.equal(id >> 49n, 73n);
    assert.equal((id >> 12n) & 127n, 2n);
    assert.ok(id > 0n && id < 1n << 63n);
  }
  assert.ok(BigInt(restart[0]) > BigInt(first.at(-1)));
  console.log("global IDs passed: real TiangZ restart and concurrent same-slot processes, frozen clock, SDK/TCP/owned memory DBProxy; PostgreSQL durability not tested");
} finally {
  await Promise.all(children.map(async child => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    if (child.exitCode === null && child.signalCode === null) await Promise.race([
      new Promise(resolve => child.once("close", resolve)), new Promise(resolve => setTimeout(resolve, 5000).unref()),
    ]);
    if (child.exitCode === null && child.signalCode === null) throw new Error("owned test process did not exit; keeping fixture for inspection");
  }));
  const relative = path.relative(path.join(root, "temp"), fixture);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("unsafe fixture cleanup path");
  await rm(fixture, { recursive: true, force: true });
}

function launch(binary, args) {
  const child = spawn(binary, args, { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ID_PROBE_TOKEN: token, TIANGZ_WATCHER_CONTROL: "stdin", RUST_LOG: "info" } });
  children.push(child);
  let output = "", error;
  child.stdout.on("data", bytes => { output += bytes; });
  child.stderr.on("data", bytes => { output += bytes; });
  child.on("error", value => { error = value; });
  return { child, logs: () => output, error: () => error };
}
async function until(condition, runtime, label) {
  const deadline = Date.now() + 20000;
  while (!condition()) {
    if (runtime.error()) throw runtime.error();
    if (runtime.child.exitCode !== null || Date.now() >= deadline) throw new Error(`${label} failed:\n${runtime.logs()}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
async function probe(name, dbPort) {
  const port = await freePort();
  const config = path.join(fixture, "configs", `${name}.json`);
  await writeFile(config, JSON.stringify({ process: { name, identity: { originServerId: 73, workerId: 2, allocation: "dbproxy" },
    persistence: { dbProxy: { endpoint: `127.0.0.1:${dbPort}`, authTokenEnv: "ID_PROBE_TOKEN", clientPoolSize: 1, requestTimeoutMs: 2000 } } },
    scenes: [{ name: "probe", sceneType: "IdProbe", ip: "127.0.0.1", port, protocol: "websocket", audience: "outer" }] }));
  const runtime = launch(path.join(root, `target/debug/TiangZ${suffix}`), [`--runtime-root=${fixture}`, config]);
  await until(() => /GLOBAL_ID_PROBE ([0-9,]+)/.test(runtime.logs()), runtime, name);
  const ids = /GLOBAL_ID_PROBE ([0-9,]+)/.exec(runtime.logs())[1].split(",");
  const exit = new Promise(resolve => runtime.child.once("close", resolve));
  runtime.child.stdin.end("shutdown\n");
  const code = await Promise.race([exit, new Promise(resolve => setTimeout(() => resolve("timeout"), 10000).unref())]);
  assert.equal(code, 0, runtime.logs());
  return ids;
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
