import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const options = parseOptions(process.argv.slice(2));
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const runId = timestamp();
const resultDir = path.join(root, "perf", "results");
const resultPath = path.join(resultDir, `hotpath_prepare_${runId}.json`);
mkdirSync(resultDir, { recursive: true });

const configFiles = [
  "configs/local/all-in-one.json",
  "configs/local/cluster/manager.json",
  "configs/local/cluster/login-1.json",
  "configs/local/cluster/login-2.json",
  "configs/local/cluster/gate-1.json",
  "configs/local/cluster/map-1.json",
];

if (!options.skipBuild) {
  await runNpm("run", "build:bench");
  await runNpm("run", "build:perf:full-chain");
  await run("cargo", ["build", "--release", "--locked", "--bin", "TiangZ"]);
}

await runNpm("run", "verify:codegen");
await runNpm("run", "verify:comments");
await runNpm("run", "verify:hotfix-boundary");

const artifacts = inspectArtifacts();
const ports = inspectPorts(configFiles);
const portChecks = await Promise.all(ports.map(async (port) => ({
  ...port,
  occupied: await canConnect(port.host, port.port),
})));
const occupied = portChecks.filter((item) => item.occupied);
const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  projectVersion: packageJson.version,
  machine: machineInfo(),
  node: process.version,
  options,
  artifacts,
  ports: portChecks,
  observation: {
    server: [
      "CPU、RSS、V8 Heap、V8 GC 次数/耗时通过 Runtime /metrics 采集",
      "Rust transport queue、Mailbox fast/queued/async 和 one-way queued 指标通过 /metrics 采集",
    ],
    loadGenerator: [
      "Node process.resourceUsage/process.memoryUsage/v8.getHeapStatistics",
      "PerformanceObserver gc 事件统计压测客户端 GC 次数和耗时",
    ],
    limitation: "本入口不测精确每消息分配字节；该指标需要单独的 V8 heap/profile 实验。",
  },
  commands: {
    current: "npm run perf:full-chain -- --mode all --players 200,1000,3000 --move-rates 2 --warmup 10 --duration 60 --rounds 3 --output-prefix hotpath_current",
    currentSplit: "npm run perf:full-chain -- --mode split --players 200,1000,3000 --move-rates 2 --warmup 10 --duration 60 --rounds 3 --output-prefix hotpath_current_split",
    business: "npm run perf:business-chain -- --mode all --players 200,1000,3000 --move-rates 2 --business-rate 0.1 --warmup 10 --duration 60 --rounds 3 --output-prefix hotpath_business",
    compare: "node perf/hotpath/compare_hotpath_results.mjs --before perf/results/hotpath_before.json --after perf/results/hotpath_after.json",
  },
};
writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

console.log(`[hotpath-prepare] result: ${path.relative(root, resultPath)}`);
console.log(`[hotpath-prepare] runtime artifacts: ${artifacts.ok ? "ready" : "missing"}`);
console.log(`[hotpath-prepare] free test ports: ${occupied.length === 0 ? "yes" : "no"}`);
for (const item of occupied) {
  console.error(`[hotpath-prepare] occupied port ${item.host}:${item.port} (${item.source})`);
}
if (!artifacts.ok || (occupied.length > 0 && !options.allowBusyPorts)) {
  process.exitCode = 1;
}

function inspectArtifacts() {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const required = [
    "dist/model.js",
    "dist/hotfix.js",
    "dist/model.manifest.json",
    "dist/hotfix.manifest.json",
    `target/release/TiangZ${suffix}`,
    "dist/full_chain_load_test.cjs",
  ];
  const files = required.map((relative) => {
    const file = path.join(root, relative);
    try {
      const stat = statSync(file);
      return {
        path: relative,
        exists: true,
        bytes: stat.size,
        sha256: sha256(file),
      };
    } catch {
      return { path: relative, exists: false, bytes: 0, sha256: "" };
    }
  });
  return {
    ok: files.every((item) => item.exists),
    files,
    modelManifest: readOptionalJson("dist/model.manifest.json"),
    hotfixManifest: readOptionalJson("dist/hotfix.manifest.json"),
  };
}

function inspectPorts(files) {
  const results = [];
  const seen = new Set();
  for (const relative of files) {
    const config = JSON.parse(readFileSync(path.join(root, relative), "utf8"));
    const health = config.process?.observability?.health;
    if (health?.port) add("health", health.ip ?? "127.0.0.1", health.port, relative);
    for (const scene of config.scenes ?? []) {
      if (scene.port) add(`scene:${scene.name}`, scene.ip ?? "127.0.0.1", scene.port, relative);
    }
  }
  return results;

  function add(kind, host, port, source) {
    const key = `${host}:${port}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ kind, host, port, source });
  }
}

function readOptionalJson(relative) {
  try { return JSON.parse(readFileSync(path.join(root, relative), "utf8")); } catch { return undefined; }
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function machineInfo() {
  return {
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model ?? "unknown",
    logicalCpus: os.cpus().length,
    memoryBytes: os.totalmem(),
  };
}

function runNpm(...args) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return run(npm, args);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    console.log(`[hotpath-prepare] ${command} ${args.join(" ")}`);
    const isWindowsBatch = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
    const executable = isWindowsBatch ? (process.env.ComSpec ?? "cmd.exe") : command;
    const childArgs = isWindowsBatch
      ? ["/d", "/s", "/c", [command, ...args].map(quoteCmdArg).join(" ")]
      : args;
    const child = spawn(executable, childArgs, {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed with code=${code} signal=${signal ?? "none"}`));
    });
  });
}

function quoteCmdArg(value) {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(250);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function parseOptions(args) {
  const flags = new Set(args);
  const unknown = args.filter((item) => !["--skip-build", "--allow-busy-ports"].includes(item));
  if (unknown.length > 0) throw new Error(`unknown option: ${unknown[0]}`);
  return {
    skipBuild: flags.has("--skip-build"),
    allowBusyPorts: flags.has("--allow-busy-ports"),
  };
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
