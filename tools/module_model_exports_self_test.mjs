import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkModuleModelExports } from "./check_module_model_exports.mjs";
import { moduleNativeGlobalName } from "./module_native.mjs";

test("real Core Model export validation, graph identity and bounded probe", async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "tiangz-model-export-test-"));
  const modulesDirectory = path.join(temporary, "modules");
  const moduleRoot = path.join(modulesDirectory, "example");
  const modelFile = path.join(moduleRoot, "src/model/index.ts");
  const manifestFile = path.join(moduleRoot, "tiangz.module.json");
  const manifest = await fixture(moduleRoot, "org.example.model-check");
  const register = expression => `import { defineGameModule, Component } from "#tiangz/core";\n${expression}\n`;
  const define = value => `defineGameModule({ id: "${manifest.id}", version: "1.0.0", modelExports: { Value: ${value} } });`;
  try {
    const valid = [
      ["primitives and allowed function values", "[null, undefined, 0, 'text', 1n, true, () => 1]"],
      ["frozen arrays and null-prototype plain objects", "Object.freeze([Object.assign(Object.create(null), { a: 1 })])"],
      ["Component constructors may own Map and Set fields", "class Example extends Component { data = new Map(); flags = new Set(); }"],
    ];
    for (const [name, expression] of valid) await t.test(name, async () => {
      await writeFile(modelFile, register(define(expression)));
      const result = await checkModuleModelExports({ modulesDirectory });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.nativeExecutionVerified, false);
    });
    await t.test("cycles and shared objects terminate without rejecting plain values", async () => {
      await writeFile(modelFile, register(`const value = { list: [] }; value.list.push(value); ${define("value")}`));
      assert.equal((await checkModuleModelExports({ modulesDirectory })).ok, true);
    });
    for (const [name, value, suffix] of [
      ["frozen Set", "Object.freeze(new Set([1]))", ""],
      ["Map", "new Map()", ""],
      ["Date", "new Date(0)", ""],
      ["class instance", "new (class Example {})()", ""],
      ["nested invalid array element", "{ nested: [new Set()] }", '.nested["0"]'],
    ]) await t.test(name, async () => {
      await writeFile(modelFile, register(define(value)));
      const result = await checkModuleModelExports({ modulesDirectory });
      assert.equal(result.status, "failed");
      assert.equal(result.diagnostics[0].code, "tiangz.model.invalid-export");
      assert.equal(result.diagnostics[0].moduleId, manifest.id);
      assert.equal(result.diagnostics[0].exportPath, `modelExports.Value${suffix}`);
    });
    await t.test("root undefined keeps its original rejection", async () => {
      await writeFile(modelFile, register(define("undefined")));
      const result = await checkModuleModelExports({ modulesDirectory });
      assert.match(result.diagnostics[0].message, /undefined game module export/);
    });
    await t.test("non-Error throws retain their actual failure", async () => {
      await writeFile(modelFile, "throw null;\n");
      const result = await checkModuleModelExports({ modulesDirectory });
      assert.equal(result.status, "failed");
      assert.equal(result.diagnostics[0].message, "null");
    });
    await t.test("invalid root export names carry their own path", async () => {
      await writeFile(modelFile, register(`defineGameModule({ id: "${manifest.id}", version: "1.0.0", modelExports: { 'bad-name': 1 } });`));
      const result = await checkModuleModelExports({ modulesDirectory });
      assert.equal(result.diagnostics[0].code, "tiangz.model.invalid-export");
      assert.equal(result.diagnostics[0].exportPath, 'modelExports["bad-name"]');
    });
    await t.test("accessors are rejected without running getters", async () => {
      await writeFile(modelFile, register(`const value = {}; Object.defineProperty(value, 'unsafe', { get() { throw Error('GETTER EXECUTED'); } }); ${define("value")}`));
      const result = await checkModuleModelExports({ modulesDirectory });
      assert.equal(result.diagnostics[0].code, "tiangz.model.invalid-export");
      assert.equal(result.diagnostics[0].exportPath, "modelExports.Value.unsafe");
      assert.doesNotMatch(result.diagnostics[0].message, /GETTER EXECUTED/);
    });
    await t.test("symbol properties are not silently ignored", async () => {
      await writeFile(modelFile, register(`const value = {}; value[Symbol('secret')] = 1; ${define("value")}`));
      const result = await checkModuleModelExports({ modulesDirectory });
      assert.equal(result.diagnostics[0].code, "tiangz.model.invalid-export");
      assert.match(result.diagnostics[0].exportPath, /Symbol\(secret\)/);
    });
    await t.test("wrong registration graph is rejected", async () => {
      await writeFile(modelFile, register(`defineGameModule({ id: "org.example.wrong", version: "1.0.0" });`));
      const result = await checkModuleModelExports({ modulesDirectory });
      assert.equal(result.ok, false);
      assert.match(result.diagnostics[0].message, /registration mismatch/);
    });
    await t.test("stable import boundary rejects Internal paths", async () => {
      await writeFile(modelFile, `import { Component } from "#tiangz/core/runtime/entities";\nexport { Component };`);
      const result = await checkModuleModelExports({ modulesDirectory });
      assert.equal(result.ok, false);
      assert.match(result.diagnostics[0].message, /Stable entrypoint/);
    });
    await t.test("unknown bare imports are not enabled by Node bundling", async () => {
      await writeFile(modelFile, `import fs from "node:fs"; console.log(fs);`);
      const result = await checkModuleModelExports({ modulesDirectory });
      assert.equal(result.ok, false);
      assert.match(result.diagnostics[0].message, /undeclared package node:fs/);
    });
    await t.test("Native declaration bindings can be exported but cannot execute", async () => {
      for (const folder of ["native", "rust/src"]) await mkdir(path.join(moduleRoot, folder), { recursive: true });
      await writeFile(path.join(moduleRoot, "native/Example.native"), "namespace example;\nabstract entity Entity { readonly id: u32; @transient readonly instanceId: u32; }\nop Add(left: u32, right: u32): u32;\n");
      await writeFile(path.join(moduleRoot, "rust/Cargo.toml"), '[package]\nname="model_check_native"\nversion="1.0.0"\nedition="2024"\n');
      await writeFile(path.join(moduleRoot, "rust/src/lib.rs"), "");
      const native = { source: "native", crate: "rust", crateName: "model_check_native", generatedRust: "rust/src/generated",
        generatedTypeScript: "src/model/generated/native", workers: [{ name: "compute", capacity: 1, maxInputBytes: 64, maxOutputBytes: 64 }] };
      await writeFile(manifestFile, JSON.stringify({ ...manifest, native }));
      try {
        const binding = moduleNativeGlobalName(manifest.id);
        await writeFile(modelFile, register(define(`globalThis.${binding}_workers`)));
        const accepted = await checkModuleModelExports({ modulesDirectory });
        assert.equal(accepted.ok, true, JSON.stringify(accepted));
        assert.equal(accepted.nativeExecutionVerified, false);
        for (const operation of [`globalThis.${binding}_workers.compute.call('x')`, `globalThis.${binding}.add(1, 2)`]) {
          await writeFile(modelFile, register(`${operation}; ${define("1")}`));
          const unavailable = await checkModuleModelExports({ modulesDirectory });
          assert.equal(unavailable.status, "unavailable", JSON.stringify(unavailable));
          assert.equal(unavailable.diagnostics[0].code, "tiangz.model.check-unavailable");
        }
      } finally { await writeFile(manifestFile, JSON.stringify(manifest)); }
    });
    await t.test("repeated success and failure checks never rewrite inputs", async () => {
      await writeFile(modelFile, register(define("1")));
      const files = [manifestFile, modelFile, path.join(moduleRoot, "src/hotfix/index.ts")];
      const before = await Promise.all(files.map(async file => ({ bytes: await readFile(file), mtime: (await stat(file)).mtimeMs })));
      assert.equal((await checkModuleModelExports({ modulesDirectory })).ok, true);
      assert.equal((await checkModuleModelExports({ modulesDirectory })).ok, true);
      for (let i = 0; i < files.length; i++) {
        assert.deepEqual(await readFile(files[i]), before[i].bytes);
        assert.equal((await stat(files[i])).mtimeMs, before[i].mtime);
      }
    });
    await t.test("timeout reclaims an infinite Model initializer", async () => {
      await writeFile(modelFile, "while (true) {}\n");
      const result = await checkModuleModelExports({ modulesDirectory, timeoutMs: 1_500 });
      assert.equal(result.status, "timed-out", JSON.stringify(result));
      assert.equal(result.cleanupFailed, false);
      assert.equal(result.ok, false);
    });
    await t.test("output overflow cannot count as a passing check", async () => {
      await writeFile(modelFile, register(`console.log('x'.repeat(8192)); ${define("1")}`));
      const result = await checkModuleModelExports({ modulesDirectory, maxOutputBytes: 1024 });
      assert.equal(result.outputTruncated, true);
      assert.equal(result.ok, false);
      assert.equal(result.status, "failed");
    });
    await t.test("result artifacts obey the same output budget before parsing", async () => {
      await writeFile(modelFile, "throw new Error('x'.repeat(8192));\n");
      const result = await checkModuleModelExports({ modulesDirectory, maxOutputBytes: 1024 });
      assert.equal(result.outputTruncated, true);
      assert.equal(result.ok, false);
      assert.equal(result.status, "failed");
      assert.ok(JSON.stringify(result).length < 1024);
    });
    await t.test("pre-start cancellation never executes Model code", async () => {
      await writeFile(modelFile, register(`throw Error('MODEL SHOULD NOT RUN'); ${define("1")}`));
      const controller = new AbortController(); controller.abort();
      const result = await checkModuleModelExports({ modulesDirectory, signal: controller.signal });
      assert.equal(result.status, "aborted");
      assert.doesNotMatch(result.output ?? "", /MODEL SHOULD NOT RUN/);
    });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("build and preflight share real cross-module Public API identities", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "tiangz-model-api-test-"));
  const modulesDirectory = path.join(temporary, "modules");
  try {
    const library = path.join(modulesDirectory, "library"), consumer = path.join(modulesDirectory, "consumer");
    const libraryManifest = await fixture(library, "org.example.library");
    await writeFile(path.join(library, "tiangz.module.json"), JSON.stringify({ ...libraryManifest, publicApi: "src/model/api.ts" }));
    await writeFile(path.join(library, "src/model/api.ts"), "export const Shared = Object.freeze({ count: 1 });\n");
    await writeFile(path.join(library, "src/model/index.ts"), 'import { defineGameModule } from "#tiangz/core"; import { Shared } from "./api"; defineGameModule({id:"org.example.library",version:"1.0.0",modelExports:{Shared}});\n');
    const consumerManifest = await fixture(consumer, "org.example.consumer");
    await writeFile(path.join(consumer, "tiangz.module.json"), JSON.stringify({ ...consumerManifest,
      dependencies: [{ id: "org.example.library", minVersion: "1.0.0", maxVersionExclusive: "2.0.0" }] }));
    await writeFile(path.join(consumer, "src/model/index.ts"), 'import { defineGameModule } from "#tiangz/core"; import { Shared } from "#tiangz/modules/org.example.library"; defineGameModule({id:"org.example.consumer",version:"1.0.0",modelExports:{Shared}});\n');
    const accepted = await checkModuleModelExports({ modulesDirectory });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.deepEqual(accepted.modules.map(module => module.id), ["org.example.library", "org.example.consumer"]);
    await writeFile(path.join(consumer, "tiangz.module.json"), JSON.stringify(consumerManifest));
    const rejected = await checkModuleModelExports({ modulesDirectory });
    assert.equal(rejected.ok, false);
    assert.match(rejected.diagnostics[0].message, /declared direct dependency/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

/** 最小清单夹具只声明真实模块入口；校验来自真实 Core。 / Declare real module entries while leaving validation to real Core. */
async function fixture(directory, id) {
  for (const folder of ["src/model", "src/hotfix"]) await mkdir(path.join(directory, folder), { recursive: true });
  const manifest = { formatVersion: 1, id, version: "1.0.0", engine: { minVersion: "0.7.0", maxVersionExclusive: "0.8.0" },
    dependencies: [], entries: { model: "src/model/index.ts", hotfix: "src/hotfix/index.ts" } };
  await writeFile(path.join(directory, "tiangz.module.json"), JSON.stringify(manifest));
  await writeFile(path.join(directory, "src/hotfix/index.ts"), "export {};\n");
  return manifest;
}
