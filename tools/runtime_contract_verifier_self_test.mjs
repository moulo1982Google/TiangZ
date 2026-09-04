import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

console.log("runtime contract verifier self-test passed");
