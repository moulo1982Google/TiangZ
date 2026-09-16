import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, lstat, realpath, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { resolveModuleRuntimeBinary } from "./module_runtime_binary.mjs";
import { loadGameModuleCatalog } from "./game_module_catalog.mjs";

// Isolated fixtures are retained for inspection; no existing installation is changed.
const engineRoot = path.resolve(import.meta.dirname, "..");
const root = await mkdtemp(path.join(os.tmpdir(), "tiangz-module-install-"));
const source = path.join(root, "source");
const modules = path.join(root, "modules");
await mkdir(source);
await mkdir(path.join(source, "model"));
await mkdir(path.join(source, "hotfix"));
await writeFile(path.join(source, "model/index.ts"), "export {};\n");
await writeFile(path.join(source, "hotfix/index.ts"), "export {};\n");
const manifest = { formatVersion: 1, id: "org.test.install", version: "0.6.0-alpha.0",
  engine: { minVersion: "0.6.0-alpha.0", maxVersionExclusive: "0.7.0" },
  entries: { model: "model/index.ts", hotfix: "hotfix/index.ts" },
  dependencies: [{ id: "org.test.missing", minVersion: "0.6.0-alpha.0", maxVersionExclusive: "0.7.0" }] };
const manifestPath = path.join(source, "tiangz.module.json");
await writeFile(manifestPath, JSON.stringify(manifest));
function install(name = "installed") {
  return spawnSync(process.execPath, [path.join(engineRoot, "tools/link_game_module.mjs"),
    "--source", source, "--modules-dir", modules, "--name", name], { encoding: "utf8", windowsHide: true });
}
const missing = install();
assert.notEqual(missing.status, 0);
assert.match(missing.stderr, /missing|dependency/iu);
await assert.rejects(lstat(path.join(modules, "installed")), { code: "ENOENT" });
assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).id, manifest.id);
manifest.dependencies = [];
await writeFile(manifestPath, JSON.stringify(manifest));
for (let index = 0; index < 2; index++) {
  const result = install(); assert.equal(result.status, 0, result.stderr);
}
assert.equal(await realpath(path.join(modules, "installed")), await realpath(source));
const nested = path.join(root, "packages/game/modules");
await mkdir(nested, { recursive: true });
await symlink(source, path.join(nested, "installed"), process.platform === "win32" ? "junction" : "dir");
const firstCatalog = await loadGameModuleCatalog({ projectRoot: engineRoot, modulesDirectory: modules });
const secondCatalog = await loadGameModuleCatalog({ projectRoot: engineRoot, modulesDirectory: nested });
assert.equal(firstCatalog.graphHash, secondCatalog.graphHash);
assert.equal(firstCatalog.modules[0].root, await realpath(source));
assert.equal(firstCatalog.modules[0].entries.model, secondCatalog.modules[0].entries.model);
assert.equal(secondCatalog.moduleForFile(path.join(nested, "installed/model/index.ts")).id, manifest.id);
await writeFile(path.join(source, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["model/**/*.ts", "hotfix/**/*.ts"] }));
for (const [directory, check] of [[modules, false], [nested, true]]) {
  const prepared = spawnSync(process.execPath, [path.join(engineRoot, "tools/prepare_game_modules.mjs"), "--modules-dir", directory, ...(check ? ["--check"] : [])],
    { encoding: "utf8", windowsHide: true });
  assert.equal(prepared.status, 0, prepared.stderr);
}
await mkdir(path.join(modules, "occupied"));
await writeFile(path.join(modules, "occupied", "keep.txt"), "keep");
assert.notEqual(install("occupied").status, 0);
assert.equal(await readFile(path.join(modules, "occupied", "keep.txt"), "utf8"), "keep");
await assert.rejects(resolveModuleRuntimeBinary({ engineRoot, modulesDirectory: modules, profile: "invalid" }), /profile/u);
console.log(`[module-install] rollback, source preservation, idempotence, nested-link identity/editor paths, collision and profile guards passed: ${root}`);
