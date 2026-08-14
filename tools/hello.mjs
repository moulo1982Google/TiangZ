import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const defaultConfig = "configs/local/all-in-one.json";
const configArgument = process.argv.slice(2).find((value) => !value.startsWith("--"));
const configPath = path.resolve(root, configArgument ?? defaultConfig);

await runNpm(["run", "build:debug"]);

const config = JSON.parse(await readFile(configPath, "utf8"));
const loginMgr = findScene(config, "LoginMgr");
const loginHost = loginMgr?.outerIp || loginMgr?.ip || "127.0.0.1";
const loginPort = loginMgr?.outerPort || loginMgr?.port;
if (!Number.isInteger(loginPort) || loginPort <= 0) {
  throw new Error(`配置 ${configPath} 没有找到 LoginMgr 的有效端口`);
}

process.stdout.write(`\n[hello] 启动 TiangZ：${path.relative(root, configPath)}\n`);
const runtime = spawn("cargo", ["run", "--bin", "TiangZ", "--", configPath], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
  windowsHide: false,
});

let stopping = false;
const stopRuntime = () => {
  if (stopping || runtime.exitCode !== null) return;
  stopping = true;
  runtime.kill("SIGINT");
};
process.once("SIGINT", stopRuntime);
process.once("SIGTERM", stopRuntime);

const runtimeExit = new Promise((resolve) => {
  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    resolve(result);
  };
  runtime.once("error", (error) => {
    process.stderr.write(`[hello] TiangZ 启动失败：${error.message}\n`);
    finish({ code: 1, signal: null });
  });
  runtime.once("exit", (code, signal) => finish({ code, signal }));
});
const ready = await waitForPortOrExit(loginHost, loginPort, 30_000, runtimeExit);
if (ready) {
  process.stdout.write("\n[hello] Starter 已就绪。\n");
  process.stdout.write(`[hello] 登录入口：ws://${loginHost}:${loginPort}\n`);
  process.stdout.write("[hello] 下一步：打开 Cocos3D/Pixi Demo，或阅读 docs/tutorials/00-quickstart.md。\n");
  process.stdout.write("[hello] 按 Ctrl+C 会停止本次启动的 TiangZ。\n\n");
} else if (runtime.exitCode === null) {
  process.stderr.write(`[hello] 等待 LoginMgr ${loginHost}:${loginPort} 超时；请查看上方运行日志。\n`);
}

const result = await runtimeExit;
if (result.signal && !stopping) process.stderr.write(`[hello] TiangZ 被信号 ${result.signal} 终止。\n`);
process.exitCode = result.code ?? 1;

function findScene(configValue, sceneType) {
  const scenes = Array.isArray(configValue?.scenes) ? configValue.scenes : [];
  return scenes.find((scene) => scene?.sceneType === sceneType);
}

async function runNpm(args) {
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : "npm";
  const commandArgs = npmCli ? [npmCli, ...args] : args;
  const child = spawn(command, commandArgs, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    shell: !npmCli && process.platform === "win32",
    windowsHide: false,
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (value) => resolve(value ?? 1));
  });
  if (code !== 0) throw new Error(`${command} ${commandArgs.join(" ")} 失败，退出码 ${code}`);
}

async function waitForPortOrExit(host, port, timeoutMs, runtimeExit) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await Promise.race([
      canConnect(host, port).then((value) => ({ ready: value })),
      runtimeExit.then(() => ({ exited: true })),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 250)),
    ]);
    if (result.ready) return true;
    if (result.exited) return false;
  }
  return false;
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}
