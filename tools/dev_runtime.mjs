import { spawn, execFileSync } from "node:child_process";
import { watch } from "node:fs";
import path from "node:path";
import process from "node:process";
import { access, readFile, realpath } from "node:fs/promises";

import { loadGameModuleCatalog } from "./game_module_catalog.mjs";
import { loadGameProject } from "./game_project_config.mjs";
import { acquireGameProjectLock, buildGameProject, gameProjectArguments } from "./game_project_build.mjs";
import { immutableCandidateFromOutput } from "./build_result.mjs";
import { createSourceChangeGuard } from "./source_change_guard.mjs";

const root = path.resolve(import.meta.dirname, "..");
const hotfixRoot = path.join(root, "app", "hotfix");
const gameConfigWatchTargets = [
  { source: path.join(root, "game_config", "Datas"), recursive: true },
  { source: path.join(root, "game_config", "Defines"), recursive: true },
  { source: path.join(root, "game_config", "luban.conf"), recursive: false },
];
const defaultConfig = "configs/local/cluster/StartMachine.json";
const defaultDebugConfig = "configs/local/debug/StartMachine.json";
const debounceMs = 250;
let commandEnvironment = process.env;

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  try { await main(); }
  catch (error) { process.stderr.write(`[dev] ${errorMessage(error)}\n`); process.exitCode = 1; }
}

/**
 * 对开发人员隐藏重复构建步骤，并把Hotfix与游戏配置变化串行发布给Watcher。
 * Hides repetitive build steps and serially publishes Hotfix and game-config changes to the Watcher.
 *
 * 副作用：启动子进程、监听源码，并在退出时请求Watcher优雅停机；不得用于正式部署。
 * Side effects: starts child processes, watches sources, and requests graceful Watcher shutdown on exit; do not use for production deployment.
 */
async function main() {
  const options = parseDevArguments(process.argv.slice(2));
  const projectArgument = options.project;
  const project = projectArgument ? await loadGameProject(path.resolve(projectArgument)) : undefined;
  if (project && await realpath(project.engineRoot) !== await realpath(root)) throw new Error("开发工具与 tiangz.project.json 的宿主不一致");
  const release = project ? await acquireGameProjectLock(project, "dev") : async () => {};
  try { await runRuntime(project, options); } finally { await release(); }
}

/** 共用监听与候选发布状态机；模块模式只替换准备步骤和路径。 / Share the watcher/publication state machine; module mode only changes preparation and paths. */
async function runRuntime(project, options) {
  const debug = options.debug;
  const modulesArgument = options.modulesDirectory ?? process.env.TIANGZ_MODULES_DIR;
  const moduleCatalog = await loadGameModuleCatalog({
    projectRoot: root,
    modulesDirectory: project?.modulesDirectory ?? (modulesArgument
      ? path.resolve(root, modulesArgument)
      : path.join(root, "modules")),
  });
  commandEnvironment = {
    ...process.env,
    TIANGZ_MODULES_DIR: moduleCatalog.directory,
  };
  const config = project?.machineConfig ?? options.config
    ?? (debug ? defaultDebugConfig : defaultConfig);
  if (path.basename(config).toLowerCase() !== "startmachine.json") {
    throw new Error("dev source mode requires a StartMachine.json Watcher config");
  }

  const projectArgs = project ? gameProjectArguments(project) : undefined;
  const binary = path.join(root, "target/debug", process.platform === "win32" ? "TiangZ.exe" : "TiangZ");
  const tool = (name, ...args) => runCommand(process.execPath, [path.join(root, "tools", name), ...args], true);
  if (project) {
    if (moduleCatalog.modules.some(module => module.native)) throw new Error("模块源码开发模式暂不自动选择 Native 组合宿主，不能回退普通二进制。");
    try { await access(binary); } catch { throw new Error("缺少宿主二进制；先在开发工程运行 npm run host-build。"); }
    const version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
    const actual = execFileSync(binary, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 5000 }).trim();
    if (actual !== `TiangZ ${version}`) throw new Error(`宿主版本不一致：${actual}；运行 npm run host-build。`);
    process.stdout.write(`[dev] 准备并构建独立 TS 模块（不运行 Cargo），modules=${moduleCatalog.modules.length}...\n`);
    await runDevelopmentCheck(() => buildGameProject(project, tool, debug));
  } else {
    process.stdout.write(`[dev] 初次构建 Model/Hotfix 与客户端产物，modules=${moduleCatalog.modules.length}...\n`);
    await runDevelopmentCheck(() => runNpm(["run", debug ? "build:debug" : "build"]));
  }

  process.stdout.write(`[dev] 启动 Watcher：${config}\n`);
  const runtime = spawn(project ? binary : "cargo", project ? [`--runtime-root=${project.root}`, config] : ["run", "--bin", "TiangZ", "--", config], {
    cwd: root,
    env: commandEnvironment,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  runtime.stdout.on("data", (chunk) => process.stdout.write(chunk));
  runtime.stderr.on("data", (chunk) => process.stderr.write(chunk));
  let stopping = false;
  let building = false;
  let pendingHotfix = false;
  let pendingGameConfig = false;
  let timer;
  let stopTimer;
  let activeBuild;
  let restartRequired = false;
  let stableGuard;
  const watchers = [];
  const closed = new Promise(resolve => runtime.once("close", code => resolve(code ?? 1)));
  runtime.once("error", (error) => stopWithError(`Watcher 启动失败：${error.message}`));
  runtime.stdin.on("error", error => { if (!stopping) stopWithError(`Watcher 控制通道失败：${error.message}`); });

  const hotfixWatchTargets = [...new Set([
    ...(project ? [] : [hotfixRoot]),
    ...moduleCatalog.modules.flatMap((module) => module.entries.hotfixRoots),
  ])];
  const generatedConfigRoots = moduleCatalog.modules.filter(m => m.gameConfig).flatMap(m => [
    m.gameConfig.generatedCode, m.gameConfig.generatedData,
    ...(m.gameConfig.client ? [m.gameConfig.client.generatedCode, m.gameConfig.client.generatedData] : []),
  ]);
  const ignoredConfigOutput = file => isGeneratedConfigEvent(file, generatedConfigRoots);
  try {
    for (const source of hotfixWatchTargets) {
      const watcher = watch(source, { recursive: true }, (_event, filename) => {
        if (!filename || !filename.endsWith(".ts") || stopping || restartRequired) return;
        if (ignoredConfigOutput(path.resolve(source, filename))) return;
        pendingHotfix = true;
        scheduleBuild();
      });
      watcher.on("error", (error) => {
        stopWithError(`Hotfix 文件监听失败：${source}: ${error.message}`);
      });
      watchers.push(watcher);
    }

    const moduleConfigSources = [...new Set(moduleCatalog.modules.filter(m => m.gameConfig)
      .map(m => path.dirname(m.gameConfig.project)))];
    for (const { source, recursive } of [...(project ? [] : gameConfigWatchTargets),
      ...moduleConfigSources.map(source => ({ source, recursive: true })),
    ]) {
      const watcher = watch(source, { recursive }, (_event, filename) => {
        if (stopping || restartRequired || (filename && filename.startsWith("~$"))) return;
        if (filename && ignoredConfigOutput(path.resolve(source, filename))) return;
        pendingGameConfig = true;
        scheduleBuild();
      });
      watcher.on("error", (error) => stopWithError(`游戏配置文件监听失败：${error.message}`));
      watchers.push(watcher);
    }
    if (project) {
      const stableTargets = [
        ...moduleCatalog.modules.flatMap(module => module.entries.modelRoots.map(source => ({ source, recursive: true, extensions: [".ts"] }))),
        ...moduleCatalog.modules.filter(module => module.protocol).map(module => ({ source: module.protocol.source, recursive: true, extensions: [".proto", ".json"] })),
        ...moduleCatalog.modules.map(module => ({ source: module.manifestFile, recursive: false, file: true })),
        { source: project.file, recursive: false, file: true },
        { source: project.modulesDirectory, recursive: false, listingOnly: true },
        { source: path.dirname(project.machineConfig), recursive: true, extensions: [".json"] },
        { source: project.processConfig, recursive: false, file: true },
      ];
      stableGuard = await createSourceChangeGuard(stableTargets, source => {
        if (stopping || restartRequired) return;
        restartRequired = true;
        clearTimeout(timer);
        process.stdout.write(`[dev] 需要重启：Model、协议、模块声明或启动配置内容发生变化（${source}）。当前服务保持旧版本；停止后重新 npm run dev，协议变更先 protocol-update。\n`);
      }, error => stopWithError(`稳定源码检查失败：${error.message}`));
      for (const { source, recursive, file } of stableTargets) {
        const watcher = watch(file ? path.dirname(source) : source, { recursive }, (_event, filename) => {
          if (file && filename && filename.toString() !== path.basename(source)) return;
          if (stopping || restartRequired) return;
          stableGuard.notify(source);
        });
        watcher.on("error", error => stopWithError(`稳定源码监听失败：${source}: ${error.message}`));
        watchers.push(watcher);
      }
      stableGuard.notify("监听初始化检查");
    }

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", forwardInput);
    process.stdin.once("end", requestShutdown);
    process.stdin.resume();
    if (process.stdin.readableEnded) requestShutdown();

    process.stdout.write(
      `[dev] 正在监听 Hotfix 与 game_config 源文件；保存后将自动构建并切换${debug ? project ? "；调试 Bundle 已启用，Inspector 需在 Process 配置中显式启用" : "，Inspector连接与TS源码断点保持有效" : ""}。\n`,
    );

    process.once("SIGINT", requestShutdown);
    process.once("SIGTERM", requestShutdown);

    const exitCode = await closed;
    if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = exitCode;
  } catch (error) {
    stopWithError(errorMessage(error));
    await closed;
  } finally {
    stopping = true;
    clearTimeout(timer);
    clearTimeout(stopTimer);
    stableGuard?.close();
    for (const watcher of watchers) watcher.close();
    process.stdin.off("data", forwardInput);
    process.stdin.off("end", requestShutdown);
    process.stdin.pause();
    process.off("SIGINT", requestShutdown);
    process.off("SIGTERM", requestShutdown);
    await activeBuild;
  }

  function forwardInput(chunk) {
    if (!stopping && runtime.stdin.writable) runtime.stdin.write(chunk);
  }
  function scheduleBuild() {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!building && !stopping && !restartRequired) activeBuild = requestBuild(); }, debounceMs);
  }

  /**
   * 合并连续保存并保证同一时刻只有一个候选构建；构建期间再次变化会在本轮结束后补跑一次。
   * Coalesces rapid saves and allows only one candidate build at a time; changes during a build trigger one follow-up build.
   */
  async function requestBuild() {
    if (building) {
      return;
    }
    building = true;
    try {
      do {
        if (pendingGameConfig) {
          pendingGameConfig = false;
          process.stdout.write("[dev] 游戏配置已变化，正在生成并校验数据候选...\n");
          let candidate;
          if (project) {
            await tool("codegen_module_configs.mjs", ...projectArgs.moduleArgs);
            const output = await tool("build_game_config_data.mjs", ...projectArgs.moduleArgs, "--out-dir", projectArgs.dist);
            candidate = immutableCandidateFromOutput(output, "game-config", projectArgs.dist);
          } else {
            await runNpm(["run", "codegen:module-config"]);
            const output = await runNpmCapture(["run", "build:game-config"]);
            candidate = gameConfigCandidateDirectoryFromOutput(output);
          }
          await stableGuard?.ready();
          if (stopping || restartRequired) return;
          if (!runtime.stdin.writable) throw new Error("Watcher stdin is closed");
          runtime.stdin.write(`reload-config ${path.resolve(root, candidate)}\n`);
          process.stdout.write(`[dev] 已提交配置切换：${candidate}\n`);
        }
        if (pendingHotfix) {
          pendingHotfix = false;
          process.stdout.write("[dev] Hotfix 已变化，正在生成注册表并检查类型...\n");
          let candidate;
          if (project) {
            const output = await runDevelopmentCheck(() => tool("build_runtime_bundles.mjs", ...projectArgs.hostArgs, "--out-dir", projectArgs.dist, "--hotfix-only", ...(debug ? ["--debug"] : [])));
            candidate = immutableCandidateFromOutput(output, "hotfix", projectArgs.dist);
          } else {
            const output = await runDevelopmentCheck(async () => {
              await runNpm(["run", "codegen:scenes"]);
              await runNpm(["run", "typecheck"]);
              await runNpm(["run", "modules:typecheck"]);
              return runCommand(process.execPath, hotfixBuildArguments(debug), true);
            });
            candidate = candidateDirectoryFromOutput(output);
          }
          await stableGuard?.ready();
          if (stopping || restartRequired) return;
          if (!runtime.stdin.writable) throw new Error("Watcher stdin is closed");
          runtime.stdin.write(`reload ${path.resolve(root, candidate)}\n`);
          process.stdout.write(`[dev] 已提交 Reload：${candidate}\n`);
        }
      } while ((pendingHotfix || pendingGameConfig) && !stopping && !restartRequired);
    } catch (error) {
      process.stderr.write(`[dev] 候选未发布，当前Hotfix/配置继续运行：${errorMessage(error)}\n`);
    } finally {
      building = false;
      if ((pendingHotfix || pendingGameConfig) && !stopping && !restartRequired) scheduleBuild();
    }
  }

  /** 请求 Watcher 使用现有优雅停机协议退出，不直接杀死它管理的 Process。 / Requests Watcher shutdown through its graceful protocol instead of killing managed Processes. */
  function requestShutdown() {
    if (stopping) return;
    stopping = true;
    stableGuard?.close();
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
    if (runtime.stdin.writable) runtime.stdin.write("shutdown\n");
    stopTimer = setTimeout(() => {
      process.stderr.write("[dev] Watcher 停机超时，仅终止本开发会话的子进程。\n");
      process.exitCode = 1;
      runtime.kill();
    }, 15000);
  }

  /** 记录宿主级错误后复用优雅停机路径。 / Records a host-level error and reuses the graceful shutdown path. */
  function stopWithError(message) {
    process.stderr.write(`[dev] ${message}\n`);
    process.exitCode = 1;
    requestShutdown();
  }
}

/**
 * 执行一个构建命令并实时转发输出；capture=true 时同时保留 stdout 用于读取候选目录。
 * Runs a build command and streams output; capture=true also retains stdout so the candidate directory can be parsed.
 */
async function runCommand(command, args, capture = false, shell = false) {
  const child = spawn(command, args, {
    cwd: root,
    env: commandEnvironment,
    windowsHide: true,
    shell,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    if (capture) stdout += text;
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (value) => resolve(value ?? 1));
  });
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed with exitCode=${code}`);
  return stdout;
}

/** 从构建器的稳定 output 字段读取不可变候选目录。 / Reads the immutable candidate directory from the builder's stable output field. */
export function candidateDirectoryFromOutput(output) {
  const matches = [...output.matchAll(/(?:^|\s)output=([^\r\n\s]+)/g)];
  const candidate = matches.at(-1)?.[1];
  if (!candidate?.startsWith("dist/hotfix-candidates/")) {
    throw new Error("Hotfix builder did not report an immutable candidate directory");
  }
  return candidate;
}

/**
 * 优先复用当前 npm 的 CLI 路径，避开 Windows 下直接 spawn npm.cmd 的 EINVAL；直接 node 启动时才回退到 shell。
 * Prefers the current npm CLI path to avoid Windows EINVAL from spawning npm.cmd directly; falls back to a shell only when launched through node directly.
 */
function runNpm(args) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) return runCommand(process.execPath, [npmCli, ...args]);
  return runCommand("npm", args, false, process.platform === "win32");
}

/** 执行npm命令并保留stdout，以读取内容寻址的配置候选目录。 / Runs npm while retaining stdout so the content-addressed config candidate can be read. */
function runNpmCapture(args) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) return runCommand(process.execPath, [npmCli, ...args], true);
  return runCommand("npm", args, true, process.platform === "win32");
}

/** 从配置构建器的稳定candidate字段读取不可变目录。 / Reads the immutable directory from the config builder's stable candidate field. */
export function gameConfigCandidateDirectoryFromOutput(output) {
  const matches = [...output.matchAll(/(?:^|\s)candidate=([^\r\n\s]+)/g)];
  const candidate = matches.at(-1)?.[1];
  if (!candidate?.startsWith("dist/game-config-candidates/")) {
    throw new Error("GameConfig builder did not report an immutable candidate directory");
  }
  return candidate;
}

/** 提取未知异常的可读消息。 / Extracts a readable message from an unknown failure. */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 让初始Bundle和后续候选使用同一种调试制品格式。 / Keeps the initial bundle and later candidates in the same debug artifact format. */
export function hotfixBuildArguments(debug) {
  return ["tools/build_runtime_bundles.mjs", "--hotfix-only", ...(debug ? ["--debug"] : [])];
}

export function positionalArguments(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--modules-dir" || value === "--project") {
      index += 1;
      continue;
    }
    if (value.startsWith("--")) continue;
    result.push(value);
  }
  return result;
}

export function parseDevArguments(args) {
  const result = { debug: false };
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === "--debug") { result.debug = true; continue; }
    const name = value.split("=", 1)[0];
    if (name === "--project" || name === "--modules-dir") {
      const key = name === "--project" ? "project" : "modulesDirectory";
      if (result[key] !== undefined) throw new Error(`重复参数：${name}`);
      const argument = value.includes("=") ? value.slice(name.length + 1) : args[++index];
      if (!argument || argument.startsWith("--")) throw new Error(`${name} requires a value`);
      result[key] = argument;
    } else if (value.startsWith("--")) throw new Error(`未知开发参数 ${value}；独立模块使用 --project <工程目录>，模式从 tiangz.project.json 读取。`);
    else if (result.config) throw new Error("只能提供一个 StartMachine.json 配置路径");
    else result.config = value;
  }
  if (result.project && (result.config || result.modulesDirectory)) throw new Error("--project 不与配置路径或 --modules-dir 混用；统一修改 tiangz.project.json。");
  return result;
}

/** 只验证纯解析逻辑，避免自测启动编译器或真实服务器。 / Verifies pure parsing logic without starting compilers or a real server. */
function selfTest() {
  const project = parseDevArguments(["--debug", "--project=game with spaces"]);
  if (!project.debug || project.project !== "game with spaces") throw new Error("project dev arguments lost paths");
  for (const args of [["--project"], ["--unknown"], ["--project", "game", "--modules-dir", "modules"], ["one.json", "two.json"]]) {
    let refused = false;
    try { parseDevArguments(args); } catch { refused = true; }
    if (!refused) throw new Error(`invalid dev arguments accepted: ${args}`);
  }
  const generated = path.resolve(root, "modules/example/game_config/generated");
  if (!isGeneratedConfigEvent(path.join(generated, "server.json"), [generated]) ||
      !isGeneratedConfigEvent(path.resolve(root, "modules/example/.tiangz-codegen-123/0/schema.ts"), []) ||
      isGeneratedConfigEvent(path.resolve(root, "modules/example/game_config/Data/items.json"), [generated])) {
    throw new Error("module config watch must include sources and exclude generated/staged outputs");
  }
  const parsed = candidateDirectoryFromOutput(
    "noise\n[build:runtime] demo model=abc hotfix=def output=dist/hotfix-candidates/0123456789abcdef\n",
  );
  if (parsed !== "dist/hotfix-candidates/0123456789abcdef") throw new Error(`unexpected candidate: ${parsed}`);
  let rejected = false;
  try {
    candidateDirectoryFromOutput("output=dist/hotfix.js\n");
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("mutable Hotfix output was accepted");
  if (hotfixBuildArguments(false).includes("--debug")) {
    throw new Error("normal source mode unexpectedly enables debug bundles");
  }
  if (!hotfixBuildArguments(true).includes("--debug")) {
    throw new Error("debug source mode omitted inline sourcemaps");
  }
  const positional = positionalArguments([
    "--debug",
    "--modules-dir",
    "../game-modules",
    "configs/local/cluster/StartMachine.json",
  ]);
  if (positional.length !== 1 || !positional[0].endsWith("StartMachine.json")) {
    throw new Error(`dev runtime positional argument parsing failed: ${positional.join(",")}`);
  }
  const gameConfig = gameConfigCandidateDirectoryFromOutput(
    "[build:game-config] schema=aaa data=bbb candidate=dist/game-config-candidates/0123456789abcdef\n",
  );
  if (gameConfig !== "dist/game-config-candidates/0123456789abcdef") {
    throw new Error(`unexpected game config candidate: ${gameConfig}`);
  }
  process.stdout.write("dev runtime self-test passed\n");
}

function isGeneratedConfigEvent(file, generatedRoots) {
  if (file.split(/[\\/]/).some(part => /^\.tiangz-(?:codegen|protocol)-/.test(part))) return true;
  return generatedRoots.some(directory => {
    const relative = path.relative(directory, file);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

/** 编辑器检查轮次边界，不表示 Watcher 或游戏已经就绪。 / Editor diagnostic-cycle boundaries, not runtime readiness. */
async function runDevelopmentCheck(action) {
  process.stdout.write("[tiangz-dev-check] begin\n");
  try { return await action(); }
  finally { process.stdout.write("[tiangz-dev-check] end\n"); }
}
