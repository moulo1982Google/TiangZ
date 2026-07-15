import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../..");
const options = parseOptions(process.argv.slice(2));
const resultsDirectory = path.join(root, "perf", "results");
const serverPath = path.join(root, "target", "release", "network_backend_echo");
const clientPath = path.join(root, "target", "release", "runtime_load");
const runId = formatRunId(new Date());
let server;

if (process.platform !== "linux") {
  throw new Error("io_uring/epoll comparison must run on Linux");
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await stopChild(server);
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

try {
  mkdirSync(resultsDirectory, { recursive: true });
  if (!options.skipBuild) {
    await runInherited("cargo", [
      "build",
      "--release",
      "--features",
      "io-uring",
      "--bin",
      "network_backend_echo",
      "--bin",
      "runtime_load",
    ]);
  }

  const results = [];
  for (const backend of options.backends) {
    console.log(`\n[network-backend] starting ${backend}`);
    server = spawn(serverPath, [
      "--backend", backend,
      "--host", options.host,
      "--port", String(options.port),
      "--uring-entries", String(options.uringEntries),
      "--workers", String(options.workers),
    ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.pipe(process.stdout);
    server.stderr.pipe(process.stderr);
    await waitForPort(options.host, options.port, options.startupTimeoutMs, server);

    for (const payloadBytes of options.payloads) {
      console.log(`\n[network-backend] backend=${backend} payload=${payloadBytes}B`);
      const output = await runCaptured(clientPath, [
        "--host", options.host,
        "--port", String(options.port),
        "--duration", String(options.durationSeconds),
        "--warmup", String(options.warmupSeconds),
        "--connections", String(options.connections),
        "--concurrency", String(options.concurrency),
        "--payload", String(payloadBytes),
        "--delay", "0",
        "--drain", String(options.drainSeconds),
      ]);
      results.push(parseResult(backend, payloadBytes, output));
    }

    await stopChild(server);
    server = undefined;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      kernel: os.release(),
      architecture: os.arch(),
      cpu: os.cpus()[0]?.model ?? "unknown",
      logicalCpus: os.cpus().length,
    },
    options,
    results,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = buildMarkdown(report);
  writeFileSync(path.join(resultsDirectory, `network_backend_${runId}.json`), json);
  writeFileSync(path.join(resultsDirectory, `network_backend_${runId}.md`), markdown);
  writeFileSync(path.join(resultsDirectory, "network_backend_latest.json"), json);
  writeFileSync(path.join(resultsDirectory, "network_backend_latest.md"), markdown);
  console.log(`\n${markdown}`);
} finally {
  await stopChild(server);
}

function parseOptions(args) {
  const values = {
    backends: ["epoll", "io-uring"],
    host: "127.0.0.1",
    port: 7410,
    payloads: [64, 256, 1024, 4096, 16384],
    durationSeconds: 10,
    warmupSeconds: 2,
    connections: 8,
    concurrency: 512,
    drainSeconds: 10,
    uringEntries: 1024,
    workers: 4,
    startupTimeoutMs: 10_000,
    skipBuild: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--help" || name === "-h") {
      printHelp();
      process.exit(0);
    }
    if (name === "--skip-build") {
      values.skipBuild = true;
      continue;
    }
    const value = args[++index];
    if (value === undefined) throw new Error(`${name} requires a value`);
    switch (name) {
      case "--backends": values.backends = value.split(","); break;
      case "--host": values.host = value; break;
      case "--port": values.port = positiveInteger(name, value); break;
      case "--payloads": values.payloads = value.split(",").map((item) => nonNegativeInteger(name, item)); break;
      case "--duration": values.durationSeconds = positiveInteger(name, value); break;
      case "--warmup": values.warmupSeconds = nonNegativeInteger(name, value); break;
      case "--connections": values.connections = positiveInteger(name, value); break;
      case "--concurrency": values.concurrency = positiveInteger(name, value); break;
      case "--drain": values.drainSeconds = positiveInteger(name, value); break;
      case "--uring-entries": values.uringEntries = positiveInteger(name, value); break;
      case "--workers": values.workers = positiveInteger(name, value); break;
      case "--startup-timeout": values.startupTimeoutMs = positiveInteger(name, value); break;
      default: throw new Error(`unknown argument: ${name}`);
    }
  }
  if (values.backends.some((item) => !["epoll", "io-uring"].includes(item))) {
    throw new Error("--backends only accepts epoll,io-uring");
  }
  if (values.connections > values.concurrency) {
    throw new Error("--connections cannot exceed --concurrency");
  }
  if ((values.uringEntries & (values.uringEntries - 1)) !== 0) {
    throw new Error("--uring-entries must be a power of two");
  }
  return values;
}

function printHelp() {
  console.log(`Linux epoll/io_uring 网络基线

用法：npm run perf:network-backend -- [options]

  --backends epoll,io-uring
  --payloads 64,256,1024,4096,16384
  --duration 10
  --warmup 2
  --connections 8
  --concurrency 512
  --workers 4
  --uring-entries 1024
  --skip-build`);
}

function positiveInteger(name, value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`invalid ${name}: ${value}`);
  return number;
}

function nonNegativeInteger(name, value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`invalid ${name}: ${value}`);
  return number;
}

function runInherited(command, args) {
  console.log(`[network-backend] ${command} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolve()
      : reject(new Error(`${command} failed code=${code} signal=${signal ?? "none"}`)));
  });
}

function runCaptured(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve(stdout)
      : reject(new Error(`${command} failed: ${stderr.trim()}`)));
  });
}

function waitForPort(host, port, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (child.exitCode !== null) return reject(new Error(`server exited with ${child.exitCode}`));
      const socket = net.createConnection({ host, port });
      socket.setTimeout(300);
      socket.once("connect", () => { socket.destroy(); resolve(); });
      const retry = () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error(`timeout waiting for ${host}:${port}`));
        else setTimeout(attempt, 100);
      };
      socket.once("error", retry);
      socket.once("timeout", retry);
    };
    attempt();
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function parseResult(backend, payloadBytes, output) {
  const summary = output.match(/requests=(\d+) req\/s=([0-9.]+) errors=(\d+)/);
  const latency = output.match(/latency_ms p50=([0-9.]+) p95=([0-9.]+) p99=([0-9.]+) max=([0-9.]+)/);
  if (!summary || !latency) throw new Error(`cannot parse ${backend}/${payloadBytes} output`);
  return {
    backend,
    payloadBytes,
    requests: Number(summary[1]),
    requestsPerSecond: Number(summary[2]),
    errors: Number(summary[3]),
    p50Ms: Number(latency[1]),
    p95Ms: Number(latency[2]),
    p99Ms: Number(latency[3]),
    maxMs: Number(latency[4]),
  };
}

function buildMarkdown(report) {
  const lines = [
    "# Linux 网络 Backend 基线",
    "",
    `- 时间：${report.generatedAt}`,
    `- Kernel：${report.environment.kernel}`,
    `- CPU：${report.environment.cpu}（${report.environment.logicalCpus} 逻辑核）`,
    `- 连接/并发：${report.options.connections}/${report.options.concurrency}`,
    `- Backend workers：${report.options.workers}`,
    "",
    "| Backend | Payload | req/s | p50 ms | p95 ms | p99 ms | errors |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const item of report.results) {
    lines.push(`| ${item.backend} | ${item.payloadBytes} | ${item.requestsPerSecond.toLocaleString("en-US")} | ${item.p50Ms.toFixed(3)} | ${item.p95Ms.toFixed(3)} | ${item.p99Ms.toFixed(3)} | ${item.errors} |`);
  }
  lines.push("", "该结果只比较 Rust TCP Backend，不包含 V8、protobuf Handler 和 WebSocket 编解码。", "");
  return lines.join("\n");
}

function formatRunId(date) {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
}
