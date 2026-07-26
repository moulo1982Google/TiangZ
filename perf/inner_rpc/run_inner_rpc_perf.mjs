import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const options = parseOptions(process.argv.slice(2));
const runId = timestamp();
const resultDir = path.join(root, "perf", "results");
const logDir = path.join(resultDir, "logs", `inner_rpc_${runId}`);
mkdirSync(logDir, { recursive: true });

const suffix = process.platform === "win32" ? ".exe" : "";
const runtime = path.join(root, "target", "release", `TiangZ${suffix}`);
const load = path.join(root, "target", "release", `inner_rpc_load${suffix}`);

const deployments = options.mode === "both" ? ["local", "remote"] : [options.mode];
const results = [];

for (const deployment of deployments) {
  results.push(await runDeployment(deployment));
}

const report = {
  generatedAt: new Date().toISOString(),
  runId,
  machine: {
    cpu: os.cpus()[0]?.model ?? "unknown",
    logicalCpus: os.cpus().length,
    memoryBytes: os.totalmem(),
  },
  parameters: options,
  results,
};
const jsonPath = path.join(resultDir, `inner_rpc_${runId}.json`);
const markdownPath = path.join(resultDir, `inner_rpc_${runId}.md`);
const markdown = renderMarkdown(report);
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(markdownPath, markdown, "utf8");
writeFileSync(path.join(resultDir, "inner_rpc_latest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(path.join(resultDir, "inner_rpc_latest.md"), markdown, "utf8");
console.log(`[inner-rpc] report: ${markdownPath}`);
console.log(markdown);

async function runDeployment(deployment) {
  const children = [];
  try {
    if (deployment === "local") {
      children.push(startRuntime("local", "configs/tests/mailbox_parity_all.json"));
      await waitPort("127.0.0.1", 7410, 30_000);
    } else {
      children.push(startRuntime("bench", "configs/tests/mailbox_parity_bench.json"));
      children.push(startRuntime("caller", "configs/tests/mailbox_parity_caller.json"));
      await waitPort("127.0.0.1", 7400, 30_000);
      await waitPort("127.0.0.1", 7410, 30_000);
    }
    const output = await runCaptured(load, [
      "--host", "127.0.0.1",
      "--port", "7410",
      "--duration", String(options.duration),
      "--warmup", String(options.warmup),
      "--connections", String(options.connections),
      "--concurrency", String(options.concurrency),
      "--call-count", String(options.callCount),
      "--delay", String(options.delay),
      "--drain", String(options.drain),
    ]);
    return parseOutput(deployment, output);
  } finally {
    await Promise.all(children.map(stopChild));
  }
}

function startRuntime(name, config) {
  const stdoutPath = path.join(logDir, `${name}_stdout.log`);
  const stderrPath = path.join(logDir, `${name}_stderr.log`);
  const child = spawn(runtime, [path.join(root, config)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.pipe(createWriteStream(stdoutPath));
  child.stderr.pipe(createWriteStream(stderrPath));
  return { child, stdoutPath, stderrPath, name };
}

function runCaptured(command, args) {
  console.log(`[inner-rpc] ${path.basename(command)} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      output += text;
      process.stderr.write(text);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} failed with code=${code} signal=${signal ?? "none"}`));
    });
  });
}

function parseOutput(deployment, output) {
  const summary = output.match(/requests=(\d+) req\/s=([0-9.]+) errors=(\d+) peak_in_flight=(\d+) max_server_concurrency=(\d+)/);
  const latency = output.match(/latency_ms p50=([0-9.]+) p95=([0-9.]+) p99=([0-9.]+) max=([0-9.]+)/);
  if (!summary || !latency) throw new Error(`cannot parse inner_rpc_load output:\n${output}`);
  return {
    deployment,
    requests: Number(summary[1]),
    requestsPerSecond: Number(summary[2]),
    errors: Number(summary[3]),
    peakInFlight: Number(summary[4]),
    maxServerConcurrency: Number(summary[5]),
    p50Ms: Number(latency[1]),
    p95Ms: Number(latency[2]),
    p99Ms: Number(latency[3]),
    maxMs: Number(latency[4]),
  };
}

function renderMarkdown(report) {
  const lines = [
    "# 内部 Scene RPC 基线报告",
    "",
    `- 时间：${report.generatedAt}`,
    `- CPU：${report.machine.cpu}，逻辑核 ${report.machine.logicalCpus}`,
    `- 参数：${options.connections} 连接，${options.concurrency} 并发，预热 ${options.warmup}s，采样 ${options.duration}s，callCount=${options.callCount}，delay=${options.delay}ms`,
    "",
    "| 部署 | req/s | p50 ms | p95 ms | p99 ms | max ms | max server concurrency | errors |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const result of report.results) {
    lines.push(`| ${result.deployment} | ${Math.round(result.requestsPerSecond)} | ${result.p50Ms} | ${result.p95Ms} | ${result.p99Ms} | ${result.maxMs} | ${result.maxServerConcurrency} | ${result.errors} |`);
  }
  lines.push(
    "",
    "链路：Rust TCP 客户端 -> MailboxParityScene -> SceneCallContext -> BenchScene.BenchInner.RuntimePing -> MailboxParityScene -> TCP Response。",
    "`local` 表示两个 Scene 在同一进程同一 V8；`remote` 表示两个 Scene 拆成两个进程，经内部 TCP transport。",
    "",
  );
  return lines.join("\n");
}

function waitPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host, port });
      socket.setTimeout(300);
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      const retry = () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error(`timed out waiting for ${host}:${port}`));
        else setTimeout(attempt, 100);
      };
      socket.once("error", retry);
      socket.once("timeout", retry);
    };
    attempt();
  });
}

async function stopChild(item) {
  if (!item || item.child.exitCode !== null) return;
  item.child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => item.child.once("exit", resolve)), sleep(2000)]);
  if (item.child.exitCode === null) item.child.kill("SIGKILL");
}

function parseOptions(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid argument near ${name}`);
    }
    values.set(name, value);
    index += 1;
  }
  return {
    mode: enumValue(values.get("--mode") ?? "both", ["both", "local", "remote"], "--mode"),
    duration: positive(values.get("--duration") ?? "10", "--duration"),
    warmup: nonNegative(values.get("--warmup") ?? "2", "--warmup"),
    connections: positive(values.get("--connections") ?? "8", "--connections"),
    concurrency: positive(values.get("--concurrency") ?? "512", "--concurrency"),
    callCount: positive(values.get("--call-count") ?? "1", "--call-count"),
    delay: nonNegative(values.get("--delay") ?? "0", "--delay"),
    drain: positive(values.get("--drain") ?? "10", "--drain"),
  };
}

function enumValue(value, allowed, name) {
  if (!allowed.includes(value)) throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  return value;
}
function positive(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`invalid ${name}: ${value}`);
  return number;
}
function nonNegative(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`invalid ${name}: ${value}`);
  return number;
}
function timestamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_"); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
