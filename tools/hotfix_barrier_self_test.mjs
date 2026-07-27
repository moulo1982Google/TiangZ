import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(
  root,
  "target",
  "debug",
  process.platform === "win32" ? "TiangZ.exe" : "TiangZ",
);
const candidate = path.join(root, "dist", "hotfix-candidates", "barrier-normal");
const watcher = spawn(executable, ["configs/bench/StartMachine.json"], {
  cwd: root,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
let watcherOutput = "";
watcher.stdout.setEncoding("utf8").on("data", appendWatcherOutput);
watcher.stderr.setEncoding("utf8").on("data", appendWatcherOutput);
let client;

try {
  await Promise.all([7400, 7607].map(waitForPort));
  client = spawn(process.execPath, [
    "dist/runtime_load_test.cjs",
    "--host", "127.0.0.1",
    "--port", "7400",
    "--duration", "1",
    "--warmup", "1",
    "--connections", "1",
    "--concurrency", "1",
    "--payload", "64",
    "--delay", "8000",
    "--drain", "15",
  ], {
    cwd: root,
    env: { ...process.env, TIANGZ_LOAD_SIGNAL_SENT: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let clientOutput = "";
  client.stdout.setEncoding("utf8").on("data", (chunk) => clientOutput += chunk);
  client.stderr.setEncoding("utf8").on("data", (chunk) => clientOutput += chunk);

  await waitFor(() => {
    if (client.exitCode !== null && !clientOutput.includes("[runtime-load] initial window sent")) {
      throw new Error(`slow RPC client exited before sending:\n${clientOutput}`);
    }
    return clientOutput.includes("[runtime-load] initial window sent");
  }, 10_000, "slow RPC client did not write its initial request");
  // Process在等待JS Promise时不会发布新的完整Scene快照，因此不能依赖
  // async_in_flight实时观测“1”；写入信号后留出一个本机调度窗口，再由最终
  // RPC结果和barrierWait共同证明排空语义。
  await sleep(250);
  const before = await readMetrics();
  watcher.stdin.write(`reload ${candidate}\n`);
  await sleep(300);
  const during = await readMetrics();
  if (during.generation !== before.generation || during.successes !== before.successes) {
    throw new Error(`Hotfix committed before slow RPC drained: ${JSON.stringify(during)}`);
  }

  const clientExit = await waitForChild(client, 20_000);
  if (clientExit.code !== 0) throw new Error(`slow RPC client failed:\n${clientOutput}`);
  await waitFor(async () => {
    const metrics = await readMetrics();
    return metrics.generation === 2 && metrics.successes === 1 && metrics.asyncInFlight === 0;
  }, 30_000, "Hotfix did not commit after slow RPC drained");
  const after = await readMetrics();
  if (after.barrierWaitMs < 5_000) {
    throw new Error(`Hotfix barrier did not record the slow RPC wait: ${after.barrierWaitMs}ms`);
  }

  watcher.stdin.end("shutdown\n");
  const watcherExit = await waitForChild(watcher, 45_000);
  if (watcherExit.code !== 0) {
    throw new Error(`Watcher failed with code=${watcherExit.code}:\n${watcherOutput}`);
  }
  console.log(
    `Hotfix slow-RPC barrier self-test passed: generation=2 barrier_wait_ms=${after.barrierWaitMs.toFixed(3)}`,
  );
} finally {
  if (client?.exitCode === null && client.signalCode === null) client.kill();
  if (watcher.exitCode === null && watcher.signalCode === null) watcher.kill();
}

function appendWatcherOutput(chunk) {
  watcherOutput += chunk;
}

async function readMetrics() {
  try {
    const response = await fetch("http://127.0.0.1:7607/metrics");
    if (!response.ok) return {};
    const body = await response.text();
    return {
      generation: metric(body, "tiangz_hotfix_active_generation"),
      successes: metric(body, "tiangz_hotfix_reload_successes_total"),
      failures: metric(body, "tiangz_hotfix_reload_failures_total"),
      barrierWaitMs: metric(body, "tiangz_hotfix_barrier_wait_ms"),
      asyncInFlight: metricSum(body, "tiangz_scene_async_in_flight"),
    };
  } catch {
    return {};
  }
}

function metric(body, name) {
  const line = body.split(/\r?\n/).find((value) => value.startsWith(`${name}{`));
  return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : 0;
}

function metricSum(body, name) {
  return body.split(/\r?\n/)
    .filter((value) => value.startsWith(`${name}{`))
    .reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(" ") + 1)), 0);
}

function waitForPort(port) {
  return waitFor(() => canConnect(port), 20_000, `timed out waiting for 127.0.0.1:${port}`);
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

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error(`${message}\n${watcherOutput}`);
}

function waitForChild(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
