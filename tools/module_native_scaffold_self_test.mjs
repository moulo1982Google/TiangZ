import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { resolveModuleRuntimeBinary } from "./module_runtime_binary.mjs";

const engine = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(engine, "temp"), { recursive: true });
// 保留独立夹具供检查；不删除用户目录或操作已有服务。 / Keep isolated fixtures; never touch existing services.
const fixture = await mkdtemp(path.join(engine, "temp", "rust-scaffold-"));
const project = path.join(fixture, "game with spaces");
const id = `org.example.${path.basename(fixture).toLowerCase()}`;
const runtime = process.argv.includes("--runtime");
function run(args, success = true, cwd = engine) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status === 0, success, `${args.join(" ")}\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  return result;
}
function action(name, success = true) { return run(["tools/tiangz.mjs", name], success, project); }
const port = await freePort();
let health = await freePort();
while (health === port) health = await freePort();
run(["tools/create_game_project.mjs", "--path", project, "--id", id, "--with-rust", "--port", String(port), "--health-port", String(health)]);
const moduleRoot = path.join(project, "modules/starter");
const manifest = JSON.parse(await readFile(path.join(moduleRoot, "tiangz.module.json"), "utf8"));
assert.equal(manifest.native.crateName, `tiangz_${id.replaceAll(/[.-]/g, "_")}_native`);
assert.match(await readFile(path.join(moduleRoot, "src/hotfix/counter/CounterComponentSystem.ts"), "utf8"), /NativeExample.Add/);
assert.match(action("doctor", false).stdout, /host-build/);
action("setup");
run(["tools/typecheck_game_modules.mjs", "--modules-dir", path.join(project, "modules"), "--host-profile", "modules"]);
action("build");
assert.match(action("start", false).stderr, /不回退/);
assert.match(action("dev", false).stderr, /Native/);
assert.match(run(["tools/create_game_project.mjs", "--path", project, "--id", "org.example.rust-shell", "--with-rust"], false).stderr, /不覆盖/);
assert.match(run(["tools/create_game_project.mjs", "--path", path.join(fixture, "invalid"), "--id", "org.example.rust-shell", "--with-rust", "--with-rust"], false).stderr, /重复/);
const standalone = path.join(fixture, "standalone/shell");
run(["tools/create_game_module.mjs", "--path", standalone, "--id", "org.example.shell", "--with-rust"]);
run(["tools/prepare_game_modules.mjs", "--modules-dir", path.dirname(standalone)]);
run(["tools/codegen_module_native.mjs", "--modules-dir", path.dirname(standalone)]);
run(["tools/typecheck_game_modules.mjs", "--modules-dir", path.dirname(standalone)]);
assert.match(await readFile(path.join(standalone, "src/model/index.ts"), "utf8"), /modelExports: \{ ModuleIdentity, NativeExample \}/);
if (runtime) {
  process.stdout.write("[rust-scaffold] 正在编译生成工程的 Rust 组合宿主\n");
  action("host-build");
  const binary = await resolveModuleRuntimeBinary({ engineRoot: engine, modulesDirectory: path.join(project, "modules") });
  const composition = path.dirname(path.dirname(path.dirname(binary)));
  const env = { ...process.env };
  if (process.platform === "win32") for (const key of ["CC", "CXX"]) if (/^(gcc|g\+\+)(\.exe)?$/i.test(path.basename(env[key] ?? ""))) delete env[key];
  const unit = spawnSync("cargo", ["test", "--offline", "--locked", "--manifest-path", path.join(composition, "Cargo.toml"),
    "--target-dir", path.join(engine, "temp/module-native-target"), "-p", manifest.native.crateName, "--lib"],
    { cwd: engine, env, encoding: "utf8", windowsHide: true });
  assert.equal(unit.status, 0, `${unit.error ?? ""}\n${unit.stdout}\n${unit.stderr}`);
  assert.match(unit.stdout, /1 passed/);
  action("check");
  action("doctor");
  assert.match(action("smoke").stdout, /真实请求验收通过/);
  const source = path.join(moduleRoot, "rust/src/native_data.rs");
  const original = await readFile(source, "utf8");
  try {
    await writeFile(source, original + "\n// stale binary probe\n");
    await assert.rejects(resolveModuleRuntimeBinary({ engineRoot: engine, modulesDirectory: path.join(project, "modules") }), /stale|mismatched/);
    assert.match(action("start", false).stderr, /不回退/);
  } finally { await writeFile(source, original); }
}
process.stdout.write(`[rust-scaffold] passed${runtime ? " (real Rust RPC and graceful shutdown)" : " (no Cargo build/runtime)"}; fixture=${fixture}\n`);

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
