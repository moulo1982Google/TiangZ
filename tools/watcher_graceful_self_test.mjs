import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(
  root,
  "target",
  "debug",
  process.platform === "win32" ? "TiangZ.exe" : "TiangZ",
);

await verifyOperatorShutdown();
await verifyRunningChildExit();
await verifyUnexpectedChildExit();

/**
 * 验证运维停机时所有子进程都完成自身 TS 生命周期并以零状态退出。
 *
 * Verifies that operator shutdown lets every child complete its TS lifecycle and exit cleanly.
 */
async function verifyOperatorShutdown() {
  const watcher = startWatcher("configs/local/StartMachine.json");
  try {
    await Promise.all([7000, 7001, 7002, 7201, 7301].map(waitForPort));
    watcher.child.stdin.end("shutdown\n");
    const { code, signal } = await waitForExit(watcher.child, 30_000);
    if (code !== 0) throw new Error(`Watcher exited with code=${code} signal=${signal}`);
    console.log("watcher graceful self-test passed (all child exits successful and within timeout)");
  } finally {
    stopIfRunning(watcher.child);
  }
}

/**
 * 通过重复启动同一监听配置制造子进程失败，验证 Watcher 会停掉兄弟进程并返回非零状态。
 *
 * Starts the same listener configuration twice to force one child to fail, then verifies that
 * Watcher stops its sibling and exits with a nonzero status.
 */
async function verifyUnexpectedChildExit() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "tiangz-watcher-failure-"));
  const startMachine = path.join(temporary, "StartMachine.json");
  await writeFile(
    startMachine,
    `${JSON.stringify({
      machines: [{
        name: "watcher-failure-test",
        innerIp: "127.0.0.1",
        processes: [
          path.join(root, "configs/local/mgr.json"),
          path.join(root, "configs/local/mgr.json"),
        ],
      }],
    }, null, 2)}\n`,
    "utf8",
  );

  const watcher = startWatcher(startMachine);
  try {
    const { code, signal } = await waitForExit(watcher.child, 30_000);
    if (code === 0) throw new Error("Watcher unexpectedly succeeded after a child process failed");
    if (!watcher.output().includes("exited unexpectedly")) {
      throw new Error(`Watcher did not report the unexpected child exit:\n${watcher.output()}`);
    }
    await waitForPortClosed(7000, 10_000);
    console.log("watcher failure self-test passed (unexpected child exit stopped siblings)");
  } finally {
    stopIfRunning(watcher.child);
    await rm(temporary, { recursive: true, force: true });
  }
}

/**
 * 在全部端口就绪后强制终止一个真实子进程，验证Watcher关闭兄弟进程并返回失败。
 *
 * Force-kills one live child after all endpoints are ready, then verifies that
 * the Watcher stops every sibling and reports failure.
 */
async function verifyRunningChildExit() {
  const watcher = startWatcher("configs/local/StartMachine.json");
  try {
    const ports = [7000, 7001, 7002, 7201, 7301];
    await Promise.all(ports.map(waitForPort));
    const childPids = await directChildProcessIds(watcher.child.pid);
    if (childPids.length === 0) {
      throw new Error(`Watcher ${watcher.child.pid} has no discoverable child process`);
    }
    process.kill(childPids[0], "SIGKILL");
    const { code, signal } = await waitForExit(
      watcher.child,
      90_000,
      watcher.output,
    );
    if (code === 0) {
      throw new Error(`Watcher succeeded after child ${childPids[0]} was killed; signal=${signal}`);
    }
    if (!watcher.output().includes("exited unexpectedly")) {
      throw new Error(`Watcher did not report killed child failure:\n${watcher.output()}`);
    }
    await Promise.all(ports.map((port) => waitForPortClosed(port, 10_000)));
    console.log("watcher live-child fault injection passed (killed child stopped siblings)");
  } finally {
    stopIfRunning(watcher.child);
  }
}

/** 查询Watcher直接子进程，不依赖日志文本中的PID。 / Finds direct Watcher children without parsing process log text. */
async function directChildProcessIds(parentPid) {
  const { stdout } = process.platform === "win32"
    ? await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${parentPid} -and $_.Name -eq 'TiangZ.exe' } | Select-Object -ExpandProperty ProcessId`,
    ], { windowsHide: true })
    : await execFileAsync("ps", ["-o", "pid=", "--ppid", String(parentPid)]);
  return stdout
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
}

/** 启动一个可通过私有 stdin 控制的 Watcher，并收集完整输出。 / Starts a stdin-controlled Watcher and captures all output. */
function startWatcher(config) {
  const child = spawn(executable, [config], {
    cwd: root,
    env: { ...process.env, TIANGZ_WATCHER_CONTROL: "stdin" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => output += chunk);
  child.stderr.setEncoding("utf8").on("data", (chunk) => output += chunk);
  return { child, output: () => output };
}

function waitForPort(port) {
  const deadline = Date.now() + 15_000;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error(`timed out waiting for 127.0.0.1:${port}`));
        else setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

async function waitForPortClosed(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await canConnect(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`127.0.0.1:${port} remained open after Watcher failure`);
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(250, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function waitForExit(processHandle, timeoutMs, output = () => "") {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
    return Promise.resolve({ code: processHandle.exitCode, signal: processHandle.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(
      `Watcher shutdown timed out after ${timeoutMs}ms:\n${output()}`,
    )), timeoutMs);
    processHandle.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    processHandle.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function stopIfRunning(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill();
}
