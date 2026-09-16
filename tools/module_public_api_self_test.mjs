import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(root, "temp"), { recursive: true });
const fixture = await mkdtemp(path.join(root, "temp", "module-api-"));
const modules = path.join(fixture, "modules");
const output = path.join(fixture, "dist");
try {
  for (const name of ["provider", "consumer"]) {
    const directory = path.join(modules, name);
    await mkdir(path.join(directory, "src", "model"), { recursive: true });
    await mkdir(path.join(directory, "src", "hotfix"), { recursive: true });
    await writeFile(path.join(directory, "tiangz.module.json"), JSON.stringify({
      formatVersion: 1, id: `org.example.${name}`, version: "1.0.0",
      engine: { minVersion: "0.6.0-alpha.0", maxVersionExclusive: "0.7.0" },
      dependencies: name === "provider" ? [] : [{ id: "org.example.provider", minVersion: "1.0.0", maxVersionExclusive: "2.0.0" }],
      entries: { model: "src/model/index.ts", hotfix: "src/hotfix/index.ts" },
      ...(name === "provider" ? { publicApi: "src/model/public.ts" } : {}),
    }));
    await writeFile(path.join(directory, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, target: "ES2022", module: "ES2022", moduleResolution: "Bundler", experimentalDecorators: true, skipLibCheck: true },
      include: ["src/**/*.ts"],
    }));
    await writeFile(path.join(directory, "src/model/index.ts"),
      `import { defineGameModule } from "#tiangz/core";\ndefineGameModule({ id: "org.example.${name}", version: "1.0.0" });\n`);
    await writeFile(path.join(directory, "src/hotfix/index.ts"), "export {};\n");
  }
  const apiFile = path.join(modules, "provider/src/model/public.ts");
  const consumerFile = path.join(modules, "consumer/src/hotfix/index.ts");
  await writeFile(apiFile, "export class Counter { value = 1; }\nexport interface Options { count: number; }\n");
  const valid = 'import { Counter, type Options } from "#tiangz/modules/org.example.provider";\nconst options: Options = { count: 3 };\nif (new Counter().value !== 1 || options.count !== 3) throw new Error("API identity fixture");\n';
  await writeFile(consumerFile, valid);
  const consumerModel = path.join(modules, "consumer/src/model/index.ts");
  const originalModel = await readFile(consumerModel, "utf8");
  await writeFile(consumerModel, originalModel + "\nexport const MissingBridgeValue = 1;\n");
  await writeFile(consumerFile, 'import { MissingBridgeValue } from "#tiangz/module";\nvoid MissingBridgeValue;\n');
  run("tools/typecheck_game_modules.mjs", ["--modules-dir", modules], /runtime bridge is missing MissingBridgeValue/);
  await writeFile(consumerModel, 'import { defineGameModule } from "#tiangz/core";\nexport const MissingBridgeValue = 1;\ndefineGameModule({ id: "org.example.consumer", version: "1.0.0", modelExports: { MissingBridgeValue } });\nconst unrelated = { defineGameModule(_value: object): void {} };\nunrelated.defineGameModule({ modelExports: {} });\n');
  run("tools/typecheck_game_modules.mjs", ["--modules-dir", modules]);
  const registeredModel = await readFile(consumerModel, "utf8");
  await writeFile(consumerModel, registeredModel + '\nexport function unusedAlternative(): void { defineGameModule({ id: "org.example.alternative", version: "1.0.0", modelExports: {} }); }\n');
  run("tools/typecheck_game_modules.mjs", ["--modules-dir", modules]);
  await writeFile(consumerModel, originalModel);
  await writeFile(consumerFile, valid);
  const consumerConfigFile = path.join(modules, "consumer/tsconfig.json");
  const consumerConfig = JSON.parse(await readFile(consumerConfigFile, "utf8"));
  consumerConfig.compilerOptions.paths = { "fixture/*": ["./src/model/*"] };
  delete consumerConfig.include;
  consumerConfig.files = ["src/model/index.ts", "src/hotfix/index.ts"];
  await writeFile(path.join(modules, "consumer/unselected.ts"), 'const excluded: number = "not in this project";\n');
  await writeFile(consumerConfigFile, JSON.stringify(consumerConfig));
  run("tools/prepare_game_modules.mjs", ["--modules-dir", modules]);
  const prepared = JSON.parse(await readFile(consumerConfigFile, "utf8"));
  assert.deepEqual(prepared.compilerOptions.paths["fixture/*"], ["./src/model/*"]);
  assert.equal(Object.hasOwn(prepared, "compileOnSave"), false);
  assert.deepEqual(prepared.files, consumerConfig.files);
  assert.equal(prepared.include.some(value => value === "**/*" || value === "src/**/*.ts"), false);
  run("tools/prepare_game_modules.mjs", ["--modules-dir", modules, "--check"]);
  run("node_modules/typescript/bin/tsc", ["--project", path.join(modules, "consumer/tsconfig.json"), "--noEmit"]);
  run("tools/typecheck_game_modules.mjs", ["--modules-dir", modules]);
  run("tools/verify_hotfix_boundary.mjs", ["--modules-dir", modules]);
  run("tools/build_runtime_bundles.mjs", ["--modules-dir", modules, "--out-dir", output]);
  assert.match(await readFile(path.join(output, "hotfix.js"), "utf8"), /tiangz:module-api:org\.example\.provider/);
  const buildArgs = ["--modules-dir", modules, "--out-dir", output, "--hotfix-only"];
  run("tools/build_runtime_bundles.mjs", buildArgs);
  await writeFile(apiFile, "export class Counter { value = 2; }\nexport interface Options { count: number; }\n");
  run("tools/build_runtime_bundles.mjs", buildArgs, /Model source changed/);
  await writeFile(consumerFile, valid.replace("count: 3", 'count: "wrong"'));
  run("tools/typecheck_game_modules.mjs", ["--modules-dir", modules], /not assignable to type 'number'/);
  await writeFile(consumerFile, valid.replace("org.example.provider", "org.example.provider/internal"));
  run("tools/typecheck_game_modules.mjs", ["--modules-dir", modules], /declared direct dependency/);
  run("tools/build_runtime_bundles.mjs", ["--modules-dir", modules, "--out-dir", output], /declared direct dependency/);
  await writeFile(consumerFile, valid);
  const manifestFile = path.join(modules, "consumer/tiangz.module.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.dependencies = [];
  await writeFile(manifestFile, JSON.stringify(manifest));
  run("tools/prepare_game_modules.mjs", ["--modules-dir", modules, "--check"], /stale module editor configuration/);
  run("tools/prepare_game_modules.mjs", ["--modules-dir", modules]);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(consumerConfigFile, "utf8")).compilerOptions.paths,
    "#tiangz/modules/org.example.provider"), false);
  run("tools/typecheck_game_modules.mjs", ["--modules-dir", modules], /declared direct dependency/);
  run("tools/verify_hotfix_boundary.mjs", ["--modules-dir", modules], /declared direct dependency/);
  // 删除依赖方后可完整构建新进程；旧制品保留自己的Model身份。
  // Removing a dependent permits a complete new process build; old artifacts retain their Model identities.
  const oldBundle = await readFile(path.join(output, "model.js"), "utf8");
  const oldContext = { TextEncoder, TextDecoder, console, setTimeout, clearTimeout };
  runInNewContext(oldBundle, oldContext);
  assert.equal(new oldContext.__tiangzModulePublicApis["org.example.provider"].Counter().value, 1);
  await rm(path.join(modules, "consumer"), { recursive: true, force: true });
  run("tools/build_runtime_bundles.mjs", ["--modules-dir", modules, "--out-dir", output]);
  const newContext = { TextEncoder, TextDecoder, console, setTimeout, clearTimeout };
  runInNewContext(await readFile(path.join(output, "model.js"), "utf8"), newContext);
  assert.equal(new newContext.__tiangzModulePublicApis["org.example.provider"].Counter().value, 2);
  assert.equal(new oldContext.__tiangzModulePublicApis["org.example.provider"].Counter().value, 1);
} finally {
  await rm(fixture, { recursive: true, force: true });
}
process.stdout.write("module public API self-test passed\n");

function run(script, args, rejection) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  const output = result.stdout + result.stderr;
  if (rejection) {
    assert.notEqual(result.status, 0, output);
    assert.match(output, rejection);
  } else assert.equal(result.status, 0, output);
}
