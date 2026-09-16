import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { resolveHostProfile } from "./host_profile.mjs";
import { immutableCandidateFromOutput } from "./build_result.mjs";

assert.equal(resolveHostProfile([]), "modules");
assert.equal(resolveHostProfile(["--host-profile=modules"]), "modules");
assert.throws(() => resolveHostProfile(["--host-profile"]));
assert.throws(() => resolveHostProfile(["--host-profile", "unknown"]));

const root = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(root, "temp"), { recursive: true });
const fixture = await mkdtemp(path.join(root, "temp/module-host-"));
const modules = path.join(fixture, "modules");
const moduleRoot = path.join(modules, "probe");
const output = path.join(fixture, "dist");
const run = (args) => execFileSync(process.execPath, args, { cwd: root, encoding: "utf8", windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TIANGZ_MODULES_DIR: modules }, timeout: 60000 });
const buildArgs = ["tools/build_runtime_bundles.mjs", "--host-profile", "modules", "--modules-dir", modules, "--out-dir", output];
try {
  run(["tools/create_game_module.mjs", "--id", "org.example.probe", "--path", moduleRoot, "--host-profile", "modules"]);
  await writeFile(path.join(moduleRoot, "src/model/index.ts"), `import { EntryScene, entryScene, defineGameModule } from "#tiangz/core";
@entryScene()
export class ModuleProbeScene extends EntryScene {}
defineGameModule({ id: "org.example.probe", version: "0.1.0", modelExports: { ModuleProbeScene } });
`);
  await writeFile(path.join(moduleRoot, "src/hotfix/index.ts"), "export {};\n");
  run(["tools/prepare_game_modules.mjs", "--modules-dir", modules, "--host-profile", "modules", "--check"]);
  run(buildArgs);
  const configOutput = run(["tools/build_game_config_data.mjs", "--out-dir", output, "--modules-dir", modules, "--initial"]);
  assert.equal(path.dirname(immutableCandidateFromOutput(configOutput, "game-config", output)), path.join(output, "game-config-candidates"));
  const model = await readFile(path.join(output, "model.js"), "utf8");
  const hotfix = await readFile(path.join(output, "hotfix.js"), "utf8");
  assert.match(model, /ModuleProbeScene/);
  assert.doesNotMatch(model + hotfix, /app\/(?:model|hotfix)\/mmorpg\//);
  assert.doesNotMatch(model + hotfix, /class (?:MonsterUnit|NpcUnit|PlayerUnit)|NativeData\.ConfigureProcess/);
  assert.deepEqual(JSON.parse(await readFile(path.join(output, "game-config/server.json"), "utf8")), {});
  const manifest = JSON.parse(await readFile(path.join(output, "model.manifest.json"), "utf8"));
  assert.equal(manifest.buildMode, "modules");
  const hotfixOutput = run([...buildArgs, "--hotfix-only"]);
  assert.equal(path.dirname(immutableCandidateFromOutput(hotfixOutput, "hotfix", output)), path.join(output, "hotfix-candidates"));
  assert.throws(() => run(["tools/build_runtime_bundles.mjs", "--host-profile", "demo", "--out-dir", output, "--modules-dir", modules, "--hotfix-only"]), /demo host was extracted/);
  await writeFile(path.join(moduleRoot, "src/hotfix/index.ts"), 'import { NpcUnit } from "#tiangz/model";\nvoid NpcUnit;\n');
  assert.throws(() => run(buildArgs), /NpcUnit|typecheck failed/);
  await writeFile(path.join(moduleRoot, "src/hotfix/index.ts"), "export {};\n");
  if (process.argv.includes("--runtime")) {
    await verifyRuntime("ModuleProbe", true);
    await verifyRuntime("MapHost", false);
    await writeFile(path.join(output, "game-config/server.json"), '{"unexpected":true}\n');
    await verifyRuntime("ModuleProbe", false, /hash mismatch/);
  }
  console.log(`module-only host passed: no MMORPG bundle/config, matching Hotfix accepted, cross-profile/import rejected${process.argv.includes("--runtime") ? ", real startup/shutdown and built-in Scene rejection" : " (runtime not requested)"}`);
} finally {
  await rm(fixture, { recursive: true, force: true });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function verifyRuntime(sceneType, success, failurePattern = /unknown scene type: MapHost/) {
  const healthPort = await freePort();
  let scenePort = await freePort();
  while (scenePort === healthPort) scenePort = await freePort();
  await mkdir(path.join(fixture, "configs"), { recursive: true });
  const config = path.join(fixture, "configs/probe.json");
  await writeFile(config, JSON.stringify({ process: { name: "module-probe", identity: { originServerId: 91, workerId: 0 },
    observability: { health: { ip: "127.0.0.1", port: healthPort } } },
    scenes: [{ name: "probe", sceneType, ip: "127.0.0.1", port: scenePort, protocol: "websocket", audience: "outer" }] }));
  const binary = path.join(root, "target/debug", process.platform === "win32" ? "TiangZ.exe" : "TiangZ");
  const child = spawn(binary, [`--runtime-root=${fixture}`, config], { cwd: root, windowsHide: true,
    env: { ...process.env, TIANGZ_WATCHER_CONTROL: "stdin" }, stdio: ["pipe", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", data => { logs += data; });
  child.stderr.on("data", data => { logs += data; });
  let launchError;
  child.on("error", error => { launchError = error; });
  const exited = new Promise(resolve => child.once("close", resolve));
  let forced = false;
  const deadline = setTimeout(() => { forced = true; child.kill(); }, 20000);
  try {
    if (success) {
      let ready = false;
      for (let i = 0; i < 150; i++) {
        if (launchError) throw launchError;
        if (child.exitCode !== null) break;
        try { ready = (await fetch(`http://127.0.0.1:${healthPort}/ready`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(ready, logs);
      child.stdin.end("shutdown\n");
      assert.equal(await exited, 0, logs);
    } else {
      assert.notEqual(await exited, 0, logs);
      assert.match(logs, failurePattern);
    }
    assert.equal(forced, false, logs);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
  }
}
