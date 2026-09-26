import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

async function fixture() {
  await mkdir(path.join(root, "temp"), { recursive: true });
  const project = await mkdtemp(path.join(root, "temp/module-live-"));
  const module = path.join(project, "modules/probe");
  const created = spawnSync(process.execPath, ["tools/create_game_module.mjs", "--id", "org.example.live", "--path", module, "--host-profile", "modules"], { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(created.status, 0, created.stderr);
  await mkdir(path.join(project, "configs"));
  await writeFile(path.join(project, "configs/process.json"), "{}");
  await writeFile(path.join(project, "configs/StartMachine.json"), "{}");
  await writeFile(path.join(project, "tiangz.project.json"), JSON.stringify({ formatVersion: 1, hostProfile: "modules", engineRoot: root, modulesDirectory: "modules", processConfig: "configs/process.json", machineConfig: "configs/StartMachine.json" }));
  const file = path.join(module, "src/model/index.ts");
  const source = `import { Component } from "#tiangz/core";
export class Probe extends Component {
  protected override async Awake(): Promise<void> {}
  Schedule(name: string): void {
    this.NewOnceTimer(1, "Missing");
    this.NewRepeatedTimer(1000, "Tick");
    this.NewOnceTimer(1, name);
  }
  Tick(now = Date.now()): void { void now; }
}`;
  await writeFile(file, source);
  await writeFile(path.join(module, "src/hotfix/index.ts"), "export {};");
  return { project, module, file, source };
}

function worker(project) {
  const child = spawn(process.execPath, ["tools/module_live_worker.mjs", "--project", project], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", bytes => { stderr += bytes; });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const exited = new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  const deadline = setTimeout(() => child.kill(), 30_000);
  let id = 0;
  async function next() {
    const line = await lines.next();
    assert.equal(line.done, false, `worker ended before response: ${stderr}`);
    return JSON.parse(line.value);
  }
  return {
    ready: next,
    async analyze(overlays = []) {
      child.stdin.write(JSON.stringify({ formatVersion: 1, id: ++id, method: "analyze", overlays }) + "\n");
      const result = await next();
      assert.equal(result.id, id, JSON.stringify(result));
      return result;
    },
    async stop() {
      child.stdin.end();
      const timeout = setTimeout(() => child.kill(), 2000);
      try { assert.equal(await exited, 0, stderr); }
      finally { clearTimeout(timeout); clearTimeout(deadline); }
    },
  };
}

test("real module worker and CLI agree; unsaved fixes and closing restore without disk writes", { timeout: 45_000 }, async () => {
  const input = await fixture();
  const cli = spawnSync(process.execPath, ["tools/typecheck_game_modules.mjs", "--modules-dir", path.join(input.project, "modules"), "--host-profile", "modules", "--json"], { cwd: root, windowsHide: true, encoding: "utf8" });
  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  const expected = JSON.parse(cli.stdout).diagnostics.map(item => ({ ...item, severity: item.severity ?? "error" }));
  assert.deepEqual(expected.map(item => item.code), ["tiangz.lifecycle.async-method", "tiangz.timer.target-missing", "tiangz.timer.unverifiable"]);
  const client = worker(input.project);
  try {
    const ready = await client.ready();
    assert.equal(ready.event, "ready", JSON.stringify(ready));
    assert.match(ready.typescriptVersion, /^6\./);
    const baseline = await client.analyze();
    assert.equal(baseline.status, "checked");
    assert.deepEqual(baseline.diagnostics, expected);
    assert.equal(baseline.cache.programs, 1);
    const fixed = input.source.replace("async Awake(): Promise<void>", "Awake(): void").replace('"Missing"', '"Tick"');
    const corrected = await client.analyze([{ file: input.file, text: fixed }]);
    assert.equal(corrected.status, "checked");
    assert.deepEqual(corrected.diagnostics.map(item => [item.code, item.severity]), [["tiangz.timer.unverifiable", "warning"]]);
    assert.equal(corrected.cache.sourceFiles, baseline.cache.sourceFiles);
    const closed = await client.analyze();
    assert.deepEqual(closed.diagnostics, expected);
    assert.equal(await readFile(input.file, "utf8"), input.source);
    const foreign = await client.analyze([{ file: path.join(root, "app/core/public.ts"), text: "export {};" }]);
    assert.equal(foreign.status, "unavailable");
    assert.match(foreign.diagnostics[0].message, /outside.*module source/);
    assert.deepEqual(foreign.cache, { programs: 0, sourceFiles: 0, sourceBytes: 0 });
    const oversized = await client.analyze([{ file: input.file, text: "x".repeat(2 * 1024 * 1024 + 1) }]);
    assert.equal(oversized.status, "unavailable");
    assert.match(oversized.diagnostics[0].message, /oversized/);
    assert.deepEqual((await client.analyze()).diagnostics, expected);
    await writeFile(path.join(input.module, "tsconfig.json"), "{}");
    const changed = await client.analyze();
    assert.equal(changed.status, "unavailable");
    assert.match(changed.diagnostics[0].message, /declaration changed/);
  } finally { await client.stop(); }
});

test("worker refuses a host different from the saved declaration before accepting requests", async () => {
  const input = await fixture();
  const file = path.join(input.project, "tiangz.project.json");
  const config = JSON.parse(await readFile(file, "utf8"));
  config.engineRoot = input.project;
  await writeFile(file, JSON.stringify(config));
  const result = spawnSync(process.execPath, ["tools/module_live_worker.mjs", "--project", input.project], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 15_000 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.event, "fatal");
  assert.match(response.message, /host differs/);
});
