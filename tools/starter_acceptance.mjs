import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  runInherited,
  sleep,
  startRuntime,
  stopRuntime,
  waitForPort,
  waitForReady,
  writeFailureLogs,
} from "./lib/process_test_harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbProxyRoot = path.join(root, "tools-projects", "TiangZ-DBProxy");
const options = parseOptions(process.argv.slice(2));
const reportPath = path.join(
  root,
  "temp",
  "test-logs",
  `starter-acceptance-${new Date().toISOString().replaceAll(":", "-")}.json`,
);
const results = [];
let dbProxyProcess;
let dbProxyEnv;

try {
  if (!options.persistentOnly) {
    await runCommandCase("runtime", "tools/smoke_runtime.mjs", ["--mode", options.mode]);
    await runCommandCase("skills-and-buffs", "tools/smoke_runtime.mjs", ["--mode", "all", "--skill-only"]);
    await runCommandCase("character-selection", "tools/character_selection_smoke.mjs", []);
  }

  if (options.persistent || options.faults) {
    dbProxyEnv = loadDbProxyEnvironment();
    dbProxyProcess = await ensureDbProxy(dbProxyEnv);
    await runPersistentRestartCase(dbProxyEnv);
  }

  if (options.faults) {
    await runFaultMatrix();
  }

  writeReport("passed");
  console.log("[starter] acceptance passed");
  console.log(`[starter] report: ${path.relative(root, reportPath)}`);
} catch (error) {
  results.push({
    name: "starter-acceptance",
    status: "failed",
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
  writeReport("failed");
  console.error(`[starter] acceptance failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`[starter] report: ${path.relative(root, reportPath)}`);
  process.exitCode = 1;
} finally {
  await stopDbProxy(dbProxyProcess);
}

function parseOptions(args) {
  const options = {
    mode: "both",
    persistent: false,
    persistentOnly: false,
    faults: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--mode" && ["all", "split", "both"].includes(args[index + 1])) {
      options.mode = args[++index];
      continue;
    }
    if (value === "--persistent") {
      options.persistent = true;
      continue;
    }
    if (value === "--persistent-only") {
      options.persistent = true;
      options.persistentOnly = true;
      continue;
    }
    if (value === "--faults") {
      options.persistent = true;
      options.faults = true;
      continue;
    }
    throw new Error(
      "usage: node tools/starter_acceptance.mjs [--mode all|split|both] [--persistent|--persistent-only] [--faults]",
    );
  }
  return options;
}

async function runCommandCase(name, script, args) {
  const startedAt = Date.now();
  console.log(`[starter] ${name}`);
  try {
    await runInherited(process.execPath, [path.join(root, script), ...args], root);
    results.push({ name, status: "passed", durationMs: Date.now() - startedAt });
  } catch (error) {
    results.push({
      name,
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
    throw error;
  }
}

async function runPersistentRestartCase(environment) {
  const startedAt = Date.now();
  const account = `starter_persist_${Date.now().toString(36)}`;
  const runtimeConfigs = ["configs/local/all-in-one-dbproxy.json"];
  const runtimeEnv = {
    TIANGZ_DBPROXY_AUTH_TOKEN: environment.DBPROXY_AUTH_TOKEN,
  };
  let runtimes = [];
  let succeeded = false;
  try {
    console.log(`[starter] persistent restart account=${account}`);
    runtimes = runtimeConfigs.map((config) => startRuntime(
      root,
      config,
      `starter-persistent-${path.basename(config, ".json")}`,
      "debug",
      runtimeEnv,
    ));
    await waitForRuntimePorts(runtimes, true);
    await runClient("--dbproxy-persistence-write", account);
    await stopRuntimes(runtimes);
    runtimes = runtimeConfigs.map((config) => startRuntime(
      root,
      config,
      `starter-persistent-restart-${path.basename(config, ".json")}`,
      "debug",
      runtimeEnv,
    ));
    await waitForRuntimePorts(runtimes, true);
    await runClient("--dbproxy-persistence-read", account);
    succeeded = true;
    results.push({
      name: "persistent-restart",
      status: "passed",
      account,
      durationMs: Date.now() - startedAt,
    });
  } finally {
    await stopRuntimes(runtimes);
    if (!succeeded && runtimes.length > 0) {
      const directory = writeFailureLogs(root, "starter-persistent", runtimes);
      console.error(`[starter] persistent failure logs: ${directory}`);
    }
  }
}

async function runClient(...args) {
  await runInherited(process.execPath, [path.join(root, "dist", "smoke_client.cjs"), ...args], root, {
    env: { ...dbProxyEnv, TIANGZ_DBPROXY_AUTH_TOKEN: dbProxyEnv.DBPROXY_AUTH_TOKEN },
  });
}

async function waitForRuntimePorts(runtimes, health) {
  const ports = [7000, 7001, 7002, 7201, 7202, 7301, 7302, 7310, 7401];
  await Promise.all(ports.map((port) => waitForPort(port, runtimes[0])));
  if (health) await waitForReady(7600);
}

async function stopRuntimes(runtimes) {
  await Promise.all(runtimes.map((runtime) => stopRuntime(runtime)));
}

function loadDbProxyEnvironment() {
  const envPath = path.join(dbProxyRoot, "deploy", "local", ".env");
  if (!existsSync(envPath)) {
    throw new Error(`DBProxy local env is missing: ${envPath}`);
  }
  const values = {};
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || match[1].startsWith("#")) continue;
    values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  for (const key of ["DBPROXY_AUTH_TOKEN", "DBPROXY_POSTGRES_URL", "DBPROXY_REDIS_URL"]) {
    if (!values[key]) throw new Error(`DBProxy local env is missing ${key}`);
  }
  return values;
}

async function ensureDbProxy(environment) {
  if (await canConnect(7800)) {
    console.log("[starter] DBProxy already listening on 127.0.0.1:7800");
    return undefined;
  }
  for (const [port, name] of [[5432, "PostgreSQL"], [6379, "Redis"]]) {
    if (!(await canConnect(port))) {
      throw new Error(`${name} is not listening on 127.0.0.1:${port}; start the local DBProxy compose stack first`);
    }
  }
  const suffix = process.platform === "win32" ? ".exe" : "";
  const executable = path.join(dbProxyRoot, "target", "debug", `tiangz-dbproxy-server${suffix}`);
  if (!existsSync(executable)) {
    throw new Error(`DBProxy debug binary is missing: ${executable}; build it in tools-projects/TiangZ-DBProxy first`);
  }
  const child = spawn(executable, ["--config", "configs/local.json"], {
    cwd: dbProxyRoot,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => output += chunk);
  child.stderr.setEncoding("utf8").on("data", (chunk) => output += chunk);
  child.once("error", (error) => { output += `${error.stack ?? error.message}\n`; });
  try {
    await waitForStandalonePort(7800, 15_000);
    console.log("[starter] started DBProxy on 127.0.0.1:7800");
    return { child, output: () => output };
  } catch (error) {
    child.kill("SIGKILL");
    throw new Error(`DBProxy failed to start: ${error.message}\n${output}`);
  }
}

async function stopDbProxy(runtime) {
  if (!runtime || runtime.child.exitCode !== null) return;
  runtime.child.kill("SIGTERM");
  await waitForChild(runtime.child, 5_000).catch(() => runtime.child.kill("SIGKILL"));
}

async function runFaultMatrix() {
  const script = path.join(dbProxyRoot, "tools", "fault_matrix.ps1");
  if (!existsSync(script)) throw new Error(`DBProxy fault matrix is missing: ${script}`);
  await stopDbProxy(dbProxyProcess);
  dbProxyProcess = undefined;
  const startedAt = Date.now();
  await runInherited("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], dbProxyRoot);
  results.push({ name: "dbproxy-fault-matrix", status: "passed", durationMs: Date.now() - startedAt });
}

function canConnect(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(250);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

async function waitForStandalonePort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(port)) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for 127.0.0.1:${port}`);
}

function waitForChild(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child exit timed out")), timeoutMs);
    child.once("close", () => { clearTimeout(timer); resolve(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

function writeReport(status) {
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({
    status,
    generatedAt: new Date().toISOString(),
    mode: options.mode,
    persistent: options.persistent,
    faults: options.faults,
    results,
  }, null, 2), "utf8");
}
