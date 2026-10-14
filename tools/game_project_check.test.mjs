import assert from "node:assert/strict";
import { test } from "node:test";
import { checkGameProject } from "./game_project_build.mjs";
import { gameProjectCheckTool } from "./game_project_check_runner.mjs";
import { gameProjectCheckIdentity } from "./game_project_check_identity.mjs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const project = { root: "/fixture", modulesDirectory: "/fixture/modules", hostProfile: "modules" };

test("project check uses the declared graph and preflights Model after generated and type checks", async () => {
  const calls = [];
  await checkGameProject(project, async (...args) => { calls.push(args); });
  assert.deepEqual(calls.map(args => args[0]), ["prepare_game_modules.mjs", "codegen_module_protocol.mjs",
    "codegen_module_configs.mjs", "codegen_module_native.mjs", "typecheck_game_modules.mjs", "check_module_model_exports.mjs"]);
  for (const call of calls) assert.equal(call[call.indexOf("--modules-dir") + 1], project.modulesDirectory);
  for (const call of calls.filter(args => ["codegen_module_protocol.mjs", "typecheck_game_modules.mjs", "check_module_model_exports.mjs"].includes(args[0]))) {
    assert.equal(call[call.indexOf("--host-profile") + 1], "modules");
  }
  assert.ok(calls.slice(0, 4).every(call => call.includes("--check")));
});

test("failed generation never executes Model, and failed Model never reports success", async () => {
  for (const failed of ["codegen_module_protocol.mjs", "check_module_model_exports.mjs"]) {
    const calls = [];
    await assert.rejects(checkGameProject(project, async name => {
      calls.push(name);
      if (name === failed) throw new Error(`failed ${name}`);
    }), new RegExp(`failed ${failed}`));
    assert.equal(calls.at(-1), failed);
    if (failed === "codegen_module_protocol.mjs") assert.ok(!calls.includes("check_module_model_exports.mjs"));
  }
});

test("reports retain failed Native compilation and skipped stages without an early success", async () => {
  for (const failed of ["codegen_module_protocol.mjs", "build_module_native.mjs"]) {
    let report;
    await assert.rejects(checkGameProject(project, async name => {
      if (name === failed) return { status: "failed", exitCode: 17, output: "original native or protocol diagnostic", cleanupFailed: false };
      return { status: "passed", exitCode: 0, cleanupFailed: false };
    }, { hasNative: true, quiet: true }), error => { report = error.checkReport; return true; });
    assert.equal(report.ok, false);
    const stage = report.stages.find(item => item.status === "failed");
    assert.equal(stage.script, failed);
    assert.equal(stage.exitCode, 17);
    assert.equal(stage.output, "original native or protocol diagnostic");
    assert.ok(report.stages.slice(report.stages.indexOf(stage) + 1).every(item => item.status === "skipped"));
    assert.equal(report.verification.nativeExecution, false);
    assert.equal(report.verification.database, false);
  }
});

test("cancellation stops stages and a declared absence differs from skipped failure work", async () => {
  const controller = new AbortController();
  const calls = [];
  await assert.rejects(checkGameProject(project, async name => { calls.push(name); controller.abort(); },
    { signal: controller.signal, quiet: true }), error => {
    assert.equal(error.checkReport.stages[1].status, "aborted");
    assert.equal(error.checkReport.counts.skipped, 5);
    return true;
  });
  assert.equal(calls.length, 1);
  const passed = await checkGameProject(project, async () => {}, { quiet: true });
  assert.equal(passed.ok, true);
  assert.equal(passed.counts.passed, 6);
  assert.equal(passed.counts.skipped, 0);
  assert.equal(passed.counts["not-applicable"], 1);
});

test("check runner timeout reclaims the owned tool and marks all later stages skipped", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "tiangz-check-runner-"));
  try {
    await mkdir(path.join(fixture, "tools"));
    await writeFile(path.join(fixture, "tools/prepare_game_modules.mjs"), "while (true) {}\n");
    const tool = gameProjectCheckTool(fixture, { quiet: true, timeoutMs: 1000 });
    await assert.rejects(checkGameProject(project, tool, { quiet: true }), error => {
      assert.equal(error.checkReport.stages[0].status, "timed-out");
      assert.equal(error.checkReport.stages[0].cleanupFailed, false);
      assert.equal(error.checkReport.counts.skipped, 6);
      return true;
    });
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("real project CLI emits one JSON report and releases its lock on success and invalid Model", async () => {
  const engine = path.resolve(import.meta.dirname, "..");
  await mkdir(path.join(engine, "temp"), { recursive: true });
  const temporary = await mkdtemp(path.join(engine, "temp", "project-check-report-"));
  const game = path.join(temporary, "game with spaces");
  const run = args => spawnSync(process.execPath, args, { cwd: engine, encoding: "utf8", timeout: 90_000, windowsHide: true });
  try {
    const created = run(["tools/create_game_project.mjs", "--path", game, "--id", "org.example.checkreport"]);
    assert.equal(created.status, 0, created.stderr);
    const setup = run(["tools/game_project.mjs", "setup", "--project", game]);
    assert.equal(setup.status, 0, setup.stderr);
    const passed = run(["tools/game_project.mjs", "check", "--project", game, "--json"]);
    assert.equal(passed.status, 0, passed.stderr + passed.stdout);
    const report = JSON.parse(passed.stdout);
    assert.equal(report.counts.passed, 7);
    assert.equal(report.counts["not-applicable"], 1);
    assert.equal(report.verification.serviceStartup, false);
    assert.ok(report.identity.graphHash);
    assert.equal(report.identity.engine.sourceSha256.length, 64);
    assert.equal(report.identity.dependencies.length, 4);
    assert.equal(report.stages[0].cwd, engine);
    assert.ok(report.stages.every(stage => stage.status === "not-applicable" || (stage.startedAt && stage.finishedAt && stage.testCount === null)));
    const model = path.join(game, "modules/starter/src/model/index.ts");
    await writeFile(model, (await readFile(model, "utf8")).replace("modelExports: {", "modelExports: { Invalid: new Set(),"));
    const failed = run(["tools/game_project.mjs", "check", "--project", game, "--json"]);
    assert.equal(failed.status, 1);
    const rejected = JSON.parse(failed.stdout);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.identity.graphHash, report.identity.graphHash);
    assert.notEqual(rejected.identity.modules[0].sourceSha256, report.identity.modules[0].sourceSha256);
    assert.equal(rejected.stages.find(stage => stage.status === "failed").name, "model-exports");
    assert.match(rejected.stages.find(stage => stage.status === "failed").output, /tiangz.model.invalid-export/);
    assert.equal(rejected.stages.at(-1).status, "skipped");
    await assert.rejects(readFile(path.join(game, ".tiangz-dev.lock")), { code: "ENOENT" });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("Model unavailable and inner timeout survive the bounded runner", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "tiangz-check-status-"));
  try {
    await mkdir(path.join(fixture, "tools"));
    for (const status of ["unavailable", "timed-out", "aborted"]) {
      await writeFile(path.join(fixture, "tools/check_module_model_exports.mjs"),
        `console.log(JSON.stringify({formatVersion:1, ok:false, status:${JSON.stringify(status)}, diagnostics:[{code:'original-probe-state',message:'original reason'}]})); process.exitCode=1;`);
      const runner = gameProjectCheckTool(fixture, { quiet: true });
      await assert.rejects(checkGameProject(project, async (name, ...args) =>
        name === "check_module_model_exports.mjs" ? runner(name, ...args) : undefined, { quiet: true }), error => {
        const report = error.checkReport;
        assert.equal(report.stages[5].status, status);
        assert.equal(report.stages[5].probe.diagnostics[0].message, "original reason");
        assert.equal(report.counts[status], 1);
        assert.equal(report.stages[6].status, "skipped");
        return true;
      });
    }
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("human and JSON reporting apply the same output budget", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "tiangz-check-output-"));
  try {
    await mkdir(path.join(fixture, "tools"));
    await writeFile(path.join(fixture, "tools/prepare_game_modules.mjs"), "console.log('X'.repeat(2048));");
    for (const quiet of [false, true]) {
      await assert.rejects(checkGameProject(project, gameProjectCheckTool(fixture, { quiet, maxOutputBytes: 1024 }), { quiet: true }), error => {
        assert.equal(error.checkReport.stages[0].outputTruncated, true);
        assert.equal(error.checkReport.stages[0].status, "failed");
        assert.equal(error.checkReport.counts.skipped, 6);
        return true;
      });
    }
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("source and actual dependency snapshots change independently from declared versions", async () => {
  const engine = await mkdtemp(path.join(os.tmpdir(), "tiangz-check-identity-"));
  const moduleRoot = path.join(engine, "modules/example");
  try {
    for (const directory of ["app", "tools", "src", "modules/example", ...["@tiangz/developer-tools-core", "@tiangz/native-language-core", "typescript", "esbuild"].map(name => `node_modules/${name}`)]) {
      await mkdir(path.join(engine, directory), { recursive: true });
    }
    for (const file of ["package.json", "package-lock.json", "Cargo.toml", "Cargo.lock", "tsconfig.json", "codegen.manifest.json", "build.rs", "rust-toolchain.toml", "src/runtime.rs", "tools/check.mjs", "app/core.ts"]) await writeFile(path.join(engine, file), "{}");
    for (const name of ["@tiangz/developer-tools-core", "@tiangz/native-language-core", "typescript", "esbuild"]) await writeFile(path.join(engine, "node_modules", name, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
    const moduleFile = path.join(moduleRoot, "model.ts");
    await writeFile(moduleFile, "export const value = 1;");
    const catalog = { engineVersion: "1.0.0", graphHash: "same graph", modules: [{ id: "org.example", version: "1.0.0", realRoot: moduleRoot }] };
    const initial = await gameProjectCheckIdentity(engine, catalog);
    assert.deepEqual(await gameProjectCheckIdentity(engine, catalog), initial);
    await writeFile(moduleFile, "export const value = 2;");
    await writeFile(path.join(engine, "tools/check.mjs"), "// changed tool");
    await writeFile(path.join(engine, "node_modules/@tiangz/developer-tools-core/rules.js"), "// same version, different package");
    const changed = await gameProjectCheckIdentity(engine, catalog);
    assert.equal(changed.graphHash, initial.graphHash);
    assert.notEqual(changed.modules[0].sourceSha256, initial.modules[0].sourceSha256);
    assert.notEqual(changed.engine.sourceSha256, initial.engine.sourceSha256);
    assert.notEqual(changed.dependencies[0].sourceSha256, initial.dependencies[0].sourceSha256);
    assert.equal(changed.dependencies[0].version, initial.dependencies[0].version);
    await writeFile(path.join(engine, "src/runtime.rs"), "// same version, changed Native host");
    assert.notEqual((await gameProjectCheckIdentity(engine, catalog)).engine.sourceSha256, changed.engine.sourceSha256);
    const nested = path.join(moduleRoot, "src/model/dist");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "legal.ts"), "export const value=1");
    const nestedBefore = await gameProjectCheckIdentity(engine, catalog);
    await writeFile(path.join(nested, "legal.ts"), "export const value=2");
    assert.notEqual((await gameProjectCheckIdentity(engine, catalog)).modules[0].sourceSha256, nestedBefore.modules[0].sourceSha256);
    const outside = path.join(engine, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "shared.ts"), "// outside module");
    await symlink(outside, path.join(moduleRoot, "target"), process.platform === "win32" ? "junction" : "dir");
    assert.deepEqual(await gameProjectCheckIdentity(engine, catalog), await gameProjectCheckIdentity(engine, catalog));
    await symlink(outside, path.join(moduleRoot, "escaped"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(gameProjectCheckIdentity(engine, catalog), /source link escapes/);
    await rm(path.join(moduleRoot, "escaped"));
    await mkdir(path.join(moduleRoot, "dist"));
    await writeFile(path.join(moduleRoot, "dist/model.ts"), "// explicitly declared source named dist");
    const declaredCatalog = { ...catalog, modules: [{ ...catalog.modules[0], entries: { modelRealRoots: [path.join(moduleRoot, "dist")] } }] };
    assert.notEqual((await gameProjectCheckIdentity(engine, declaredCatalog)).modules[0].sourceSha256,
      (await gameProjectCheckIdentity(engine, catalog)).modules[0].sourceSha256);
  } finally { await rm(engine, { recursive: true, force: true }); }
});

test("identity loading and hashing run inside the same cancellable deadline before other checks", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "tiangz-identity-deadline-"));
  try {
    await mkdir(path.join(fixture, "tools"));
    await writeFile(path.join(fixture, "tools/game_project_check_identity_probe.mjs"), "while (true) {}\n");
    for (const abort of [false, true]) {
      const controller = new AbortController();
      let timer;
      if (abort) timer = setTimeout(() => controller.abort(), 300);
      try {
        await assert.rejects(checkGameProject(project,
          gameProjectCheckTool(fixture, { quiet: true, timeoutMs: 1000, signal: controller.signal }),
          { collectIdentity: true, quiet: true, signal: controller.signal }), error => {
          assert.equal(error.checkReport.stages[0].name, "input-identity");
          assert.equal(error.checkReport.stages[0].status, abort ? "aborted" : "timed-out");
          assert.equal(error.checkReport.stages[0].cleanupFailed, false);
          assert.equal(error.checkReport.counts.skipped, 7);
          return true;
        });
      } finally { clearTimeout(timer); }
    }
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
