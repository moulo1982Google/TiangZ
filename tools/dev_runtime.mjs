import { spawn } from "node:child_process";
import { watch } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const hotfixRoot = path.join(root, "app", "hotfix");
const gameConfigWatchTargets = [
  { source: path.join(root, "game_config", "Datas"), recursive: true },
  { source: path.join(root, "game_config", "Defines"), recursive: true },
  { source: path.join(root, "game_config", "luban.conf"), recursive: false },
];
const defaultConfig = "configs/local/StartMachine.json";
const debounceMs = 250;

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  await main();
}

/**
 * 对开发人员隐藏重复构建步骤，并把Hotfix与游戏配置变化串行发布给Watcher。
 * Hides repetitive build steps and serially publishes Hotfix and game-config changes to the Watcher.
 *
 * 副作用：启动子进程、监听源码，并在退出时请求Watcher优雅停机；不得用于正式部署。
 * Side effects: starts child processes, watches sources, and requests graceful Watcher shutdown on exit; do not use for production deployment.
 */
async function main() {
  const config = process.argv.slice(2).find((value) => !value.startsWith("--")) ?? defaultConfig;
  if (path.basename(config).toLowerCase() !== "startmachine.json") {
    throw new Error("dev source mode requires a StartMachine.json Watcher config");
  }

  process.stdout.write("[dev] 初次构建 Model/Hotfix 与客户端产物...\n");
  await runNpm(["run", "build"]);

  process.stdout.write(`[dev] 启动 Watcher：${config}\n`);
  const runtime = spawn("cargo", ["run", "--bin", "TiangZ", "--", config], {
    cwd: root,
    env: process.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  runtime.stdout.on("data", (chunk) => process.stdout.write(chunk));
  runtime.stderr.on("data", (chunk) => process.stderr.write(chunk));
  runtime.once("error", (error) => stopWithError(`Watcher 启动失败：${error.message}`));

  let stopping = false;
  let building = false;
  let pendingHotfix = false;
  let pendingGameConfig = false;
  let timer;

  const sourceWatcher = watch(hotfixRoot, { recursive: true }, (_event, filename) => {
    if (!filename || !filename.endsWith(".ts") || stopping) return;
    clearTimeout(timer);
    timer = setTimeout(() => void requestBuild("hotfix"), debounceMs);
  });
  sourceWatcher.on("error", (error) => stopWithError(`Hotfix 文件监听失败：${error.message}`));

  const configWatchers = gameConfigWatchTargets.map(({ source, recursive }) => {
    const watcher = watch(source, { recursive }, (_event, filename) => {
      if (stopping || (filename && filename.startsWith("~$"))) return;
      clearTimeout(timer);
      timer = setTimeout(() => void requestBuild("game-config"), debounceMs);
    });
    watcher.on("error", (error) => stopWithError(`游戏配置文件监听失败：${error.message}`));
    return watcher;
  });

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    if (!stopping && runtime.stdin.writable) runtime.stdin.write(chunk);
  });
  process.stdin.resume();

  process.stdout.write("[dev] 正在监听 Hotfix 与 game_config 源文件；保存后将自动构建并切换。\n");

  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);

  const exitCode = await new Promise((resolve) => runtime.once("exit", (code) => resolve(code ?? 1)));
  stopping = true;
  clearTimeout(timer);
  sourceWatcher.close();
  for (const watcher of configWatchers) watcher.close();
  if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = exitCode;

  /**
   * 合并连续保存并保证同一时刻只有一个候选构建；构建期间再次变化会在本轮结束后补跑一次。
   * Coalesces rapid saves and allows only one candidate build at a time; changes during a build trigger one follow-up build.
   */
  async function requestBuild(kind) {
    if (kind === "hotfix") pendingHotfix = true;
    else pendingGameConfig = true;
    if (building) {
      return;
    }
    building = true;
    try {
      do {
        if (pendingGameConfig) {
          pendingGameConfig = false;
          process.stdout.write("[dev] 游戏配置已变化，正在生成并校验数据候选...\n");
          const output = await runNpmCapture(["run", "build:game-config"]);
          const candidate = gameConfigCandidateDirectoryFromOutput(output);
          if (!runtime.stdin.writable) throw new Error("Watcher stdin is closed");
          runtime.stdin.write(`reload-config ${path.resolve(root, candidate)}\n`);
          process.stdout.write(`[dev] 已提交配置切换：${candidate}\n`);
        }
        if (pendingHotfix) {
          pendingHotfix = false;
          process.stdout.write("[dev] Hotfix 已变化，正在生成注册表并检查类型...\n");
          await runNpm(["run", "codegen:scenes"]);
          await runNpm(["run", "typecheck"]);
          const output = await runCommand(process.execPath, ["tools/build_runtime_bundles.mjs", "--hotfix-only"], true);
          const candidate = candidateDirectoryFromOutput(output);
          if (!runtime.stdin.writable) throw new Error("Watcher stdin is closed");
          runtime.stdin.write(`reload ${path.resolve(root, candidate)}\n`);
          process.stdout.write(`[dev] 已提交 Reload：${candidate}\n`);
        }
      } while ((pendingHotfix || pendingGameConfig) && !stopping);
    } catch (error) {
      process.stderr.write(`[dev] 候选未发布，当前Hotfix/配置继续运行：${errorMessage(error)}\n`);
    } finally {
      building = false;
    }
  }

  /** 请求 Watcher 使用现有优雅停机协议退出，不直接杀死它管理的 Process。 / Requests Watcher shutdown through its graceful protocol instead of killing managed Processes. */
  function requestShutdown() {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    sourceWatcher.close();
    for (const watcher of configWatchers) watcher.close();
    if (runtime.stdin.writable) runtime.stdin.write("shutdown\n");
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
    env: process.env,
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

/** 只验证纯解析逻辑，避免自测启动编译器或真实服务器。 / Verifies pure parsing logic without starting compilers or a real server. */
function selfTest() {
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
  const gameConfig = gameConfigCandidateDirectoryFromOutput(
    "[build:game-config] schema=aaa data=bbb candidate=dist/game-config-candidates/0123456789abcdef\n",
  );
  if (gameConfig !== "dist/game-config-candidates/0123456789abcdef") {
    throw new Error(`unexpected game config candidate: ${gameConfig}`);
  }
  process.stdout.write("dev runtime self-test passed\n");
}
