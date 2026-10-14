import path from "node:path";

export function gameProjectArguments(project) {
  const moduleArgs = ["--modules-dir", project.modulesDirectory];
  return { moduleArgs, hostArgs: [...moduleArgs, "--host-profile", project.hostProfile], dist: path.join(project.root, "dist") };
}

/** 单一准备流程供显式 build 和源码开发模式复用。 / One preparation workflow for explicit builds and source development. */
export async function prepareGameProject(project, tool, updateLocks = false, devRegenSchemaLock = false) {
  const { moduleArgs, hostArgs } = gameProjectArguments(project);
  if (updateLocks) process.stdout.write("[protocol-update] 显式更新模块协议锁与 SDK；完成后需要完整构建重启。\n");
  if (devRegenSchemaLock) process.stdout.write("[protocol-update] 开发期重写 schema 锁：允许修改已有字段的类型、名称或编号；已删除字段的编号保留为墓碑；发布门禁下拒绝执行。\n");
  await tool("prepare_game_modules.mjs", ...hostArgs);
  await tool("codegen_module_protocol.mjs", ...hostArgs, ...(updateLocks ? ["--update-locks"] : []), ...(devRegenSchemaLock ? ["--dev-regen-schema-lock"] : []));
  await tool("codegen_module_configs.mjs", ...moduleArgs);
  await tool("codegen_module_native.mjs", ...moduleArgs);
}

export async function buildGameProject(project, tool, debug = false) {
  const { moduleArgs, hostArgs, dist } = gameProjectArguments(project);
  await prepareGameProject(project, tool);
  // Bundle preflight already owns typechecking; no second compiler invocation here.
  await tool("build_runtime_bundles.mjs", ...hostArgs, "--out-dir", dist, ...(debug ? ["--debug"] : []));
  await tool("build_game_config_data.mjs", ...moduleArgs, "--out-dir", dist, "--initial");
}

/** 逐阶段检查；首个失败/中止后标记剩余阶段 skipped，不执行修复或启动。 / Check stages in order and skip remaining work after failure or cancellation. */
export async function checkGameProject(project, tool, { hasNative = false, signal, quiet = false, identity = {}, collectIdentity = false } = {}) {
  const { moduleArgs, hostArgs } = gameProjectArguments(project);
  const stages = [
    ...(collectIdentity ? [["input-identity", "game_project_check_identity_probe.mjs", [project.modulesDirectory]]] : []),
    ["module-paths", "prepare_game_modules.mjs", [...hostArgs, "--check"]],
    ["protocol", "codegen_module_protocol.mjs", [...hostArgs, "--check"]],
    ["config", "codegen_module_configs.mjs", [...moduleArgs, "--check"]],
    ["native-generated", "codegen_module_native.mjs", [...moduleArgs, "--check"]],
    ["types", "typecheck_game_modules.mjs", hostArgs],
    ["model-exports", "check_module_model_exports.mjs", hostArgs],
    ["native-compilation", "build_module_native.mjs", [...moduleArgs, "--check"]],
  ];
  const report = { formatVersion: 1, action: "check", projectRoot: project.root, modulesDirectory: project.modulesDirectory,
    hostProfile: project.hostProfile, identity, startedAt: new Date().toISOString(), ok: false, stages: [],
    verification: { nativeExecution: false, serviceStartup: false, database: false, targetClient: false } };
  let failure;
  for (const [name, script, args] of stages) {
    if (failure) { report.stages.push({ name, script, status: "skipped", durationMs: 0, reason: "earlier stage failed or was interrupted" }); continue; }
    if (name === "native-compilation" && !hasNative) {
      report.stages.push({ name, script, status: "not-applicable", durationMs: 0, reason: "no Native module declared" }); continue;
    }
    const started = performance.now();
    const startedAt = new Date().toISOString();
    if (!quiet) process.stdout.write(`[check] ${name}: started\n`);
    let outcome;
    try {
      if (signal?.aborted) throw Object.assign(new Error("project check interrupted before stage startup"), { outcome: { status: "aborted", exitCode: 130 } });
      outcome = await tool(script, ...args);
      if (outcome && (outcome.status !== "passed" || outcome.cleanupFailed || outcome.outputTruncated)) {
        throw Object.assign(new Error(outcome.error ?? `project check stage failed: ${name}`), { outcome });
      }
      if (name === "input-identity") { report.identity = outcome.identity; hasNative = outcome.identity.hasNative; }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      outcome = error?.outcome ?? { status: "failed", exitCode: 1, error: failure.message };
    }
    report.stages.push({ name, script, args, ...outcome, status: failure ? outcome.status === "passed" ? "failed" : outcome.status : "passed",
      startedAt, finishedAt: new Date().toISOString(), testCount: null, testCountStatus: "not-applicable: validation stage, not a test suite",
      durationMs: Math.round(performance.now() - started) });
    if (!quiet) process.stdout.write(`[check] ${name}: ${report.stages.at(-1).status}\n`);
  }
  report.finishedAt = new Date().toISOString();
  report.ok = !failure;
  report.counts = Object.fromEntries(["passed", "failed", "unavailable", "timed-out", "aborted", "skipped", "not-applicable"]
    .map(status => [status, report.stages.filter(stage => stage.status === status).length]));
  if (failure) throw Object.assign(failure, { checkReport: report });
  if (!quiet) process.stdout.write("[check] 模块路径、生成物、类型与真实 Model 导出检查通过；未验证 Native 运算、服务、数据库或目标客户端。\n");
  return report;
}

/** 开发锁实现见 game_project_lock.mjs；保留此导出供既有调用方使用。 / The development lock lives in game_project_lock.mjs; this export keeps existing callers working. */
export { acquireGameProjectLock } from "./game_project_lock.mjs";
