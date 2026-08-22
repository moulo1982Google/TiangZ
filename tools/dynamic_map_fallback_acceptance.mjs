import { execFile } from "node:child_process";
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
  writeFailureLogs,
} from "./lib/process_test_harness.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = startRuntime(
  root,
  "configs/local/dynamic-fallback/StartMachine.json",
  "dynamic-map-fallback",
  "debug",
);
let probe;

try {
  await Promise.all([7000, 7001, 7100, 7201, 7302, 7310, 7401].map(
    (port) => waitForPort(port, runtime, 30_000),
  ));
  await sleep(5_500);
  probe = startProbe();
  const ready = await waitForMarker(probe, "DYNAMIC_FALLBACK_READY", 30_000);

  const managerPid = await findDirectChildByConfig(runtime.child.pid, "manager.json");
  const dungeonPid = await findDirectChildByConfig(runtime.child.pid, "dungeon.json");
  process.kill(managerPid, "SIGKILL");
  process.kill(dungeonPid, "SIGKILL");
  await Promise.all([waitForPortClosed(7100, 3_000), waitForPortClosed(7310, 3_000)]);

  const restartedManagerPid = await waitForDirectChildReplacement(
    runtime.child.pid,
    "manager.json",
    managerPid,
    15_000,
  );
  await waitForPort(7100, runtime, 15_000);
  await sleep(21_000);
  probe.child.stdin.write("continue\n");

  const passed = await waitForMarker(probe, "DYNAMIC_FALLBACK_PASSED", 30_000);
  const exit = await waitForExit(probe, 10_000);
  if (exit !== 0) throw new Error(`dynamic fallback probe exited ${exit}:\n${probe.output()}`);

  const restartedDungeonPid = await waitForDirectChildReplacement(
    runtime.child.pid,
    "dungeon.json",
    dungeonPid,
    35_000,
  );
  await waitForPort(7310, runtime, 15_000);
  console.log("[dynamic-map-fallback] passed", {
    previousMapInstanceId: ready.mapInstanceId,
    safeMapInstanceId: passed.safeMapInstanceId,
    managerPid,
    restartedManagerPid,
    dungeonPid,
    restartedDungeonPid,
  });
} catch (error) {
  const logs = writeFailureLogs(root, "dynamic-map-fallback", [runtime]);
  console.error(`[dynamic-map-fallback] failure logs: ${logs}`);
  throw error;
} finally {
  if (probe && probe.child.exitCode === null) probe.child.kill();
  await stopRuntime(runtime).catch(() => undefined);
}

function startProbe() {
  const child = execFile(
    process.execPath,
    [path.join(root, "dist", "dynamic_map_fallback_probe.cjs")],
    { cwd: root, windowsHide: true, maxBuffer: 1024 * 1024 },
  );
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

function waitForMarker(target, marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const inspect = () => {
      const line = target.output().split(/\r?\n/).find((entry) => entry.startsWith(`${marker} `));
      if (line) return resolve(JSON.parse(line.slice(marker.length + 1)));
      if (target.child.exitCode !== null) {
        return reject(new Error(`probe exited before ${marker}:\n${target.output()}`));
      }
      if (Date.now() >= deadline) {
        return reject(new Error(`timed out waiting for ${marker}:\n${target.output()}`));
      }
      setTimeout(inspect, 25);
    };
    inspect();
  });
}

async function findDirectChildByConfig(parentPid, configName) {
  const rows = await directChildren(parentPid);
  const matches = rows.filter((row) => row.commandLine.toLowerCase().includes(configName.toLowerCase()));
  if (matches.length !== 1) throw new Error(`expected one ${configName} child: ${JSON.stringify(rows)}`);
  return matches[0].pid;
}

async function waitForDirectChildReplacement(parentPid, configName, previousPid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const replacement = (await directChildren(parentPid)).find((row) =>
      row.pid !== previousPid && row.commandLine.toLowerCase().includes(configName.toLowerCase())
    );
    if (replacement) return replacement.pid;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${configName} restart`);
    await sleep(100);
  }
}

async function directChildren(parentPid) {
  if (process.platform !== "win32") {
    const { stdout } = await execFileAsync("ps", ["-o", "pid=,args=", "--ppid", String(parentPid)]);
    return stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      return { pid: Number(match?.[1]), commandLine: match?.[2] ?? "" };
    });
  }
  const command = `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${parentPid} -and $_.Name -eq 'TiangZ.exe' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-Command", command],
    { windowsHide: true },
  );
  const parsed = JSON.parse(stdout.trim() || "[]");
  return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
    pid: Number(row.ProcessId),
    commandLine: String(row.CommandLine ?? ""),
  }));
}

function waitForPortClosed(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const inspect = () => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error(`port ${port} did not close`));
        else setTimeout(inspect, 50);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve();
      });
    };
    inspect();
  });
}

function waitForExit(target, timeoutMs) {
  if (target.child.exitCode !== null) return Promise.resolve(target.child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`probe did not exit:\n${target.output()}`)), timeoutMs);
    target.child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}
