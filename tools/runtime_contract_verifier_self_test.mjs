import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { findMissingSelfTestWrappers } from "./verify_self_test_wrappers.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptFile), "..");
const result = spawnSync(process.execPath, [
  "tools/verify_runtime_contracts.mjs",
  "--project",
  "tools/fixtures/runtime-contracts/tsconfig.json",
  "--scan-root",
  "tools/fixtures/runtime-contracts",
], {
  cwd: root,
  encoding: "utf8",
});

if (result.status === 0) {
  throw new Error("runtime contract verifier accepted intentionally invalid fixtures");
}

const output = `${result.stdout}\n${result.stderr}`;
for (const expected of [
  "Awake must be synchronous; remove the async modifier",
  "CaptureTransfer must be synchronous",
  "method name must be a string literal",
  "target does not exist on InvalidTimerContracts: Missing",
  "arguments (\"wrong args\") do not match Tick",
  "target does not exist on InvalidTimerContracts: MissingCancellation",
  "onCancelled arguments ({ count: number; }) do not match BadCancellation",
]) {
  if (!output.includes(expected)) {
    throw new Error(`runtime contract verifier did not report expected violation: ${expected}\n${output}`);
  }
}

const fixture = await mkdtemp(path.join(tmpdir(), "tiangz-test-wrappers-"));
try {
  await mkdir(path.join(fixture, "tools"));
  await mkdir(path.join(fixture, "tests", "legacy"), { recursive: true });
  await writeFile(path.join(fixture, "tools", "self_test_entry.ts"), "");
  assert.deepEqual(await findMissingSelfTestWrappers(fixture), []);
  await writeFile(path.join(fixture, "tools", "new_feature_self_test.ts"), "");
  assert.deepEqual(await findMissingSelfTestWrappers(fixture), [
    "tools/new_feature_self_test.ts: missing Vitest wrapper tests/legacy/new_feature_self_test.test.ts",
  ]);
  await writeFile(path.join(fixture, "tests", "legacy", "new_feature_self_test.test.ts"), "");
  assert.deepEqual(await findMissingSelfTestWrappers(fixture), []);
} finally {
  await rm(fixture, { recursive: true, force: true });
}

console.log("runtime contract verifier self-test passed");
