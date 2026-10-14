import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const engine = path.resolve(import.meta.dirname, "../..");

test("actual generated plugin checks reject missing, duplicate and broken-reference rules", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "tiangz-ai-check-"));
  try {
    await cp(path.join(engine, "dist/ai-assistants"), temporary, { recursive: true });
    const file = path.join(temporary, "cindy/main.js");
    const original = await readFile(file, "utf8");
    assert.equal(run().status, 0);
    for (const [source, message] of [
      [original.replace('rule("model.export-shape"', 'rule("ownership.single-owner"'), /actual|strictEqual|AssertionError/],
      [original.replace('rule("model.export-shape"', 'rule("model.missing-fixture"'), /Missing rule model.export-shape/],
      [original.replace('"docs/ai/skill-development-contract.md"', '"docs/ai/missing-fixture.md"'), /Missing rule document/],
    ]) {
      assert.notEqual(source, original);
      await writeFile(file, source);
      const rejected = run();
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, message);
    }
    await writeFile(file, original);
    assert.equal(run().status, 0);
  } finally { await rm(temporary, { recursive: true, force: true }); }

  function run() { return spawnSync(process.execPath, [path.join(engine, "tools/ai-assistants/check.mjs"), "--root", temporary],
    { cwd: engine, encoding: "utf8", timeout: 10_000, windowsHide: true }); }
});
