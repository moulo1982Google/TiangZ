import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(
  root,
  "target",
  "debug",
  process.platform === "win32" ? "TiangZ.exe" : "TiangZ",
);

await verifyOperatorShutdown();
await verifyUnexpectedChildExit();

/**
 * 验证运维停机时所有子进程都完成自身 TS 生命周期并以零状态退出。
 *
 * Verifies that operator shutdown lets every child complete its TS lifecycle and exit cleanly.
 */
async function verifyOperatorShutdown() {
  const watcher = startWatcher("configs/local/StartMachine.json");
  try {
    await Promise.all([7000, 7001, 7002, 7100, 7201, 7301].map(waitForPort));
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
          path.join(root, "configs/local/log.json"),
          path.join(root, "configs/local/log.json"),
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
    await waitForPortClosed(7100, 10_000);
    console.log("watcher failure self-test passed (unexpected child exit stopped siblings)");
  } finally {
    stopIfRunning(watcher.child);
    await rm(temporary, { recursive: true, force: true });
  }
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

function waitForExit(processHandle, timeoutMs) {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
    return Promise.resolve({ code: processHandle.exitCode, signal: processHandle.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Watcher shutdown timed out")), timeoutMs);
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
