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

export async function checkGameProject(project, tool) {
  const { moduleArgs, hostArgs } = gameProjectArguments(project);
  await tool("prepare_game_modules.mjs", ...hostArgs, "--check");
  await tool("codegen_module_protocol.mjs", ...hostArgs, "--check");
  for (const name of ["codegen_module_configs.mjs", "codegen_module_native.mjs"]) await tool(name, ...moduleArgs, "--check");
  await tool("typecheck_game_modules.mjs", ...hostArgs);
  await tool("check_module_model_exports.mjs", ...hostArgs);
  process.stdout.write("[check] 模块路径、生成物、类型与真实 Model 导出检查通过；未验证 Native 运算或启动服务。\n");
}

/** 开发锁实现见 game_project_lock.mjs；保留此导出供既有调用方使用。 / The development lock lives in game_project_lock.mjs; this export keeps existing callers working. */
export { acquireGameProjectLock } from "./game_project_lock.mjs";
