import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { loadGameProject } from "./game_project_config.mjs";

const engine = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(engine, "temp"), { recursive: true });
const temporary = await mkdtemp(path.join(engine, "temp", "starter-project-"));
const project = path.join(temporary, "game with spaces");
function run(args, success = true, cwd = engine) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", windowsHide: true, timeout: 120000 });
  if (success) assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  else assert.notEqual(result.status, 0);
  return result;
}
function action(name, success = true) { return run(["tools/tiangz.mjs", name], success, project); }
try {
  const port = await freePort();
  let healthPort = await freePort();
  while (healthPort === port) healthPort = await freePort();
  run(["tools/create_game_project.mjs", "--path", project, "--id", "org.example.starter", "--port", String(port), "--health-port", String(healthPort)]);
  const config = await loadGameProject(project);
  assert.equal(config.hostProfile, "modules");
  assert.equal(config.engineRoot, engine);
  action("doctor");
  action("setup");
  action("check");
  action("build");
  const manifest = JSON.parse(await readFile(path.join(project, "dist/model.manifest.json"), "utf8"));
  assert.equal(manifest.buildMode, "modules");
  assert.match(action("inspect").stdout, /CounterComponentSystem/);
  if (process.argv.includes("--runtime")) assert.match(action("smoke").stdout, /真实请求验收通过/);
  const behavior = path.join(project, "modules/starter/src/hotfix/counter/CounterComponentSystem.ts");
  const original = await readFile(behavior, "utf8");
  const modelBytes = await readFile(path.join(project, "dist/model.js"));
  await writeFile(behavior, original.replace("extends CounterComponent {", "extends CounterComponent {\n  private cache = 0;"));
  assert.match(action("check", false).stderr, /tiangz.hotfix.instance-state/);
  const diagnostics = run(["tools/typecheck_game_modules.mjs", "--modules-dir", config.modulesDirectory, "--host-profile", "modules", "--json"], false);
  const report = JSON.parse(diagnostics.stdout);
  assert.equal(report.formatVersion, 1);
  assert.equal(report.ok, false);
  assert.equal(report.diagnostics[0].code, "tiangz.hotfix.instance-state");
  assert.equal(report.diagnostics[0].line, 6);
  assert.match(action("build", false).stderr, /tiangz.hotfix.instance-state/);
  assert.deepEqual(await readFile(path.join(project, "dist/model.js")), modelBytes, "rejected behavior cannot overwrite running Model output");
  await writeFile(behavior, original);
  assert.match(run(["tools/create_game_project.mjs", "--path", project, "--id", "org.example.starter"], false).stderr, /不覆盖/);
  await writeFile(path.join(project, ".tiangz-dev.lock"), "existing owner");
  assert.match(action("check", false).stderr, /已有开发命令占用工程/);
  assert.equal(await readFile(path.join(project, ".tiangz-dev.lock"), "utf8"), "existing owner");
  const file = path.join(project, "tiangz.project.json");
  const data = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...data, processConfig: "../escape.json" }));
  await assert.rejects(loadGameProject(project), /相对路径/);
  await writeFile(file, JSON.stringify({ ...data, typo: true }));
  await assert.rejects(loadGameProject(project), /未知开发工程字段/);
  process.stdout.write(`game project starter passed${process.argv.includes("--runtime") ? ": real two-request roundtrip and graceful shutdown" : " (runtime not requested)"}\n`);
} finally { await rm(temporary, { recursive: true, force: true }); }

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
