import assert from "node:assert/strict";
import path from "node:path";
import { immutableCandidateFromOutput } from "./build_result.mjs";

const output = path.resolve("temp", "project with spaces", "dist");
for (const kind of ["hotfix", "game-config"]) {
  const candidate = path.join(output, `${kind}-candidates`, "0123456789abcdef");
  const marker = kind === "hotfix" ? "[build:runtime:result] " : "[build:game-config:result] ";
  const report = (directory, extra = {}) => `${marker}${JSON.stringify({ formatVersion: 1, kind, candidateDirectory: directory, ...extra })}\n`;
  assert.equal(immutableCandidateFromOutput(`other text\n${report(candidate)}`, kind, output), candidate);
  assert.throws(() => immutableCandidateFromOutput(report(candidate, { formatVersion: 2 }), kind, output), /无效/);
  assert.throws(() => immutableCandidateFromOutput(report(path.join(output, "hotfix.js")), kind, output), /不可变/);
  assert.throws(() => immutableCandidateFromOutput(report(path.join(output, "..", "other", `${kind}-candidates`, "0123456789abcdef")), kind, output), /不可变/);
  assert.throws(() => immutableCandidateFromOutput(report("dist/relative"), kind, output), /无效/);
  assert.throws(() => immutableCandidateFromOutput("output=truncated path", kind, output), /JSON/);
}
console.log("structured build result self-test passed");
