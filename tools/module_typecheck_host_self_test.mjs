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
  const source = 'import type { ItemComponent, ItemSnapshot } from "#tiangz/model";\n' +
    'export function snapshot(item: ItemComponent): readonly ItemSnapshot[] { const marker: LocalMarker = "preserved"; return item.Snapshot(); }\n';
  const entry = path.join(moduleRoot, "src/hotfix/index.ts");
  await writeFile(entry, source);
  const check = () => spawnSync(process.execPath, [path.join(root, "tools/typecheck_game_modules.mjs"),
    "--modules-dir", path.join(temporary, "modules")], { cwd: root, encoding: "utf8", windowsHide: true });
  const positive = check();
  assert.equal(positive.status, 0, positive.stdout + positive.stderr);
  await writeFile(entry, source.replace('= "preserved"', '= "wrong"'));
  const localError = check();
  assert.notEqual(localError.status, 0);
  assert.match(localError.stderr, /not assignable/);
  await writeFile(entry, source.replace('return item.Snapshot();', 'const invalid: string = item.Snapshot(); return [];'));
  const methodError = check();
  assert.notEqual(methodError.status, 0);
  assert.match(methodError.stderr, /not assignable/);
  console.log("module typecheck host selection passed: current methods, stale host excluded, local declarations preserved");
} finally {
  assert.equal(path.dirname(temporary), path.join(root, "temp"));
  await rm(temporary, { recursive: true, force: true });
}
