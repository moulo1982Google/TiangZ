import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadGameModuleCatalog } from "./game_module_catalog.mjs";

// 使用Native运行验收构建出的中立候选，不接触已发布制品。
// Uses the neutral Native acceptance candidate without modifying published artifacts.
const root = path.resolve(import.meta.dirname, "..");
const modules = path.join(root, "temp/module-native-fixture/modules");
const bundles = path.join(root, "temp/module-native-fixture/dist");
const catalog = await loadGameModuleCatalog({ projectRoot: root, modulesDirectory: modules });
const native = path.join(root, "temp/module-native-build", catalog.graphHash, "debug.manifest.json");
const environment = { ...process.env, TIANGZ_MODULES_DIR: modules };
const packaged = run("tools/build_game_config_data.mjs", ["--initial", "--out-dir", bundles]);
assert.equal(packaged.status, 0, packaged.stderr);
for (const [file, mutate, message] of [
  [path.join(bundles, "hotfix.manifest.json"), (value) => { value.gameConfigHash = "0".repeat(64); }, /not a matching atomic candidate/],
  [path.join(bundles, "hotfix.manifest.json"), (value) => { value.moduleGraphHash = "0".repeat(64); }, /bundles do not match/],
  [path.join(bundles, "game-config/game-config.manifest.json"), (value) => { value.moduleConfigsJson = "[{}]"; }, /module config is incomplete/],
  [native, (value) => { value.binaryHash = "0".repeat(64); }, /Native release binary is stale/],
  [native, (value) => { value.cargoLockHash = "0".repeat(64); }, /Native release binary is stale/],
]) {
  const original = await readFile(file, "utf8");
  try {
    const value = JSON.parse(original);
    mutate(value);
    await writeFile(file, JSON.stringify(value));
    const result = run("tools/release/package_release.mjs", ["--debug", "--skip-build", "--skip-smoke", "--bundle-dir", bundles]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, message);
  } finally {
    await writeFile(file, original);
  }
}
console.log("module release rejects mixed bundles, incomplete config, stale binaries and changed locks");

function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, env: environment, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  return result;
}
