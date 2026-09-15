import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { build } from "esbuild";
import { runInherited, sleep } from "./lib/process_test_harness.mjs";

const root = path.resolve(import.meta.dirname, "..");
const work = path.join(root, "temp", "public-map-runtime");
const modules = path.join(root, "tools", "fixtures", "public-maps", "modules");
const runtimes = [];
const used = new Set();
await mkdir(path.join(work, "configs"), { recursive: true });

async function port() {
  for (;;) {
    const value = await new Promise((resolve, reject) => {
      const server = net.createServer(); server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { const chosen = server.address().port; server.close(() => resolve(chosen)); });
    });
    if (!used.has(value)) { used.add(value); return value; }
  }
}

try {
  await runInherited(process.execPath, ["tools/build_runtime_bundles.mjs", "--modules-dir", modules, "--out-dir", path.join(work, "dist")], root);
  await runInherited(process.execPath, ["tools/build_game_config_data.mjs", "--out-dir", path.join(work, "dist"), "--initial"], root,
    { env: { TIANGZ_MODULES_DIR: modules } });
  await build({ entryPoints: [path.join(root, "tools", "public_map_probe.ts")], bundle: true,
    platform: "node", format: "esm", target: "node24", outfile: path.join(work, "probe.mjs") });
  const scenes = [
    { name: "public_login_mgr", sceneType: "LoginMgr", port: await port() },
    { name: "public_manager", sceneType: "MapManager", port: await port() },
    { name: "public_login", sceneType: "Login", port: await port() },
    { name: "public_gate", sceneType: "Gate", port: await port() },
    { name: "public_host_a", sceneType: "MapHost", port: await port(), staticMapIds: [1], acceptDynamicMaps: true },
    { name: "public_host_b", sceneType: "MapHost", port: await port(), staticMapIds: [], acceptDynamicMaps: true },
    { name: "public_location", sceneType: "Location", port: await port() },
  ].map(s => ({ ...s, ip: "127.0.0.1" }));
  const groups = [scenes.filter(s => !s.name.startsWith("public_host")), [scenes[4]], [scenes[5]]];
  for (let i = 0; i < groups.length; i++) {
    const health = await port();
    const file = path.join(work, "configs", `process-${i}.json`);
    await writeFile(file, JSON.stringify({ process: { name: `public_map_test_${i}`,
      identity: { originServerId: 42, workerId: i }, logging: { level: "warn", console: true },
      game: { fixedUpdateMs: 50 }, observability: { health: { ip: "127.0.0.1", port: health } } },
      scenes: groups[i], knownScenes: scenes.filter(s => !groups[i].includes(s)).map(({ staticMapIds, ...s }) => s) }));
    const child = spawn(path.join(root, "target", "debug", process.platform === "win32" ? "TiangZ.exe" : "TiangZ"), [file],
      { cwd: work, env: { ...process.env, TIANGZ_WATCHER_CONTROL: "stdin" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const runtime = { child, output: "", health }; runtimes.push(runtime);
    child.stdout.on("data", data => runtime.output += data); child.stderr.on("data", data => runtime.output += data);
    child.once("error", error => runtime.output += error.stack);
  }
  const deadline = Date.now() + 30_000;
  for (const runtime of runtimes) {
    for (;;) {
      if (runtime.child.exitCode !== null) throw new Error(runtime.output);
      try { if ((await fetch(`http://127.0.0.1:${runtime.health}/ready`)).ok) break; } catch {}
      if (Date.now() > deadline) throw new Error(`runtime startup timeout: ${runtime.output}`);
      await sleep(100);
    }
  }
  await sleep(16_000);
  await runInherited(process.execPath, [path.join(work, "probe.mjs"), String(scenes[0].port)], root);
} finally {
  for (const [i, runtime] of runtimes.entries()) {
    await writeFile(path.join(work, `process-${i}.log`), runtime.output);
    if (runtime.child.exitCode === null) {
      runtime.child.stdin.end("shutdown\n");
      await Promise.race([new Promise(resolve => runtime.child.once("exit", resolve)), sleep(5000)]);
      if (runtime.child.exitCode === null) runtime.child.kill();
    }
  }
}
