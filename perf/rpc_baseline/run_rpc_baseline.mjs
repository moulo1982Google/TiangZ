import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, "../..");
const options = parseOptions(process.argv.slice(2));
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const profileDirectory = options.profile === "release" ? "release" : "debug";
const runtimePath = path.join(root, "target", profileDirectory, `TiangZ${executableSuffix}`);
const loadClientPath = path.join(root, "target", profileDirectory, `runtime_load${executableSuffix}`);
const configPath = path.resolve(root, options.config);
const resultsDirectory = path.join(root, "perf", "results");
const runId = formatRunId(new Date());
const runtimeStdoutPath = path.join(resultsDirectory, `rpc_baseline_${runId}_runtime_stdout.log`);
const runtimeStderrPath = path.join(resultsDirectory, `rpc_baseline_${runId}_runtime_stderr.log`);

let runtime;
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    if (stopping) return;
    stopping = true;
    console.error(`\n[rpc-baseline] received ${signal}, stopping Runtime`);
    await stopChild(runtime);
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

try {
  mkdirSync(resultsDirectory, { recursive: true });
  if (!options.skipBuild) {
    await ensureNodeDependencies();
    await runNpm(["run", "build"]);
    const cargoArgs = ["build"];
    if (options.profile === "release") cargoArgs.push("--release");
    cargoArgs.push("--bin", "TiangZ", "--bin", "runtime_load");
    await runInherited("cargo", cargoArgs);
  }

  const target = readTarget(configPath);
  const runtimeStdout = createWriteStream(runtimeStdoutPath, { encoding: "utf8" });
  const runtimeStderr = createWriteStream(runtimeStderrPath, { encoding: "utf8" });
  runtime = spawn(runtimePath, [configPath], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  runtime.stdout.pipe(runtimeStdout);
  runtime.stderr.pipe(runtimeStderr);

  await waitForPort(target.host, target.port, options.startupTimeoutMs, runtime);
  console.log(`[rpc-baseline] Runtime ready at ${target.host}:${target.port}`);

  const results = [];
  for (const payloadBytes of options.payloads) {
    console.log(`\n[rpc-baseline] payload=${payloadBytes}B`);
    const output = await runCaptured(loadClientPath, [
      "--host", target.host,
      "--port", String(target.port),
      "--duration", String(options.durationSeconds),
      "--warmup", String(options.warmupSeconds),
      "--connections", String(options.connections),
      "--concurrency", String(options.concurrency),
      "--payload", String(payloadBytes),
      "--delay", String(options.delayMs),
      "--drain", String(options.drainSeconds),
    ]);
    results.push(parseResult(payloadBytes, output));
  }

  const report = buildReport(target, results);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = buildMarkdown(report);
  const jsonPath = path.join(resultsDirectory, `rpc_baseline_${runId}.json`);
  const markdownPath = path.join(resultsDirectory, `rpc_baseline_${runId}.md`);
  writeFileSync(jsonPath, json, "utf8");
  writeFileSync(markdownPath, markdown, "utf8");
  writeFileSync(path.join(resultsDirectory, "rpc_baseline_latest.json"), json, "utf8");
  writeFileSync(path.join(resultsDirectory, "rpc_baseline_latest.md"), markdown, "utf8");

  console.log(`\n[rpc-baseline] report: ${markdownPath}`);
  console.log(markdown);
} catch (error) {
  console.error(`[rpc-baseline] failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await stopChild(runtime);
}

function parseOptions(args) {
  const values = {
    profile: "release",
    config: "configs/local/bench.json",
    payloads: [64, 256, 1024, 4096, 16384],
    durationSeconds: 10,
    warmupSeconds: 2,
    connections: 8,
    concurrency: 512,
    delayMs: 0,
    drainSeconds: 10,
    startupTimeoutMs: 30_000,
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
      case "--profile": values.profile = value; break;
      case "--config": values.config = value; break;
      case "--payloads": values.payloads = parseIntegerList(name, value, true); break;
      case "--duration": values.durationSeconds = parsePositiveInteger(name, value); break;
      case "--warmup": values.warmupSeconds = parseNonNegativeInteger(name, value); break;
      case "--connections": values.connections = parsePositiveInteger(name, value); break;
      case "--concurrency": values.concurrency = parsePositiveInteger(name, value); break;
      case "--delay": values.delayMs = parseNonNegativeInteger(name, value); break;
      case "--drain": values.drainSeconds = parsePositiveInteger(name, value); break;
      case "--startup-timeout": values.startupTimeoutMs = parsePositiveInteger(name, value); break;
      default: throw new Error(`unknown argument: ${name}`);
    }
  }

  if (!new Set(["debug", "release"]).has(values.profile)) {
    throw new Error("--profile must be debug or release");
  }
  if (values.connections > values.concurrency) {
    throw new Error("--connections cannot exceed --concurrency");
  }
  return values;
}

function printHelp() {
  console.log(`跨平台 RPC 基线测试

用法：
  npm run perf:rpc-baseline -- [options]

参数：
  --profile release|debug       构建配置，默认 release
  --config <path>               Bench 配置，默认 configs/local/bench.json
  --payloads <bytes,...>        默认 64,256,1024,4096,16384
  --duration <seconds>          每档正式采样时间，默认 10
  --warmup <seconds>            每档预热时间，默认 2
  --connections <count>         TCP 长连接数，默认 8
  --concurrency <count>         总在途 RPC 数，默认 512
  --delay <milliseconds>        Handler 人工延迟，默认 0
  --drain <seconds>             停止发送后的排空超时，默认 10
  --startup-timeout <ms>        Runtime 启动超时，默认 30000
  --skip-build                  使用已有 dist 和 target 产物
`);
}

function parseIntegerList(name, value, allowZero) {
  const items = value.split(",").map((item) => (
    allowZero ? parseNonNegativeInteger(name, item.trim()) : parsePositiveInteger(name, item.trim())
  ));
  if (items.length === 0) throw new Error(`${name} cannot be empty`);
  return items;
}

function parsePositiveInteger(name, value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`invalid ${name}: ${value}`);
  return number;
}

function parseNonNegativeInteger(name, value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`invalid ${name}: ${value}`);
  return number;
}

function readTarget(filePath) {
  const config = JSON.parse(readFileSync(filePath, "utf8"));
  const scene = config.scenes?.find((item) => Number.isInteger(item.port));
  if (!scene) throw new Error(`config has no listening scene: ${filePath}`);
  const configuredIp = scene.ip ?? "127.0.0.1";
  return {
    sceneName: scene.name ?? "bench",
    host: configuredIp === "0.0.0.0" || configuredIp === "::" ? "127.0.0.1" : configuredIp,
    port: scene.port,
  };
}

function runInherited(command, args) {
  console.log(`[rpc-baseline] ${command} ${args.join(" ")}`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} failed with code=${code} signal=${signal ?? "none"}`));
    });
  });
}

async function ensureNodeDependencies() {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  const binaries = ["tsc", "esbuild"].map((name) => path.join(root, "node_modules", ".bin", `${name}${suffix}`));
  const valid = binaries.every((binary) => {
    if (!existsSync(binary)) return false;
    if (process.platform === "win32") return true;
    try {
      accessSync(binary, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (valid) return;

  console.log("[rpc-baseline] Node dependencies are missing or belong to another platform; running npm ci");
  await runNpm(["ci"]);
  for (const binary of binaries) {
    if (!existsSync(binary)) throw new Error(`npm ci did not create ${path.relative(root, binary)}`);
    if (process.platform !== "win32") accessSync(binary, constants.X_OK);
  }
}

function runNpm(args) {
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath) {
    throw new Error("npm_execpath is missing; start this test with npm run perf:rpc-baseline");
  }
  return runInherited(process.execPath, [npmExecPath, ...args]);
}

function runCaptured(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      process.stderr.write(text);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${command} failed with code=${code} signal=${signal ?? "none"}: ${stderr.trim()}`));
    });
  });
}

function waitForPort(host, port, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      child.off("error", onChildError);
      if (error) reject(error);
      else resolvePromise();
    };
    const onChildError = (error) => finish(new Error(`failed to start Runtime: ${error.message}`));
    child.once("error", onChildError);
    const attempt = () => {
      if (settled) return;
      if (child.exitCode !== null) {
        finish(new Error(`Runtime exited before listening, code=${child.exitCode}`));
        return;
      }
      const socket = net.createConnection({ host, port });
      socket.setTimeout(300);
      socket.once("connect", () => {
        socket.destroy();
        finish();
      });
      const retry = () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          finish(new Error(`timed out waiting for ${host}:${port}`));
        } else {
          setTimeout(attempt, 100);
        }
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
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    sleep(3000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function parseResult(payloadBytes, output) {
  const summary = output.match(/requests=(\d+) req\/s=([0-9.]+) errors=(\d+) peak_in_flight=(\d+)/);
  const latency = output.match(/latency_ms p50=([0-9.]+) p95=([0-9.]+) p99=([0-9.]+) max=([0-9.]+)/);
  if (!summary || !latency) throw new Error(`cannot parse runtime_load output for ${payloadBytes}B`);
  return {
    payloadBytes,
    requests: Number(summary[1]),
    requestsPerSecond: Number(summary[2]),
    errors: Number(summary[3]),
    peakInFlight: Number(summary[4]),
    p50Ms: Number(latency[1]),
    p95Ms: Number(latency[2]),
    p99Ms: Number(latency[3]),
    maxMs: Number(latency[4]),
  };
}

function buildReport(target, results) {
  return {
    generatedAt: new Date().toISOString(),
    runId,
    profile: options.profile,
    machine: {
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      cpu: os.cpus()[0]?.model ?? "unknown",
      logicalCpus: os.cpus().length,
      memoryGB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
      node: process.version,
    },
    target,
    parameters: {
      durationSeconds: options.durationSeconds,
      warmupSeconds: options.warmupSeconds,
      connections: options.connections,
      concurrency: options.concurrency,
      delayMs: options.delayMs,
      payloads: options.payloads,
    },
    results,
    logs: {
      runtimeStdout: path.relative(root, runtimeStdoutPath),
      runtimeStderr: path.relative(root, runtimeStderrPath),
    },
  };
}

function buildMarkdown(report) {
  const lines = [
    "# RPC 基线性能报告",
    "",
    `- 时间：${report.generatedAt}`,
    `- Profile：${report.profile}`,
    `- 平台：${report.machine.platform} ${report.machine.release} ${report.machine.arch}`,
    `- CPU：${report.machine.cpu}，逻辑核 ${report.machine.logicalCpus}`,
    `- 内存：${report.machine.memoryGB}GB`,
    `- Node：${report.machine.node}`,
    `- 目标：${report.target.host}:${report.target.port} (${report.target.sceneName})`,
    `- 参数：${report.parameters.connections} 连接，${report.parameters.concurrency} 并发，预热 ${report.parameters.warmupSeconds}s，采样 ${report.parameters.durationSeconds}s`,
    "",
    "| Payload | req/s | p50 ms | p95 ms | p99 ms | max ms | errors |",
    "|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const item of report.results) {
    lines.push(`| ${item.payloadBytes}B | ${Math.round(item.requestsPerSecond)} | ${item.p50Ms} | ${item.p95Ms} | ${item.p99Ms} | ${item.maxMs} | ${item.errors} |`);
  }
  lines.push(
    "",
    "链路：Rust TCP 客户端 -> Tokio -> Rust 有界队列 -> V8/TypeScript -> protobuf -> BenchScene Handler -> TCP Response。",
    "",
    "这是本机单轮短时基线，不应直接作为生产 SLA。正式容量数据应至少重复三轮并取中位数。",
    "",
  );
  return lines.join("\n");
}

function formatRunId(date) {
  const part = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}_${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
