import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

/** 启动受stdin控制的Runtime并收集输出；调用者必须在finally中停止它。 / Starts a stdin-controlled Runtime and captures output; callers must stop it in finally. */
export function startRuntime(root, config, name, profile = "debug", extraEnv = {}) {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const executable = path.join(root, "target", profile, `TiangZ${suffix}`);
  const child = spawn(executable, [config], {
    cwd: root,
    env: { ...process.env, ...extraEnv, TIANGZ_WATCHER_CONTROL: "stdin" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let spawnError;
  child.stdout.setEncoding("utf8").on("data", (chunk) => stdout += chunk);
  child.stderr.setEncoding("utf8").on("data", (chunk) => stderr += chunk);
  child.once("error", (error) => {
    spawnError = error;
    stderr += `[spawn] ${error.stack ?? error.message}\n`;
  });
  return {
    child,
    name,
    stdout: () => stdout,
    stderr: () => stderr,
    output: () => `${stdout}${stderr}`,
    spawnError: () => spawnError,
  };
}

/** 等待TCP监听可连接，并在子进程提前退出时携带日志失败。 / Waits for a TCP listener and fails with logs if the child exits early. */
export function waitForPort(port, runtime, timeoutMs = 15_000, host = "127.0.0.1") {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (runtime?.spawnError()) {
        reject(new Error(`${runtime.name} failed to start:\n${runtime.output()}`));
        return;
      }
      if (runtime?.child.exitCode !== null) {
        reject(new Error(`${runtime.name} exited before ${host}:${port} was ready:\n${runtime.output()}`));
        return;
      }
      const socket = net.createConnection({ host, port });
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve();
      };
      socket.setTimeout(300);
      socket.once("connect", () => finish());
      const retry = () => {
        socket.destroy();
        if (Date.now() >= deadline) finish(new Error(`timed out waiting for ${host}:${port}`));
        else setTimeout(attempt, 50);
      };
      socket.once("error", retry);
      socket.once("timeout", retry);
    };
    attempt();
  });
}

/** 等待Process就绪探针返回200。 / Waits until the Process readiness endpoint returns HTTP 200. */
export async function waitForReady(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ready`);
      if (response.status === 200) return;
    } catch {}
    await sleep(50);
  }
  throw new Error(`timed out waiting for http://127.0.0.1:${port}/ready`);
}

/** 运行一个前台测试命令，继承输出并检查退出码。 / Runs a foreground test command with inherited output and validates its exit code. */
export function runInherited(command, args, root, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
      env: { ...process.env, ...(options.env ?? {}) },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed with code=${code} signal=${signal ?? "none"}`));
    });
  });
}

/** 请求Runtime优雅停机；超时后强制终止并保留日志。 / Requests graceful Runtime shutdown and force-kills on timeout while preserving logs. */
export async function stopRuntime(runtime, timeoutMs = 15_000) {
  if (!runtime || runtime.child.exitCode !== null || runtime.child.signalCode !== null) return;
  runtime.child.stdin.end("shutdown\n");
  try {
    await waitForExit(runtime.child, timeoutMs);
  } catch {
    runtime.child.kill("SIGKILL");
    await waitForExit(runtime.child, 5_000).catch(() => undefined);
  }
}

/** 将失败现场写到忽略目录，成功测试不会污染仓库根目录。 / Writes failure evidence under an ignored directory; successful tests leave no root logs. */
export function writeFailureLogs(root, suite, runtimes) {
  const directory = path.join(root, "temp", "test-logs", suite);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  for (const runtime of runtimes) {
    writeFileSync(path.join(directory, `${runtime.name}_stdout.log`), runtime.stdout(), "utf8");
    writeFileSync(path.join(directory, `${runtime.name}_stderr.log`), runtime.stderr(), "utf8");
  }
  return directory;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process ${child.pid} exit timed out`)), timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
