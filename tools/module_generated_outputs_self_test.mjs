import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { publishModuleOutputs } from "./module_generated_outputs.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "tiangz-output-transaction-"));
try {
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  await mkdir(first);
  await writeFile(path.join(first, "old.ts"), "old");
  await writeFile(second, "blocked target");
  const groups = [first, second].map((directory) => ({ directory, files: new Map([["new.ts", "new"]]) }));
  await assert.rejects(publishModuleOutputs(root, groups, false), /regular directory/);
  assert.equal(await readFile(path.join(first, "old.ts"), "utf8"), "old");
  assert.equal(await readFile(second, "utf8"), "blocked target");
  assert.deepEqual((await readdir(root)).sort(), ["first", "second"]);
  await rm(second);
  await publishModuleOutputs(root, groups, false);
  assert.deepEqual(await readdir(first), ["new.ts"]);
  await publishModuleOutputs(root, groups, true);
  await writeFile(path.join(second, "stale.ts"), "stale");
  await assert.rejects(publishModuleOutputs(root, groups, true), /stale/);
  await publishModuleOutputs(root, groups, false);
  assert.deepEqual(await readdir(second), ["new.ts"]);
} finally {
  await rm(root, { recursive: true, force: true });
}
process.stdout.write("module generated output rollback and stale pruning passed\n");
