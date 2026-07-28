import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  runInherited,
  sleep,
  startRuntime,
  stopRuntime,
  waitForPort,
  writeFailureLogs,
} from "./lib/process_test_harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseOptions(process.argv.slice(2));
const config = JSON.parse(readFileSync(path.join(root, options.config), "utf8"));
const endpoint = config.scenes?.find((scene) => Number.isInteger(scene.port));
if (!endpoint) throw new Error(`config has no listening Scene: ${options.config}`);
const host = endpoint.ip === "0.0.0.0" || endpoint.ip === "::" ? "127.0.0.1" : endpoint.ip;
const runtime = startRuntime(root, options.config, "runtime-load", options.profile);
let succeeded = false;
let prometheusMetrics = "";

try {
  await waitForPort(endpoint.port, runtime);
  const common = [
    "--host", host,
    "--port", String(endpoint.port),
    "--duration", String(options.duration),
    "--warmup", String(options.warmup),
    "--concurrency", String(options.concurrency),
    "--connections", String(options.connections),
    "--payload", String(options.payload),
    "--delay", String(options.delay),
  ];
  if (options.client === "rust") {
    const suffix = process.platform === "win32" ? ".exe" : "";
    await runInherited(path.join(root, "target", options.profile, `runtime_load${suffix}`), common, root);
  } else {
    await runInherited(process.execPath, [path.join(root, "dist", "runtime_load_test.cjs"), ...common], root);
  }
  await sleep(options.requireBackpressure ? 500 : 250);
  if (options.requireBackpressure) {
    const healthPort = config.process?.observability?.health?.port;
    if (!Number.isInteger(healthPort)) {
      throw new Error("backpressure acceptance requires process.observability.health.port");
    }
    prometheusMetrics = await waitForPrometheusSample(
      `http://127.0.0.1:${healthPort}/metrics`,
      "tiangz_process_rust_queue_max_depth",
      runtime,
    );
    verifyBackpressure(prometheusMetrics, options.config);
  }
  succeeded = true;
} finally {
  await stopRuntime(runtime);
  if (!succeeded) {
    const directory = writeFailureLogs(root, "runtime-load", [runtime]);
    console.error(`[runtime-load] failure logs: ${directory}`);
  }
}

if (runtime.child.exitCode !== 0) {
  throw new Error(`Runtime stopped with code=${runtime.child.exitCode}:\n${runtime.output()}`);
}

const metricLines = runtime.output().split(/\r?\n/).filter((line) => line.includes("[metrics:"));
for (const line of metricLines) console.log(line);
if (runtime.stderr()) console.log(`server stderr:\n${runtime.stderr()}`);

function verifyBackpressure(metrics, configPath) {
  const maxQueue = prometheusValue(metrics, "tiangz_process_rust_queue_max_depth");
  const backpressure = prometheusValue(metrics, "tiangz_process_backpressure_waits_total");
  const slowDisconnects = prometheusValue(metrics, "tiangz_process_slow_disconnects_total");
  if (backpressure <= 0) throw new Error("expected backpressure to activate");
  const capacity = configPath.includes("bench_backpressure") ? 64 : 4096;
  if (maxQueue > capacity) throw new Error(`Rust ingress queue exceeded ${capacity}: ${maxQueue}`);
  if (slowDisconnects !== 0) throw new Error(`healthy localhost clients were disconnected: ${slowDisconnects}`);
  console.log(`backpressure acceptance passed: max_queue=${maxQueue} waits=${backpressure}`);
}

function prometheusValue(metrics, name) {
  const match = metrics.match(new RegExp(`^${name}\\{[^}]*\\} ([0-9.eE+-]+)$`, "m"));
  if (!match) throw new Error(`Prometheus metric is missing: ${name}`);
  return Number(match[1]);
}

/**
 * 等待进程发布首个五秒指标快照，避免快速机器在采样周期到达前误报缺失。
 * 这里只等待真实快照，不降低生产采样周期，也不接受没有目标指标的空响应。
 *
 * Waits for the first five-second process metrics snapshot so fast machines do
 * not report a false missing metric before the sampling interval. This waits
 * for a real snapshot; it neither changes production cadence nor accepts an
 * empty response.
 */
async function waitForPrometheusSample(url, metricName, runtime, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  let latest = "";
  while (Date.now() < deadline) {
    if (runtime.child.exitCode !== null) {
      throw new Error(`Runtime stopped before publishing metrics: code=${runtime.child.exitCode}`);
    }
    const response = await fetch(url);
    if (!response.ok) throw new Error(`metrics endpoint returned HTTP ${response.status}`);
    latest = await response.text();
    if (new RegExp(`^${metricName}\\{[^}]*\\} `, "m").test(latest)) return latest;
    await sleep(100);
  }
  throw new Error(`Prometheus metric was not sampled within ${timeoutMs}ms: ${metricName}\n${latest}`);
}

function parseOptions(args) {
  const result = {
    duration: 10,
    warmup: 2,
    concurrency: 128,
    connections: 4,
    payload: 256,
    delay: 0,
    config: "configs/bench/bench.json",
    client: "node",
    profile: "debug",
    requireBackpressure: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--help" || name === "-h") {
      printHelp();
      process.exit(0);
    } else if (name === "--release") result.profile = "release";
    else if (name === "--require-backpressure") result.requireBackpressure = true;
    else {
      const value = args[++index];
      if (value === undefined) throw new Error(`${name} requires a value`);
      if (name === "--duration") result.duration = positive(value, name);
      else if (name === "--warmup") result.warmup = nonNegative(value, name);
      else if (name === "--concurrency") result.concurrency = positive(value, name);
      else if (name === "--connections") result.connections = positive(value, name);
      else if (name === "--payload") result.payload = nonNegative(value, name);
      else if (name === "--delay") result.delay = nonNegative(value, name);
      else if (name === "--config") result.config = value;
      else if (name === "--client" && ["node", "rust"].includes(value)) result.client = value;
      else throw new Error(`unknown argument: ${name}`);
    }
  }
  return result;
}

function printHelp() {
  console.log(`TiangZ Runtime负载与背压测试

用法：
  node tools/runtime_load_test.mjs [options]

参数：
  --release                    使用target/release产物
  --config <path>              Process配置，默认configs/bench/bench.json
  --client node|rust           压测客户端，默认node
  --duration <seconds>         采样秒数
  --warmup <seconds>           预热秒数
  --connections <count>        TCP连接数
  --concurrency <count>        在途请求数
  --payload <bytes>            Payload大小
  --delay <milliseconds>       Handler人工延迟
  --require-backpressure       要求队列背压实际触发并校验指标
`);
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
