import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const healthPorts = [7602, 7603, 7604, 7605, 7606];
const temporary = await mkdtemp(path.join(os.tmpdir(), "tiangz-game-config-reload-"));
const validCandidate = path.join(temporary, "valid");
const invalidCandidate = path.join(temporary, "invalid");

await createCandidate(validCandidate, (server, client) => {
  server.game_tbitemconfig[0].restore_hp = 77;
  client.game_tbitemconfig[0].restore_hp = 77;
});
await createCandidate(invalidCandidate, (server) => {
  server.game_tbplayerconfig[0].initial_map_id = 999_999;
});

const validManifest = JSON.parse(
  await readFile(path.join(validCandidate, "game-config.manifest.json"), "utf8"),
);
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
  await Promise.all([7000, 7001, 7002, 7201, 7301].map((port) => waitForPort(port)));
  await waitFor(async () => (await readAllMetrics()).every((value) => value.fingerprint),
    20_000, "initial game config metrics did not become available");

  watcher.stdin.write(`reload-config ${validCandidate}\n`);
  await waitFor(async () => (await readAllMetrics()).every((value) =>
    value.successes === 1 &&
    value.failures === 0 &&
    value.fingerprint === validManifest.dataFingerprint
  ), 30_000, "valid game config candidate was not committed by every Process");

  watcher.stdin.write(`reload-config ${invalidCandidate}\n`);
  await waitFor(async () => (await readAllMetrics()).every((value) =>
    value.successes === 1 &&
    value.failures === 1 &&
    value.fingerprint === validManifest.dataFingerprint
  ), 30_000, "invalid candidate did not preserve the active snapshot in every Process");

  watcher.stdin.end("shutdown\n");
  const { code, signal } = await waitForExit(45_000);
  if (code !== 0) throw new Error(`Watcher exited with code=${code} signal=${signal}\n${output}`);
  console.log(
    `game config runtime reload self-test passed: 5 Processes committed ${validManifest.dataFingerprint.slice(0, 12)} and rejected an invalid reference`,
  );
} catch (error) {
  throw new Error(`${error.message}\n[Watcher output]\n${output}`);
} finally {
  if (watcher.exitCode === null && watcher.signalCode === null) watcher.kill();
  await rm(temporary, { recursive: true, force: true });
}

/** 从当前生成数据构造一个哈希自洽的临时候选。 / Builds a hash-consistent temporary candidate from the current generated data. */
async function createCandidate(directory, mutate) {
  const generated = path.join(root, "game_config", "generated");
  const manifest = JSON.parse(await readFile(path.join(generated, "game-config.manifest.json"), "utf8"));
  const server = JSON.parse(await readFile(path.join(generated, manifest.serverFile), "utf8"));
  const client = JSON.parse(await readFile(path.join(generated, manifest.clientFile), "utf8"));
  mutate(server, client);
  const serverBytes = Buffer.from(`${JSON.stringify(server, null, 2)}\n`);
  const clientBytes = Buffer.from(`${JSON.stringify(client, null, 2)}\n`);
  manifest.serverHash = sha256(serverBytes);
  manifest.clientHash = sha256(clientBytes);
  manifest.dataFingerprint = sha256(Buffer.concat([serverBytes, Buffer.from([0]), clientBytes]));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, manifest.serverFile), serverBytes);
  await writeFile(path.join(directory, manifest.clientFile), clientBytes);
  await writeFile(
    path.join(directory, "game-config.manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

async function readAllMetrics() {
  return Promise.all(healthPorts.map(readMetrics));
}

async function readMetrics(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/metrics`);
    if (!response.ok) return {};
    const body = await response.text();
    return {
      successes: metric(body, "tiangz_game_config_reload_successes_total"),
      failures: metric(body, "tiangz_game_config_reload_failures_total"),
      fingerprint: metricLabel(body, "tiangz_game_config_info", "data_fingerprint"),
    };
  } catch {
    return {};
  }
}

function metric(text, name) {
  const match = text.match(new RegExp(`^${name}\\{[^}]*} ([0-9.]+)$`, "m"));
  return match ? Number(match[1]) : undefined;
}

function metricLabel(text, name, label) {
  const line = text.match(new RegExp(`^${name}\\{([^}]*)} [0-9.]+$`, "m"))?.[1];
  return line?.match(new RegExp(`${label}="([^"]*)"`))?.[1];
}

function waitForPort(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (watcher.exitCode !== null) return reject(new Error(`Watcher exited before port ${port} was ready`));
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(300);
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      const retry = () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error(`timed out waiting for port ${port}`));
        else setTimeout(attempt, 50);
      };
      socket.once("error", retry);
      socket.once("timeout", retry);
    };
    attempt();
  });
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    if (watcher.exitCode !== null) throw new Error(`Watcher exited while waiting: ${message}`);
    await sleep(100);
  }
  throw new Error(message);
}

function waitForExit(timeoutMs) {
  if (watcher.exitCode !== null) return Promise.resolve({ code: watcher.exitCode, signal: watcher.signalCode });
  return Promise.race([
    new Promise((resolve) => watcher.once("exit", (code, signal) => resolve({ code, signal }))),
    sleep(timeoutMs).then(() => ({ code: null, signal: "timeout" })),
  ]);
}

function appendOutput(chunk) {
  output += chunk;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
