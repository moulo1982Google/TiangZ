import { spawn } from "node:child_process";
import { appendFile, cp, mkdtemp, rm } from "node:fs/promises";
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
const candidates = {
  inverted: path.join(root, "dist", "hotfix-candidates", "inverted-test"),
  normal: path.join(root, "dist", "hotfix-candidates", "normal-test"),
};
const healthPorts = [7602, 7603, 7604, 7605, 7606];
const temporary = await mkdtemp(path.join(os.tmpdir(), "tiangz-hotfix-reload-"));

const watcher = spawn(executable, ["configs/local/StartMachine.json"], {
  cwd: root,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
let output = "";
watcher.stdout.setEncoding("utf8").on("data", appendOutput);
watcher.stderr.setEncoding("utf8").on("data", appendOutput);

try {
  await Promise.all([7000, 7001, 7002, 7201, 7301].map(waitForPort));
  await reloadAll(candidates.inverted, 2, 1);
  await reloadAll(candidates.normal, 3, 2);
  const corrupted = path.join(temporary, "corrupted");
  await cp(candidates.normal, corrupted, { recursive: true });
  await appendFile(path.join(corrupted, "hotfix.js"), "\n// corrupted after manifest\n", "utf8");
  watcher.stdin.write(`reload ${corrupted}\n`);
  await waitFor(async () => {
    const snapshots = await Promise.all(healthPorts.map(readHotfixMetrics));
    return snapshots.every((snapshot) =>
      snapshot.generation === 3 &&
      snapshot.successes === 2 &&
      snapshot.failures === 1
    );
  }, 30_000, "corrupted candidate did not preserve generation 3 in all Processes");
  watcher.stdin.end("shutdown\n");
  const { code, signal } = await waitForExit(45_000);
  if (code !== 0) {
    throw new Error(`Watcher exited with code=${code} signal=${signal}\n${output}`);
  }
  console.log("runtime Hotfix reload self-test passed: 5 Processes committed generations 2 and 3, then rejected a corrupted candidate without changing generation");
} finally {
  if (watcher.exitCode === null && watcher.signalCode === null) watcher.kill();
  await rm(temporary, { recursive: true, force: true });
}

function appendOutput(chunk) {
  output += chunk;
}

async function reloadAll(directory, generation, expectedSuccesses) {
  watcher.stdin.write(`reload ${directory}\n`);
  await waitFor(async () => {
    const snapshots = await Promise.all(healthPorts.map(readHotfixMetrics));
    return snapshots.every((snapshot) =>
      snapshot.generation === generation &&
      snapshot.successes === expectedSuccesses &&
      snapshot.failures === 0
    );
  }, 30_000, `generation ${generation} did not commit in all Processes`);
}

async function readHotfixMetrics(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/metrics`);
    if (!response.ok) return {};
    const text = await response.text();
    return {
      generation: metric(text, "tiangz_hotfix_active_generation"),
      successes: metric(text, "tiangz_hotfix_reload_successes_total"),
      failures: metric(text, "tiangz_hotfix_reload_failures_total"),
    };
  } catch {
    return {};
  }
}

function metric(text, name) {
  const line = text.split(/\r?\n/).find((value) => value.startsWith(`${name}{`));
  return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : undefined;
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
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${message}\n${output}`);
}

function waitForExit(timeoutMs) {
  if (watcher.exitCode !== null || watcher.signalCode !== null) {
    return Promise.resolve({ code: watcher.exitCode, signal: watcher.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Watcher did not stop within ${timeoutMs}ms\n${output}`)),
      timeoutMs,
    );
    watcher.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    watcher.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
