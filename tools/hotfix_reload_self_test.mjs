import { spawn } from "node:child_process";
import { appendFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArgs(process.argv.slice(2));
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
const heapGrowthLimitBytes = 4 * 1024 * 1024;
const rssGrowthLimitBytes = 16 * 1024 * 1024;
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
  const warmupReloads = options.checkResources
    ? Math.min(10, Math.floor(options.reloads / 2))
    : 0;
  for (let index = 0; index < warmupReloads; index += 1) {
    const candidate = index % 2 === 0 ? candidates.inverted : candidates.normal;
    await reloadAll(candidate, index + 2, index + 1);
  }
  let baselineResources;
  if (options.checkResources) {
    await waitFor(async () => (await readResourceMetrics()).every((snapshot) => snapshot.sampled),
      15_000, "resource metrics did not become available before the soak");
    baselineResources = await readResourceMetrics();
  }
  for (let index = warmupReloads; index < options.reloads; index += 1) {
    const candidate = index % 2 === 0 ? candidates.inverted : candidates.normal;
    await reloadAll(candidate, index + 2, index + 1);
  }
  const finalGeneration = options.reloads + 1;
  const corrupted = path.join(temporary, "corrupted");
  await cp(candidates.normal, corrupted, { recursive: true });
  await appendFile(path.join(corrupted, "hotfix.js"), "\n// corrupted after manifest\n", "utf8");
  watcher.stdin.write(`reload ${corrupted}\n`);
  await waitFor(async () => {
    const snapshots = await Promise.all(healthPorts.map(readHotfixMetrics));
    return snapshots.every((snapshot) =>
      snapshot.generation === finalGeneration &&
      snapshot.successes === options.reloads &&
      snapshot.failures === 1
    );
  }, 30_000, `corrupted candidate did not preserve generation ${finalGeneration} in all Processes`);
  let resourceReport;
  if (options.checkResources) {
    await sleep(6_000);
    const finalResources = await readResourceMetrics();
    resourceReport = verifyResources(baselineResources, finalResources);
    await writeSoakReport(options.reloads, warmupReloads, resourceReport);
  }
  watcher.stdin.end("shutdown\n");
  const { code, signal } = await waitForExit(45_000);
  if (code !== 0) {
    throw new Error(`Watcher exited with code=${code} signal=${signal}\n${output}`);
  }
  console.log(
    `runtime Hotfix reload self-test passed: 5 Processes committed ${options.reloads} reloads through generation ${finalGeneration}, then rejected a corrupted candidate${resourceReport ? "; resource stability passed" : ""}`,
  );
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

async function readResourceMetrics() {
  return Promise.all(healthPorts.map(async (port) => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/metrics`);
      if (!response.ok) return { port, sampled: false };
      const body = await response.text();
      return {
        port,
        process: metricLabel(body, "tiangz_hotfix_active_generation", "process") ?? `port-${port}`,
        sampled: metric(body, "tiangz_process_metrics_timestamp_ms") > 0,
        rssBytes: metric(body, "tiangz_process_rss_bytes"),
        v8HeapUsedBytes: metric(body, "tiangz_process_v8_heap_used_bytes"),
        timers: metric(body, "tiangz_game_timers_total"),
        nativeEntities: metric(body, "tiangz_native_live_entities"),
        nativeUnits: metric(body, "tiangz_native_live_units"),
        pendingInnerCalls: metric(body, "tiangz_transport_inner_pending_calls"),
        asyncInFlight: metricSum(body, "tiangz_scene_async_in_flight"),
      };
    } catch {
      return { port, sampled: false };
    }
  }));
}

function verifyResources(baseline, final) {
  const rows = final.map((after, index) => {
    const before = baseline[index];
    if (!before?.sampled || !after.sampled) throw new Error(`missing resource sample for port ${after.port}`);
    if (after.timers !== before.timers) {
      throw new Error(`${after.process} timer count drifted: ${before.timers} -> ${after.timers}`);
    }
    if (after.nativeEntities !== before.nativeEntities || after.nativeUnits !== before.nativeUnits) {
      throw new Error(
        `${after.process} Native entity count drifted: entities ${before.nativeEntities}->${after.nativeEntities}, units ${before.nativeUnits}->${after.nativeUnits}`,
      );
    }
    if (after.pendingInnerCalls !== 0 || after.asyncInFlight !== 0) {
      throw new Error(
        `${after.process} did not drain: pendingInnerCalls=${after.pendingInnerCalls} asyncInFlight=${after.asyncInFlight}`,
      );
    }
    const heapGrowthBytes = after.v8HeapUsedBytes - before.v8HeapUsedBytes;
    const rssGrowthBytes = after.rssBytes - before.rssBytes;
    if (heapGrowthBytes > heapGrowthLimitBytes) {
      throw new Error(`${after.process} V8 heap grew beyond limit: ${heapGrowthBytes} > ${heapGrowthLimitBytes}`);
    }
    if (rssGrowthBytes > rssGrowthLimitBytes) {
      throw new Error(`${after.process} RSS grew beyond limit: ${rssGrowthBytes} > ${rssGrowthLimitBytes}`);
    }
    return {
      process: after.process,
      timers: after.timers,
      nativeEntities: after.nativeEntities,
      nativeUnits: after.nativeUnits,
      pendingInnerCalls: after.pendingInnerCalls,
      asyncInFlight: after.asyncInFlight,
      heapBeforeBytes: before.v8HeapUsedBytes,
      heapAfterBytes: after.v8HeapUsedBytes,
      heapGrowthBytes,
      rssBeforeBytes: before.rssBytes,
      rssAfterBytes: after.rssBytes,
      rssGrowthBytes,
    };
  });
  return {
    passed: true,
    heapGrowthLimitBytes,
    rssGrowthLimitBytes,
    processes: rows,
  };
}

async function writeSoakReport(reloads, warmupReloads, resources) {
  const directory = path.join(root, "perf", "results");
  await mkdir(directory, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    reloads,
    resourceBaselineGeneration: warmupReloads + 1,
    finalGeneration: reloads + 1,
    rejectedCorruptedCandidate: true,
    ...resources,
  };
  await writeFile(
    path.join(directory, "hotfix_soak_latest.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  const rows = resources.processes.map((item) =>
    `| ${item.process} | ${item.timers} | ${item.nativeEntities} | ${mb(item.heapGrowthBytes)} | ${mb(item.rssGrowthBytes)} | ${item.pendingInnerCalls}/${item.asyncInFlight} |`,
  );
  await writeFile(
    path.join(directory, "hotfix_soak_latest.md"),
    [
      `# ${reloads} 次 Hotfix generation 长稳报告`,
      "",
      `- 时间：${report.generatedAt}`,
      `- 最终 generation：${report.finalGeneration}`,
      `- 资源基线 generation：${report.resourceBaselineGeneration}（前 ${warmupReloads} 次用于预热）`,
      `- 增长门槛：V8 Heap < ${mb(resources.heapGrowthLimitBytes)} MB，RSS < ${mb(resources.rssGrowthLimitBytes)} MB`,
      "- 损坏候选：已拒绝，active generation 未变化",
      "",
      "| Process | Timer | Native Entity | V8 Heap增长 MB | RSS增长 MB | pending/async |",
      "|---|---:|---:|---:|---:|---:|",
      ...rows,
      "",
    ].join("\n"),
    "utf8",
  );
}

function metric(text, name) {
  const line = text.split(/\r?\n/).find((value) => value.startsWith(`${name}{`));
  return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : undefined;
}

function metricSum(text, name) {
  return text.split(/\r?\n/)
    .filter((value) => value.startsWith(`${name}{`))
    .reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(" ") + 1)), 0);
}

function metricLabel(text, name, label) {
  const line = text.split(/\r?\n/).find((value) => value.startsWith(`${name}{`));
  return line?.match(new RegExp(`${label}="([^"]+)"`))?.[1];
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

function parseArgs(values) {
  let reloads = 2;
  let checkResources = false;
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    if (name === "--check-resources") checkResources = true;
    else if (name === "--reloads") {
      reloads = Number(values[++index]);
      if (!Number.isSafeInteger(reloads) || reloads <= 0) {
        throw new Error(`invalid --reloads: ${values[index]}`);
      }
    } else {
      throw new Error(`unknown argument: ${name}`);
    }
  }
  return { reloads, checkResources };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(2);
}
