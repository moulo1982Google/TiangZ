import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(root, "temp"), { recursive: true });
const temporary = await mkdtemp(path.join(root, "temp", "module-typecheck-host-"));
try {
  const moduleRoot = path.join(temporary, "modules", "probe");
  const staleRoot = path.join(temporary, "old-host", "app/generated/bootstrap/systems");
  await mkdir(path.join(moduleRoot, "src/model"), { recursive: true });
  await mkdir(path.join(moduleRoot, "src/hotfix"), { recursive: true });
  await mkdir(staleRoot, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(root, "tools/fixtures/game-modules/greeting/tiangz.module.json"), "utf8"));
  await writeFile(path.join(moduleRoot, "tiangz.module.json"), JSON.stringify(manifest));
  await writeFile(path.join(staleRoot, "stale.d.ts"), "this is deliberately invalid old-host syntax !");
  await writeFile(path.join(moduleRoot, "src/model/index.ts"), "export {};\n");
  await writeFile(path.join(moduleRoot, "src/local.d.ts"), "type LocalMarker = 'preserved';\n");
  const config = JSON.parse(await readFile(path.join(root, "tools/fixtures/game-modules/greeting/tsconfig.json"), "utf8"));
  config.include = ["src/**/*.ts", path.join(staleRoot, "*.d.ts").replaceAll("\\", "/")];
  await writeFile(path.join(moduleRoot, "tsconfig.json"), JSON.stringify(config));
  const source = 'import type { Entity } from "#tiangz/model";\n' +
    'export function snapshot(item: Entity): boolean { const marker: LocalMarker = "preserved"; return item.IsDisposed; }\n';
  const entry = path.join(moduleRoot, "src/hotfix/index.ts");
  await writeFile(entry, source);
  const check = (...args) => spawnSync(process.execPath, [path.join(root, "tools/typecheck_game_modules.mjs"),
    "--modules-dir", path.join(temporary, "modules"), ...args], { cwd: root, encoding: "utf8", windowsHide: true });
  const positive = check();
  assert.equal(positive.status, 0, positive.stdout + positive.stderr);
  await writeFile(entry, source.replace('= "preserved"', '= "wrong"'));
  const localError = check();
  assert.notEqual(localError.status, 0);
  assert.match(localError.stderr, /not assignable/);
  await writeFile(entry, source.replace('return item.IsDisposed;', 'const invalid: string = item.IsDisposed; return false;'));
  const methodError = check();
  assert.notEqual(methodError.status, 0);
  assert.match(methodError.stderr, /not assignable/);
  await writeFile(entry, 'import { TimerSystem } from "#tiangz/model"; export async function wrong() { await TimerSystem.Instance.WaitAsync(1); }');
  const timerError = check();
  assert.notEqual(timerError.status, 0);
  assert.match(timerError.stderr, /tiangz.timer.time-wait-forbidden/);
  await writeFile(entry, 'export async function good(result: Promise<number>) { return await result; }');
  const ordinaryAwait = check();
  assert.equal(ordinaryAwait.status, 0, ordinaryAwait.stderr);
  // 字符串 Timer 派发必须使用当前宿主与当前模块生成声明，不能只通过普通 tsc。
  // String dispatch must use current host identity and current module augmentations, beyond ordinary tsc.
  await writeFile(path.join(moduleRoot, "src/model/index.ts"), `import * as Core from "#tiangz/core";
interface TimerCancelledContext { notHost: true }
export class Probe extends Core.Component {
  Cancel(value: number, context: TimerCancelledContext): void {}
}
`);
  const generated = path.join(moduleRoot, "src/model/generated/bootstrap/systems");
  await mkdir(generated, { recursive: true });
  await writeFile(path.join(generated, "Probe.d.ts"), 'import "../../../index"; declare module "../../../index" { interface Probe { GeneratedTick(value: number): void; } }');
  const contractSource = `import { Probe } from "#tiangz/module";
class ProbeSystem extends Probe { protected override Awake() { return Promise.resolve(); } }
class Unrelated { async Awake() {} }
export function schedule(receiver: Probe, dynamic: string): void {
  receiver.NewOnceTimer(1, "GeneratedTick", 1);
  receiver.NewOnceTimer(1, "Missing", 1);
  receiver.NewOnceTimer(1, "GeneratedTick", "bad");
  receiver.NewOnceTimer(1, "GeneratedTick", 1, { onCancelled: "Cancel" });
  receiver.NewOnceTimer(1, dynamic, 1);
}
`;
  await writeFile(entry, contractSource);
  const contractFailure = check("--json");
  assert.equal(contractFailure.status, 1, contractFailure.stdout + contractFailure.stderr);
  const contractDiagnostics = JSON.parse(contractFailure.stdout).diagnostics;
  assert.deepEqual(contractDiagnostics.map(item => item.code), [
    "tiangz.lifecycle.async-method", "tiangz.timer.target-missing", "tiangz.timer.argument-mismatch",
    "tiangz.timer.argument-mismatch", "tiangz.timer.unverifiable",
  ]);
  assert.equal(contractDiagnostics.at(-1).severity, "warning");
  assert.ok(contractDiagnostics.every(item => path.resolve(item.file) === path.resolve(entry)));
  await writeFile(entry, contractSource.split("\n").filter(line => !line.includes("class ProbeSystem")
    && !line.includes('"Missing"') && !line.includes('"bad"') && !line.includes('onCancelled')).join("\n"));
  const contractWarning = check("--json");
  assert.equal(contractWarning.status, 0, contractWarning.stdout + contractWarning.stderr);
  assert.deepEqual(JSON.parse(contractWarning.stdout).diagnostics.map(item => [item.code, item.severity]), [["tiangz.timer.unverifiable", "warning"]]);
  console.log("module typecheck host selection passed: current methods, stale host excluded, local declarations preserved");
} finally {
  assert.equal(path.dirname(temporary), path.join(root, "temp"));
  await rm(temporary, { recursive: true, force: true });
}
