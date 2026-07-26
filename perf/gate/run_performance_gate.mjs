import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const configPath = path.join(root, "perf", "gate", "performance_gate.config.json");
const configText = readFileSync(configPath, "utf8");
const config = JSON.parse(configText);
const options = parseOptions(process.argv.slice(2));
const machine = machineIdentity();
const profile = options.profile ?? defaultProfile(machine);
const baselinePath = path.join(root, "perf", "baselines", `${profile}.json`);
const resultDirectory = path.join(root, "perf", "results", "gate");
const activeChildren = new Set();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    for (const child of activeChildren) child.kill("SIGTERM");
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

if (options.selfTest) {
  runSelfTest();
  process.exit(0);
}

await main();

async function main() {
  validateConfig(config);
  mkdirSync(resultDirectory, { recursive: true });
  if (!options.skipBuild) await buildSuite();

  const rounds = [];
  for (let round = 1; round <= config.rounds; round += 1) {
    console.log(`\n[perf-gate] round ${round}/${config.rounds}`);
    rounds.push({
      rpc: await runRpcRound(),
      innerRpc: await runInnerRpcRound(),
      stateReplication: await runStateReplicationRound(),
    });
  }

  const candidate = aggregateCandidate(rounds);
  const candidatePath = path.join(resultDirectory, `performance_gate_${timestamp()}.json`);
  writeJson(candidatePath, candidate);
  writeJson(path.join(resultDirectory, "performance_gate_latest.json"), candidate);

  if (options.updateBaseline) {
    const previous = existsSync(baselinePath)
      ? JSON.parse(readFileSync(baselinePath, "utf8"))
      : undefined;
    mkdirSync(path.dirname(baselinePath), { recursive: true });
    const next = {
      schemaVersion: 1,
      profile,
      updatedAt: new Date().toISOString(),
      updateReason: options.reason,
      machine,
      configHash: candidate.configHash,
      tolerance: config.tolerance,
      metrics: candidate.metrics,
    };
    writeJson(baselinePath, next);
    const reviewPath = path.join(resultDirectory, `baseline_update_${timestamp()}.md`);
    writeFileSync(reviewPath, buildBaselineReview(previous, next), "utf8");
    console.log(`[perf-gate] baseline updated: ${path.relative(root, baselinePath)}`);
    console.log(`[perf-gate] baseline review: ${path.relative(root, reviewPath)}`);
    return;
  }

  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const failures = comparePerformance(baseline, candidate);
  printComparison(baseline, candidate, failures);
  if (failures.length > 0) {
    process.exitCode = 1;
    throw new Error(`performance gate failed with ${failures.length} regression(s)`);
  }
  console.log(`[perf-gate] passed: ${path.relative(root, candidatePath)}`);
}

async function buildSuite() {
  const npm = npmInvocation(["run", "build:bench"]);
  await runInherited(npm.command, npm.args);
  await runInherited("cargo", [
    "build", "--release", "--locked",
    "--bin", "TiangZ",
    "--bin", "runtime_load",
    "--bin", "inner_rpc_load",
    "--bin", "dirty_replication_perf",
  ]);
}

async function runRpcRound() {
  const value = config.rpc;
  const output = await runCaptured(process.execPath, [
    path.join(root, "perf", "rpc_baseline", "run_rpc_baseline.mjs"),
    "--skip-build",
    "--no-latest",
    "--payloads", value.payloads.join(","),
    "--duration", String(value.durationSeconds),
    "--warmup", String(value.warmupSeconds),
    "--connections", String(value.connections),
    "--concurrency", String(value.concurrency),
  ]);
  return readReportedJson(output, /\[rpc-baseline\] report-json: (.+\.json)/);
}

async function runInnerRpcRound() {
  const value = config.innerRpc;
  const output = await runCaptured(process.execPath, [
    path.join(root, "perf", "inner_rpc", "run_inner_rpc_perf.mjs"),
    "--mode", "both",
    "--no-latest",
    "--duration", String(value.durationSeconds),
    "--warmup", String(value.warmupSeconds),
    "--connections", String(value.connections),
    "--concurrency", String(value.concurrency),
  ]);
  return readReportedJson(output, /\[inner-rpc\] report-json: (.+\.json)/);
}

async function runStateReplicationRound() {
  const value = config.stateReplication;
  const suffix = process.platform === "win32" ? ".exe" : "";
  const output = await runCaptured(
    path.join(root, "target", "release", `dirty_replication_perf${suffix}`),
    [
      "--entities", String(value.entities),
      "--duration-ms", String(value.durationMs),
      "--warmup-ms", String(value.warmupMs),
      "--json",
    ],
  );
  const line = output.split(/\r?\n/).findLast((item) => item.startsWith("RESULT_JSON "));
  if (!line) throw new Error("state replication benchmark did not return RESULT_JSON");
  return JSON.parse(line.slice("RESULT_JSON ".length));
}

function aggregateCandidate(rounds) {
  const metrics = {};
  for (const payload of config.rpc.payloads) {
    const items = rounds.map((round) => round.rpc.results.find((item) => item.payloadBytes === payload));
    metrics[`rpc.${payload}.throughput`] = metric("higher", items.map((item) => item.requestsPerSecond));
    metrics[`rpc.${payload}.p99Ms`] = metric("lower", items.map((item) => item.p99Ms));
    metrics[`rpc.${payload}.errors`] = metric("zero", items.map((item) => item.errors));
  }
  for (const deployment of ["local", "remote"]) {
    const items = rounds.map((round) => round.innerRpc.results.find((item) => item.deployment === deployment));
    metrics[`innerRpc.${deployment}.throughput`] = metric("higher", items.map((item) => item.requestsPerSecond));
    metrics[`innerRpc.${deployment}.p99Ms`] = metric("lower", items.map((item) => item.p99Ms));
    metrics[`innerRpc.${deployment}.errors`] = metric("zero", items.map((item) => item.errors));
  }
  for (const name of ["Numeric dynamic", "PlayerInfo fixed", "Item immediate"]) {
    const key = slug(name);
    const items = rounds.map((round) => round.stateReplication.results.find((item) => item.name === name));
    metrics[`stateReplication.${key}.itemsPerSecond`] = metric(
      "higher",
      items.map((item) => item.itemsPerSecond),
    );
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    profile,
    projectVersion: JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version,
    machine,
    configHash: hash(configText),
    rounds: config.rounds,
    metrics,
  };
}

function metric(direction, samples) {
  if (samples.some((value) => !Number.isFinite(value))) {
    throw new Error(`invalid performance samples: ${samples.join(", ")}`);
  }
  return { direction, value: direction === "zero" ? Math.max(...samples) : median(samples), samples };
}

function comparePerformance(baseline, candidate) {
  const failures = [];
  if (baseline.schemaVersion !== 1) failures.push("baseline schemaVersion is unsupported");
  if (baseline.configHash !== candidate.configHash) failures.push("performance config changed; review and update baseline explicitly");
  for (const key of ["platform", "arch", "cpu", "logicalCpus"]) {
    if (baseline.machine?.[key] !== candidate.machine[key]) {
      failures.push(`machine mismatch ${key}: baseline=${baseline.machine?.[key]} candidate=${candidate.machine[key]}`);
    }
  }
  for (const [name, current] of Object.entries(candidate.metrics)) {
    const previous = baseline.metrics?.[name];
    if (!previous) {
      failures.push(`baseline metric missing: ${name}`);
      continue;
    }
    if (current.direction === "zero") {
      if (current.value !== 0) failures.push(`${name} must remain zero, got ${current.value}`);
      continue;
    }
    if (current.direction === "higher") {
      const minimum = previous.value * baseline.tolerance.minimumThroughputRatio;
      if (current.value < minimum) failures.push(`${name} ${round(current.value)} < ${round(minimum)}`);
      continue;
    }
    const slack = name.startsWith("innerRpc.")
      ? baseline.tolerance.innerRpcLatencySlackMs
      : baseline.tolerance.rpcLatencySlackMs;
    const maximum = Math.max(
      previous.value * baseline.tolerance.maximumLatencyRatio,
      previous.value + slack,
    );
    if (current.value > maximum) failures.push(`${name} ${round(current.value)} > ${round(maximum)}`);
  }
  return failures;
}

function printComparison(baseline, candidate, failures) {
  console.log("\n[perf-gate] comparison");
  for (const [name, current] of Object.entries(candidate.metrics)) {
    const previous = baseline.metrics?.[name];
    const delta = previous?.value === 0
      ? "n/a"
      : `${(((current.value / previous.value) - 1) * 100).toFixed(1)}%`;
    console.log(`${name.padEnd(52)} baseline=${round(previous?.value)} current=${round(current.value)} delta=${delta}`);
  }
  for (const failure of failures) console.error(`[perf-gate] FAIL ${failure}`);
}

function runSelfTest() {
  const baseline = {
    schemaVersion: 1,
    configHash: "same",
    machine,
    tolerance: config.tolerance,
    metrics: {
      throughput: { direction: "higher", value: 100 },
      "rpc.test.p99Ms": { direction: "lower", value: 10 },
      errors: { direction: "zero", value: 0 },
    },
  };
  const passing = {
    configHash: "same",
    machine,
    metrics: {
      throughput: { direction: "higher", value: 90 },
      "rpc.test.p99Ms": { direction: "lower", value: 12.5 },
      errors: { direction: "zero", value: 0 },
    },
  };
  if (comparePerformance(baseline, passing).length !== 0) throw new Error("passing fixture failed");
  const failing = structuredClone(passing);
  failing.metrics.throughput.value = 89;
  failing.metrics.errors.value = 1;
  if (comparePerformance(baseline, failing).length !== 2) throw new Error("failing fixture was not rejected");
  console.log("performance gate self-test passed");
}

function readReportedJson(output, pattern) {
  const match = output.match(pattern);
  if (!match) throw new Error(`benchmark did not report a JSON path matching ${pattern}`);
  return JSON.parse(readFileSync(match[1].trim(), "utf8"));
}

function runInherited(command, args) {
  console.log(`[perf-gate] ${command} ${args.join(" ")}`);
  return runChild(command, args, "inherit");
}

function runCaptured(command, args) {
  console.log(`[perf-gate] ${path.basename(command)} ${args.join(" ")}`);
  return runChild(command, args, "capture");
}

function runChild(command, args, mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: mode === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    activeChildren.add(child);
    let output = "";
    if (mode === "capture") {
      for (const stream of [child.stdout, child.stderr]) {
        stream.on("data", (chunk) => {
          const text = chunk.toString("utf8");
          output += text;
          process.stdout.write(text);
        });
      }
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      activeChildren.delete(child);
      if (code === 0) resolve(output);
      else reject(new Error(`${command} failed with code=${code} signal=${signal ?? "none"}`));
    });
  });
}

function parseOptions(args) {
  const value = {
    updateBaseline: false,
    skipBuild: false,
    selfTest: false,
    profile: undefined,
    reason: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--update-baseline") value.updateBaseline = true;
    else if (argument === "--skip-build") value.skipBuild = true;
    else if (argument === "--self-test") value.selfTest = true;
    else if (argument === "--profile") value.profile = args[++index];
    else if (argument === "--reason") value.reason = args[++index];
    else if (argument === "--help" || argument === "-h") {
      printHelp();
      process.exit(0);
    } else throw new Error(`unknown argument: ${argument}`);
  }
  if (value.profile !== undefined && !/^[a-z0-9._-]+$/i.test(value.profile)) {
    throw new Error(`invalid --profile: ${value.profile}`);
  }
  if (value.updateBaseline && (!value.reason || value.reason.trim().length < 8)) {
    throw new Error("--update-baseline requires --reason with at least 8 characters");
  }
  return value;
}

function printHelp() {
  console.log(`TiangZ 框架性能回归门

用法：
  npm run perf:gate -- [--profile name] [--skip-build]
  npm run perf:gate:update -- [--profile name] --reason "review reason" [--skip-build]

普通模式只比较已有基线；--update-baseline 必须显式使用，用于评审后建立或更新当前机器基线。
`);
}

function buildBaselineReview(previous, next) {
  const lines = [
    "# 性能基线更新评审",
    "",
    `- Profile：${next.profile}`,
    `- 时间：${next.updatedAt}`,
    `- 原因：${next.updateReason}`,
    `- 机器：${next.machine.cpu} / ${next.machine.platform} ${next.machine.arch}`,
    "",
    "| 指标 | 旧值 | 新值 | 变化 |",
    "| --- | ---: | ---: | ---: |",
  ];
  for (const [name, metricValue] of Object.entries(next.metrics)) {
    const oldValue = previous?.metrics?.[name]?.value;
    const delta = Number.isFinite(oldValue) && oldValue !== 0
      ? `${(((metricValue.value / oldValue) - 1) * 100).toFixed(1)}%`
      : "新建";
    lines.push(`| ${name} | ${round(oldValue)} | ${round(metricValue.value)} | ${delta} |`);
  }
  return `${lines.join("\n")}\n`;
}

function validateConfig(value) {
  if (value.schemaVersion !== 1 || !Number.isInteger(value.rounds) || value.rounds < 3) {
    throw new Error("performance gate requires schemaVersion=1 and at least three rounds");
  }
}

function machineIdentity() {
  return {
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    cpu: os.cpus()[0]?.model ?? "unknown",
    logicalCpus: os.cpus().length,
    memoryBytes: os.totalmem(),
    nodeMajor: Number(process.versions.node.split(".")[0]),
  };
}

function defaultProfile(value) {
  return slug(`${value.platform}-${value.arch}-${value.cpu}`);
}

function npmInvocation(args) {
  if (process.env.npm_execpath) {
    return { command: process.execPath, args: [process.env.npm_execpath, ...args] };
  }
  return { command: process.platform === "win32" ? "npm.cmd" : "npm", args };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function slug(value) {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-|-$/g, "");
}

function hash(value) {
  return createHash("sha256").update(value.replaceAll("\r\n", "\n")).digest("hex");
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : "missing";
}

function timestamp() {
  return new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
