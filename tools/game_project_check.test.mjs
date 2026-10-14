import assert from "node:assert/strict";
import { test } from "node:test";
import { checkGameProject } from "./game_project_build.mjs";

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
