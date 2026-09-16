import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { inspectGameModules } from "./module_inspector.mjs";

const root = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(root, "temp"), { recursive: true });
const fixture = await mkdtemp(path.join(root, "temp", "module-inspector-"));
try {
  const modules = path.join(fixture, "modules");
  const module = path.join(modules, "probe");
  const created = spawnSync(process.execPath, ["tools/create_game_module.mjs", "--id", "org.example.probe", "--path", module, "--host-profile", "modules"], { cwd: root, encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  await writeFile(path.join(module, "src/model/Counter.ts"), `import { component as state } from "#tiangz/core";
@state() export class Counter {}
`);
  await writeFile(path.join(module, "src/hotfix/CounterSystem.ts"), `import * as core from "#tiangz/model";
import { Counter } from "#tiangz/module";
@core.systemFor(Counter) export class CounterSystem {}
`);
  await writeFile(path.join(module, "src/hotfix/Unused.ts"), `import { rpcHandler } from "#tiangz/model";
@rpcHandler(Counter, Protocol.Increment) export class Unused {}
`);
  await writeFile(path.join(module, "src/model/index.ts"), `export { Counter } from "./Counter.js";`);
  await writeFile(path.join(module, "src/hotfix/index.ts"), `import "./CounterSystem"; import type { Unused } from "./Unused";`);
  const options = { projectRoot: root, modulesDirectory: modules };
  const report = await inspectGameModules(options);
  assert.equal(report.formatVersion, 1);
  const entry = report.modules[0];
  assert.equal(entry.id, "org.example.probe");
  assert.equal(entry.declarations[0].name, "Counter");
  assert.equal(entry.declarations[0].reachable, true);
  assert.equal(entry.declarations[0].location.line, 2);
  assert.equal(entry.bindings.find(item => item.name === "CounterSystem").reachable, true);
  assert.equal(entry.bindings.find(item => item.name === "CounterSystem").targetResolution, "local");
  assert.equal(entry.bindings.find(item => item.name === "CounterSystem").targetLocation.file, "src/model/Counter.ts");
  assert.equal(entry.bindings.find(item => item.name === "Unused").reachable, false);
  assert.equal(entry.bindings.find(item => item.name === "Unused").descriptor, "Protocol.Increment");
  assert.equal(entry.diagnostics.length, 1);
  assert.equal(entry.diagnostics[0].code, "module.navigation.unreachable");
  assert.deepEqual(await inspectGameModules(options), report, "output is deterministic");
  assert.equal(await readFile(path.join(module, "src/hotfix/index.ts"), "utf8"), `import "./CounterSystem"; import type { Unused } from "./Unused";`);
  const json = spawnSync(process.execPath, ["tools/inspect_game_modules.mjs", "--json", "--modules-dir", modules], { cwd: root, encoding: "utf8" });
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), report);
  const bad = spawnSync(process.execPath, ["tools/inspect_game_modules.mjs", "--json", "--modules-dir"], { cwd: root, encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).error.code, "module.inspect.failed");
  await writeFile(path.join(module, "src/hotfix/index.ts"), `export { type Unused } from "./Unused"; import "./CounterSystem";`);
  assert.equal((await inspectGameModules(options)).modules[0].bindings.find(item => item.name === "Unused").reachable, false);
  await writeFile(path.join(module, "src/hotfix/index.ts"), `export { Unused } from "./Unused"; import "./CounterSystem";`);
  assert.equal((await inspectGameModules(options)).modules[0].diagnostics.length, 0);
  await writeFile(path.join(module, "src/hotfix/CounterSystem.ts"), `import { systemFor as bind } from "#tiangz/model";
import { Counter as LocalCounter } from "#tiangz/module";
@bind(LocalCounter) export class CounterSystem {}
`);
  assert.equal((await inspectGameModules(options)).modules[0].bindings.find(item => item.name === "CounterSystem").targetLocation.file, "src/model/Counter.ts");
  await writeFile(path.join(module, "src/hotfix/CounterSystem.ts"), `import { systemFor as bind } from "#tiangz/model";
import { Counter } from "#tiangz/modules/org.example.other";
@bind(Counter) export class CounterSystem {}
`);
  const unrelated = (await inspectGameModules(options)).modules[0].bindings.find(item => item.name === "CounterSystem");
  assert.equal(unrelated.targetResolution, "unresolved", "do not guess a same-named local target for another module");
  assert.equal(unrelated.targetLocation, undefined);
  await writeFile(path.join(module, "src/hotfix/CounterSystem.ts"), `import { systemFor as bind } from "#tiangz/model";
import * as mine from "#tiangz/module";
@bind(mine.Counter) export class CounterSystem {}
`);
  assert.equal((await inspectGameModules(options)).modules[0].bindings.find(item => item.name === "CounterSystem").targetLocation.file, "src/model/Counter.ts");
  process.stdout.write("module inspector self-test passed\n");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
