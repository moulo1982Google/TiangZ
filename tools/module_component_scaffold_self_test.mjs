import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { planModuleComponent, applyModuleComponent } from "./module_component_scaffold.mjs";

const engine = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(engine, "temp"), { recursive: true });
const temporary = await mkdtemp(path.join(engine, "temp", "component-scaffold-"));
const project = path.join(temporary, "game with spaces");
function run(args, success = true, cwd = engine) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", windowsHide: true, timeout: 120000 });
  if (success) assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  else assert.notEqual(result.status, 0, result.stdout);
  return result;
}
try {
  run(["tools/create_game_project.mjs", "--path", project, "--id", "org.example.scaffold"]);
  const args = ["tools/create_module_component.mjs", "--project", project, "--module", "org.example.scaffold", "--name", "Inventory", "--feature", "inventory"];
  const before = await snapshot(project);
  const preview = JSON.parse(run([...args, "--dry-run", "--json"]).stdout);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.changes.length, 4);
  assert.deepEqual(await snapshot(project), before, "dry run must not create locks, directories or source files");
  assert.match(run([...args, "--expect-plan", "0".repeat(64)], false).stderr, /过期计划/);
  assert.deepEqual(await snapshot(project), before);
  run([...args, "--expect-plan", preview.planHash]);
  run(["tools/tiangz.mjs", "setup"], true, project);
  run(["tools/tiangz.mjs", "check"], true, project);
  run(["tools/tiangz.mjs", "build"], true, project);
  const navigation = JSON.parse(run(["tools/tiangz.mjs", "inspect", "--json"], true, project).stdout);
  const binding = navigation.modules[0].bindings.find(item => item.name === "InventoryComponentSystem");
  assert.equal(binding.targetResolution, "local");
  assert.equal(binding.reachable, true);
  const installed = await snapshot(project);
  assert.match(run(args, false).stderr, /已存在/);
  assert.deepEqual(await snapshot(project), installed, "duplicate creation must preserve all source files");
  await writeFile(path.join(project, ".tiangz-dev.lock"), "existing owner");
  assert.match(run(args, false).stderr, /占用工程/);
  assert.equal(await readFile(path.join(project, ".tiangz-dev.lock"), "utf8"), "existing owner");

  const root = path.join(temporary, "unit");
  await mkdir(path.join(root, "src/model"), { recursive: true });
  await mkdir(path.join(root, "src/hotfix"), { recursive: true });
  const model = path.join(root, "src/model/index.ts");
  const hotfix = path.join(root, "src/hotfix/index.ts");
  const module = { id: "org.example.unit", root, entries: { model, hotfix } };
  await writeFile(hotfix, "export {};\n");
  const basic = 'import { defineGameModule as define } from "#tiangz/core";\nconst ModuleIdentity = { id: "org.example.unit", version: "0.1.0" };\ndefine({ ...ModuleIdentity, modelExports: { ModuleIdentity } });\n';
  for (const text of [basic, basic.replace('modelExports: { ModuleIdentity }', 'modelExports: { ModuleIdentity, /* keep comment */ }, requiredSystems: [ /* keep comment */ ]')]) {
    await writeFile(model, text);
    const plan = await planModuleComponent(module, { name: "Quest", feature: "quest" });
    assert.match(plan.changes[2].after, /requiredSystems/);
    if (text.includes("keep comment")) assert.match(plan.changes[2].after, /keep comment/);
  }
  for (const text of [basic.replace('modelExports: { ModuleIdentity }', 'modelExports: { ...ModuleIdentity }'), basic.replace('modelExports: { ModuleIdentity }', 'modelExports: { ModuleIdentity }, ...ModuleIdentity'), basic.replace('define({', 'const definition = define({'), basic.replace('modelExports:', '["modelExports"]:')]) {
    await writeFile(model, text);
    await assert.rejects(planModuleComponent(module, { name: "Quest", feature: "quest" }));
  }
  await writeFile(model, basic);
  await assert.rejects(planModuleComponent(module, { name: "../../Escape", feature: "quest" }), /PascalCase/);
  await assert.rejects(planModuleComponent(module, { name: "Quest", feature: ".." }), /功能目录/);
  await assert.rejects(planModuleComponent({ ...module, protocol: { serverOutput: path.join(root, "src/model/quest") } }, { name: "Quest", feature: "quest" }), /生成目录/);
  const plan = await planModuleComponent(module, { name: "Quest", feature: "quest" });
  await writeFile(model, `${basic}// concurrent edit\n`);
  await assert.rejects(applyModuleComponent(plan), /预览后文件已变化/);
  await assert.rejects(access(path.join(root, "src/model/quest/QuestComponent.ts")), { code: "ENOENT" });
  assert.match(await readFile(model, "utf8"), /concurrent edit/);
  console.log("module component scaffold passed: read-only preview, checked build, source-linked navigation, no overwrite, lock, literal entry validation and concurrent edit protection");
} finally { await rm(temporary, { recursive: true, force: true }); }

async function snapshot(root, prefix = "") {
  const files = [];
  for (const item of (await readdir(path.join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(prefix, item.name);
    if (item.isDirectory()) files.push(...await snapshot(root, relative));
    else files.push([relative, (await readFile(path.join(root, relative))).toString("base64")]);
  }
  return files;
}
