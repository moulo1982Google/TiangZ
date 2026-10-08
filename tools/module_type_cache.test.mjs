import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import ts from "typescript";
import { ModuleTypeCache } from "./module_type_cache.mjs";

test("module type cache checks unsaved dependencies, reuses unchanged ASTs and restores disk", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tiangz-module-types-"));
  const entry = path.join(directory, "index.ts"), dependency = path.join(directory, "value.ts");
  const original = 'import type { Value } from "./value"; export const value: Value = "disk";';
  await writeFile(entry, original);
  await writeFile(dependency, 'export type Value = "disk";');
  const cache = new ModuleTypeCache();
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, noEmit: true, skipLibCheck: true };
  const compile = () => cache.createProgram("fixture", { rootNames: [entry], options, host: ts.createCompilerHost(options) });
  const errors = program => ts.getPreEmitDiagnostics(program).filter(item => item.category === ts.DiagnosticCategory.Error);
  try {
    const first = compile();
    assert.deepEqual(errors(first), []);
    const originalCount = cache.stats.sourceFiles;
    const ast = first.getSourceFile(entry);
    cache.setOverlays([{ file: dependency, text: 'export type Value = "overlay";' }]);
    const changedDependency = compile();
    assert.equal(changedDependency.getSourceFile(entry), ast, "unchanged syntax must be reused");
    assert.deepEqual(errors(changedDependency).map(item => item.code), [2322]);
    cache.setOverlays([{ file: dependency, text: 'export type Value = "overlay";' }, { file: entry, text: original.replace('= "disk"', '= "overlay"') }]);
    assert.deepEqual(errors(compile()), []);
    cache.setOverlays([]);
    assert.deepEqual(errors(compile()), []);
    assert.equal(await readFile(entry, "utf8"), original);
    assert.equal(await readFile(dependency, "utf8"), 'export type Value = "disk";');
    assert.equal(cache.stats.sourceFiles, originalCount);
    assert.equal(cache.stats.programs, 1);
  } finally { cache.dispose(); }
  assert.deepEqual(cache.stats, { programs: 0, sourceFiles: 0, sourceBytes: 0 });
});

test("oversized type inputs fail before silently exceeding the source budget", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tiangz-module-capacity-"));
  const entry = path.join(directory, "index.ts");
  await writeFile(entry, "export const data = 1;");
  const options = { noLib: true, noEmit: true };
  const cache = new ModuleTypeCache({ maxFiles: 1, maxBytes: 64, maxPrograms: 1 });
  const compile = id => cache.createProgram(id, { rootNames: [entry], options, host: ts.createCompilerHost(options) });
  compile("one");
  assert.throws(() => compile("two"), /capacity exceeded/);
  cache.setOverlays([{ file: entry, text: "//" + "x".repeat(65) }]);
  assert.throws(() => compile("one"), /source cache capacity exceeded/);
  cache.dispose();
  assert.deepEqual(cache.stats, { programs: 0, sourceFiles: 0, sourceBytes: 0 });
});
