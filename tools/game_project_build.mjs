import path from "node:path";
import { open, unlink } from "node:fs/promises";

export function gameProjectArguments(project) {
  const moduleArgs = ["--modules-dir", project.modulesDirectory];
  return { moduleArgs, hostArgs: [...moduleArgs, "--host-profile", project.hostProfile], dist: path.join(project.root, "dist") };
}

/** 单一准备流程供显式 build 和源码开发模式复用。 / One preparation workflow for explicit builds and source development. */
export async function prepareGameProject(project, tool, updateLocks = false) {
  const { moduleArgs, hostArgs } = gameProjectArguments(project);
  if (updateLocks) process.stdout.write("[protocol-update] 显式更新模块协议锁与 SDK；完成后需要完整构建重启。\n");
  await tool("prepare_game_modules.mjs", ...hostArgs);
  await tool("codegen_module_protocol.mjs", ...hostArgs, ...(updateLocks ? ["--update-locks"] : []));
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
  for (const name of ["codegen_module_protocol.mjs", "codegen_module_configs.mjs", "codegen_module_native.mjs"]) await tool(name, ...moduleArgs, "--check");
  await tool("typecheck_game_modules.mjs", ...hostArgs);
  process.stdout.write("[check] 模块路径、生成物和类型检查通过；未启动服务。\n");
}

/** 不抢占遗留锁，防止两个构建/开发会话同时改写产物。 / Never steal a lock from another build or development session. */
export async function acquireGameProjectLock(project, action) {
  const file = path.join(project.root, ".tiangz-dev.lock");
  const lock = await open(file, "wx").catch(error => {
    if (error.code === "EEXIST") throw new Error(`已有开发命令占用工程：${file}。等待该命令结束；若上次异常退出，请确认记录的 PID 已停止后手动移除锁，不自动抢占。`);
    throw error;
  });
  try { await lock.writeFile(JSON.stringify({ pid: process.pid, action, startedAt: new Date().toISOString() })); }
  catch (error) { await lock.close(); await unlink(file); throw error; }
  return async () => { await lock.close(); await unlink(file); };
}
