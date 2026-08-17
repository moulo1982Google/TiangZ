import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  sleep,
  startRuntime,
  stopRuntime,
  waitForPort,
  waitForReady,
  writeFailureLogs,
} from "./lib/process_test_harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbProxyRoot = path.join(root, "tools-projects", "TiangZ-DBProxy");
const reportPath = path.join(root, "temp", "test-logs", "player-trade-persistence-report.json");
const runtimeEnv = {};
const managed = [];
let runtime;
let primary;

try {
  await requirePortFree(7_000, "TiangZ LoginMgr");
  await requirePortFree(7_800, "DBProxy primary");
  await requirePortFree(7_801, "DBProxy secondary");
  const environment = loadDbProxyEnvironment();
  runtimeEnv.TIANGZ_DBPROXY_AUTH_TOKEN = environment.DBPROXY_AUTH_TOKEN;

  primary = startDbProxy("dbproxy-primary", "configs/local-1.json", environment);
  const secondary = startDbProxy("dbproxy-secondary", "configs/local-2.json", environment);
  managed.push(primary, secondary);
  await Promise.all([waitForManagedPort(7_800, primary), waitForManagedPort(7_801, secondary)]);

  runtime = await startTiangZ("player-trade-persistent");
  const first = accounts("normal");
  await runProbe("commit", first);
  await restartTiangZ("player-trade-persistent-restart");
  await runProbe("verify", first);

  const failover = accounts("failover");
  await runProbe("commit", failover, async () => {
    await stopManaged(primary);
    await waitForPortClosed(7_800);
    console.log("[player-trade] primary DBProxy stopped; continuing final confirmation through 127.0.0.1:7801");
  });
  await restartTiangZ("player-trade-failover-restart");
  await runProbe("verify", failover);

  writeReport("passed", { first, failover });
  console.log("[player-trade] persistent and DBProxy failover acceptance passed");
  console.log(`[player-trade] report: ${path.relative(root, reportPath)}`);
} catch (error) {
  writeReport("failed", { error: error instanceof Error ? error.stack ?? error.message : String(error) });
  if (runtime) {
    const directory = writeFailureLogs(root, "player-trade-persistence", [runtime]);
    console.error(`[player-trade] runtime failure logs: ${directory}`);
  }
  console.error(`[player-trade] acceptance failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await stopRuntime(runtime).catch(() => undefined);
  await Promise.all(managed.map((process) => stopManaged(process).catch(() => undefined)));
}

function accounts(label) {
  const suffix = `${Date.now().toString(36)}_${Math.floor(Math.random() * 0xffff).toString(36)}`;
  return {
    accountA: `tp_${label}_a_${suffix}`,
    accountB: `tp_${label}_b_${suffix}`,
  };
}

async function startTiangZ(name) {
  const started = startRuntime(
    root,
    "configs/local/all-in-one-dbproxy.json",
    name,
    "debug",
    runtimeEnv,
  );
  await Promise.all([
    waitForPort(7_000, started, 20_000),
    waitForPort(7_201, started, 20_000),
    waitForPort(7_301, started, 20_000),
    waitForReady(7_600, 20_000),
  ]);
  return started;
}

async function restartTiangZ(name) {
  await stopRuntime(runtime);
  runtime = await startTiangZ(name);
}

function startDbProxy(name, config, environment) {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const executable = path.join(dbProxyRoot, "target", "debug", `tiangz-dbproxy-server${suffix}`);
  if (!existsSync(executable)) {
    throw new Error(`DBProxy debug binary is missing: ${executable}`);
  }
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

function waitForManagedPort(port, managedProcess, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (managedProcess.child.exitCode !== null) {
        reject(new Error(`${managedProcess.name} exited before port ${port} was ready:\n${managedProcess.output()}`));
        return;
      }
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error(`timed out waiting for DBProxy port ${port}`));
        else setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

async function runProbe(mode, selectedAccounts, beforeCommit) {
  console.log(`[player-trade] probe mode=${mode} accounts=${selectedAccounts.accountA},${selectedAccounts.accountB}`);
  const child = spawn(
    process.execPath,
    [path.join(root, "dist", "player_trade_persistence_probe.cjs"), mode],
    {
      cwd: root,
      env: {
        ...process.env,
        TIANGZ_TRADE_ACCOUNT_A: selectedAccounts.accountA,
        TIANGZ_TRADE_ACCOUNT_B: selectedAccounts.accountB,
        TIANGZ_TRADE_PAUSE_BEFORE_COMMIT: beforeCommit ? "1" : "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let output = "";
  let readyHandled = !beforeCommit;
  let readyError;
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
    if (!readyHandled && output.includes("PLAYER_TRADE_READY_FOR_COMMIT")) {
      readyHandled = true;
      void beforeCommit().then(
        () => child.stdin.end("continue\n"),
        (error) => {
          readyError = error;
          child.kill("SIGKILL");
        },
      );
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
    process.stderr.write(chunk);
  });
  const { code, signal } = await waitForChild(child, 60_000);
  if (readyError) throw readyError;
  if (beforeCommit && !readyHandled) throw new Error(`trade probe never reached the commit barrier:\n${output}`);
  if (code !== 0) throw new Error(`trade probe failed code=${code} signal=${signal ?? "none"}:\n${output}`);
}

function waitForChild(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`process ${child.pid} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function stopManaged(managedProcess) {
  if (!managedProcess || managedProcess.child.exitCode !== null || managedProcess.child.signalCode !== null) return;
  managedProcess.child.kill();
  await waitForChild(managedProcess.child, 10_000).catch(() => undefined);
}

async function requirePortFree(port, name) {
  if (await canConnect(port)) throw new Error(`${name} port 127.0.0.1:${port} is already in use`);
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(200);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    const unavailable = () => { socket.destroy(); resolve(false); };
    socket.once("error", unavailable);
    socket.once("timeout", unavailable);
  });
}

async function waitForPortClosed(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await canConnect(port))) return;
    await sleep(50);
  }
  throw new Error(`port 127.0.0.1:${port} did not close`);
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
  writeFileSync(reportPath, JSON.stringify({
    status,
    generatedAt: new Date().toISOString(),
    ...detail,
  }, null, 2), "utf8");
}
