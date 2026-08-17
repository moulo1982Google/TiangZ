import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  sleep,
  startRuntime,
  stopRuntime,
  waitForPort,
  waitForReady,
  writeFailureLogs,
} from "./lib/process_test_harness.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbProxyRoot = path.join(root, "tools-projects", "TiangZ-DBProxy");
const reportPath = path.join(root, "temp", "test-logs", "player-domain-recovery-report.json");
const stateDirectory = path.join(root, "temp", "test-logs", "player-domain-recovery-state");
const runtimeEnv = {};
const managed = [];
const observedRuntimes = [];
let runtime;
let heldProbe;

try {
  await requirePortsFree([7_000, 7_800, 7_801]);
  const environment = loadDbProxyEnvironment();
  runtimeEnv.TIANGZ_DBPROXY_AUTH_TOKEN = environment.DBPROXY_AUTH_TOKEN;
  const primary = startDbProxy("dbproxy-primary", "configs/local-1.json", environment);
  const secondary = startDbProxy("dbproxy-secondary", "configs/local-2.json", environment);
  managed.push(primary, secondary);
  await Promise.all([waitForManagedPort(7_800, primary), waitForManagedPort(7_801, secondary)]);

  mkdirSync(stateDirectory, { recursive: true });
  const graceful = scenario("graceful-flush");
  runtime = await startAllInOne("domain-recovery-graceful");
  heldProbe = await startHeldMutation(graceful);
  await stopRuntime(runtime, 30_000);
  await releaseHeldProbe(heldProbe);
  runtime = await startAllInOne("domain-recovery-graceful-restart");
  await runProbe("verify", graceful);
  console.log("[player-recovery] graceful offline flush passed");

  const crashed = scenario("periodic-crash");
  heldProbe = await startHeldMutation(crashed);
  await sleep(35_000);
  await hardKill(runtime);
  await releaseHeldProbe(heldProbe);
  runtime = await startAllInOne("domain-recovery-crash-restart");
  await runProbe("verify", crashed);
  console.log("[player-recovery] all-in-one periodic snapshot hard-kill recovery passed");
  await stopRuntime(runtime);
  runtime = undefined;

  const mapHost = scenario("maphost-crash");
  runtime = await startSplit("domain-recovery-split");
  heldProbe = await startHeldMutation(mapHost);
  await sleep(35_000);
  const mapHostPid = await findDirectChildByConfig(runtime.child.pid, "map-2.json");
  process.kill(mapHostPid, "SIGKILL");
  const watcherExit = await waitForChild(runtime.child, 90_000, runtime.output);
  if (watcherExit.code === 0) throw new Error(`Watcher succeeded after map-2 ${mapHostPid} was killed`);
  if (!runtime.output().includes("exited unexpectedly")) {
    throw new Error(`Watcher did not report the MapHost failure:\n${runtime.output()}`);
  }
  await releaseHeldProbe(heldProbe);
  runtime = await startSplit("domain-recovery-split-restart");
  await runProbe("verify", mapHost);
  console.log("[player-recovery] MapHost hard-kill and deployment restart recovery passed");

  writeReport("passed", { graceful, crashed, mapHost });
  console.log("[player-recovery] all domain recovery acceptance stages passed");
  console.log(`[player-recovery] report: ${path.relative(root, reportPath)}`);
} catch (error) {
  writeReport("failed", { error: error instanceof Error ? error.stack ?? error.message : String(error) });
  const logs = observedRuntimes.length > 0
    ? writeFailureLogs(root, "player-domain-recovery", observedRuntimes)
    : undefined;
  if (logs) console.error(`[player-recovery] runtime failure logs: ${logs}`);
  console.error(`[player-recovery] acceptance failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await releaseHeldProbe(heldProbe).catch(() => undefined);
  await stopRuntime(runtime).catch(() => undefined);
  await Promise.all(managed.map((entry) => stopManaged(entry).catch(() => undefined)));
}

function scenario(label) {
  const suffix = `${Date.now().toString(36)}_${Math.floor(Math.random() * 0xffff).toString(36)}`;
  const accountPrefix = {
    "graceful-flush": "rec_flush",
    "periodic-crash": "rec_crash",
    "maphost-crash": "rec_map",
  }[label] ?? "rec";
  return {
    label,
    account: `${accountPrefix}_${suffix}`,
    stateFile: path.join(stateDirectory, `${label}-${suffix}.json`),
  };
}

async function startAllInOne(name) {
  const started = startRuntime(root, "configs/local/all-in-one-dbproxy.json", name, "debug", runtimeEnv);
  observedRuntimes.push(started);
  await Promise.all([
    waitForPort(7_000, started, 20_000),
    waitForPort(7_201, started, 20_000),
    waitForPort(7_301, started, 20_000),
    waitForReady(7_600, 20_000),
  ]);
  return started;
}

async function startSplit(name) {
  const started = startRuntime(root, "configs/local/cluster-dbproxy/StartMachine.json", name, "debug", runtimeEnv);
  observedRuntimes.push(started);
  await Promise.all([
    waitForPort(7_000, started, 30_000),
    waitForPort(7_001, started, 30_000),
    waitForPort(7_201, started, 30_000),
    waitForPort(7_302, started, 30_000),
    waitForPort(7_401, started, 30_000),
  ]);
  // 端口就绪只表示进程已监听；MapHost还需要向MapManager发布静态地图目录。
  // Listening ports precede MapHost static-map registration with MapManager.
  await sleep(2_000);
  return started;
}

async function startHeldMutation(selected) {
  const probe = spawnProbe("mutate", selected);
  await waitForOutput(probe, "PLAYER_DOMAIN_RECOVERY_MUTATED", 30_000);
  return probe;
}

async function runProbe(mode, selected) {
  console.log(`[player-recovery] probe mode=${mode} account=${selected.account}`);
  const probe = spawnProbe(mode, selected);
  const exit = await waitForChild(probe.child, 30_000, probe.output);
  if (exit.code !== 0) {
    throw new Error(`recovery probe failed code=${exit.code} signal=${exit.signal ?? "none"}:\n${probe.output()}`);
  }
}

function spawnProbe(mode, selected) {
  const child = spawn(process.execPath, [path.join(root, "dist", "player_domain_recovery_probe.cjs"), mode], {
    cwd: root,
    env: {
      ...process.env,
      TIANGZ_RECOVERY_ACCOUNT: selected.account,
      TIANGZ_RECOVERY_STATE_FILE: selected.stateFile,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
    process.stderr.write(chunk);
  });
  return { child, output: () => output };
}

async function releaseHeldProbe(probe) {
  if (!probe || probe.child.exitCode !== null || probe.child.signalCode !== null) return;
  probe.child.stdin.end("continue\n");
  const exit = await waitForChild(probe.child, 15_000, probe.output);
  if (exit.code !== 0) throw new Error(`held recovery probe exited code=${exit.code}:\n${probe.output()}`);
  if (heldProbe === probe) heldProbe = undefined;
}

function waitForOutput(probe, marker, timeoutMs) {
  if (probe.output().includes(marker)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${marker}:\n${probe.output()}`)), timeoutMs);
    const inspect = () => {
      if (probe.output().includes(marker)) {
        clearTimeout(timer);
        resolve();
      } else if (probe.child.exitCode !== null || probe.child.signalCode !== null) {
        clearTimeout(timer);
        reject(new Error(`probe exited before ${marker}:\n${probe.output()}`));
      } else {
        setTimeout(inspect, 25);
      }
    };
    inspect();
  });
}

/** 精确寻找Watcher直接子进程中的map-2，避免故障注入误杀其他服务。 / Finds the exact map-2 direct child so fault injection cannot kill an unrelated service. */
async function findDirectChildByConfig(parentPid, configName) {
  const rows = process.platform === "win32"
    ? await windowsDirectChildren(parentPid)
    : await unixDirectChildren(parentPid);
  const matched = rows.filter((row) => row.commandLine.toLowerCase().includes(configName.toLowerCase()));
  if (matched.length !== 1) {
    throw new Error(`expected one Watcher child for ${configName}, found ${matched.length}: ${JSON.stringify(rows)}`);
  }
  return matched[0].pid;
}

async function windowsDirectChildren(parentPid) {
  const command = `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${parentPid} -and $_.Name -eq 'TiangZ.exe' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], { windowsHide: true });
  const parsed = JSON.parse(stdout.trim() || "[]");
  return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
    pid: Number(row.ProcessId),
    commandLine: String(row.CommandLine ?? ""),
  }));
}

async function unixDirectChildren(parentPid) {
  const { stdout } = await execFileAsync("ps", ["-o", "pid=,args=", "--ppid", String(parentPid)]);
  return stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return { pid: Number(match?.[1] ?? 0), commandLine: match?.[2] ?? "" };
  }).filter((row) => row.pid > 0);
}

async function hardKill(target) {
  if (!target || target.child.exitCode !== null || target.child.signalCode !== null) return;
  target.child.kill("SIGKILL");
  await waitForChild(target.child, 15_000, target.output);
}

function startDbProxy(name, config, environment) {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const executable = path.join(dbProxyRoot, "target", "debug", `tiangz-dbproxy-server${suffix}`);
  if (!existsSync(executable)) throw new Error(`DBProxy debug binary is missing: ${executable}`);
  const child = spawn(executable, ["--config", config], {
    cwd: dbProxyRoot,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => output += chunk);
  child.stderr.setEncoding("utf8").on("data", (chunk) => output += chunk);
  return { child, name, output: () => output };
}

function waitForManagedPort(port, entry, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (entry.child.exitCode !== null) return reject(new Error(`${entry.name} exited before port ${port} was ready:\n${entry.output()}`));
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error(`timed out waiting for DBProxy port ${port}`));
        else setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

async function stopManaged(entry) {
  if (!entry || entry.child.exitCode !== null || entry.child.signalCode !== null) return;
  entry.child.kill();
  await waitForChild(entry.child, 10_000, entry.output).catch(() => undefined);
}

function waitForChild(child, timeoutMs, output = () => "") {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process ${child.pid} timed out after ${timeoutMs}ms:\n${output()}`)), timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

async function requirePortsFree(ports) {
  for (const port of ports) if (await canConnect(port)) throw new Error(`127.0.0.1:${port} is already in use`);
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(200, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function loadDbProxyEnvironment() {
  const file = path.join(dbProxyRoot, "deploy", "local", ".env");
  if (!existsSync(file)) throw new Error(`DBProxy local environment is missing: ${file}`);
  const values = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && !match[1].startsWith("#")) values[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  for (const key of ["DBPROXY_AUTH_TOKEN", "DBPROXY_POSTGRES_URL", "DBPROXY_REDIS_URL"]) {
    if (!values[key]) throw new Error(`DBProxy local environment is missing ${key}`);
  }
  return values;
}

function writeReport(status, detail) {
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({ status, generatedAt: new Date().toISOString(), ...detail }, null, 2), "utf8");
}
