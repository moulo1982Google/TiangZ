#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const lokiBase = process.env.TIANGZ_LOKI_URL ?? "http://127.0.0.1:3100";
const tempoBase = process.env.TIANGZ_TEMPO_URL ?? "http://127.0.0.1:3200";
const startedAtMs = Date.now();
const skipBuild = process.argv.includes("--skip-build");

await waitReady(`${lokiBase}/ready`, "Loki");
await waitReady(`${tempoBase}/ready`, "Tempo");
if (!skipBuild) {
  runNpm("build:debug");
  runNpm("build:runtime:debug");
}
runNpm("test:gate-failover");
runNpm("test:dynamic-map-fallback");

const gateEvidence = await waitForLog("player Gate ownership taken over");
const fallbackEvidence = await waitForLog("player recovered to safe static map");
const traceEvidence = await waitForCrossProcessTrace();
const report = {
  generatedAt: new Date().toISOString(),
  startedAt: new Date(startedAtMs).toISOString(),
  gateFailover: gateEvidence,
  dynamicMapFallback: fallbackEvidence,
  trace: traceEvidence,
};
const reportDirectory = path.resolve(root, "temp/test-logs");
mkdirSync(reportDirectory, { recursive: true });
const reportFile = path.join(reportDirectory, `observability-fault-${fileTimestamp()}.json`);
writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`[observability-fault] passed: ${reportFile}`);
console.log(`[observability-fault] traceId=${traceEvidence.traceId} services=${traceEvidence.services.join(",")}`);

function runNpm(script) {
  const result = spawnSync(`npm run ${script}`, {
    cwd: root,
    stdio: "inherit",
    shell: true,
  });
  if (result.status !== 0) {
    const detail = result.error ? `: ${result.error.message}` : "";
    throw new Error(`npm run ${script} failed with exit code ${result.status}${detail}`);
  }
}

async function waitReady(url, name) {
  await poll(30_000, async () => {
    const response = await fetch(url).catch(() => undefined);
    return response?.ok ? { url } : undefined;
  }, `${name} did not become ready at ${url}`);
}

async function waitForLog(message) {
  return await poll(30_000, async () => {
    const entries = await queryLoki(`{job="tiangz"} |= ${JSON.stringify(message)}`);
    const entry = entries.find((candidate) => candidate.line.includes(message));
    return entry ? { message, timestampNs: entry.timestampNs, labels: entry.labels } : undefined;
  }, `Loki did not receive fault evidence: ${message}`);
}

async function waitForCrossProcessTrace() {
  return await poll(30_000, async () => {
    const entries = await queryLoki('{job="tiangz"} |= "\\\"trace_id\\\":\\\""');
    const traceIds = new Set();
    for (const entry of entries) {
      const traceId = entry.line.match(/"trace_id":"([0-9a-f]{32})"/)?.[1];
      if (traceId) traceIds.add(traceId);
    }
    for (const traceId of [...traceIds].slice(0, 100)) {
      const response = await fetch(`${tempoBase}/api/traces/${traceId}`).catch(() => undefined);
      if (!response?.ok) continue;
      const trace = await response.json();
      const services = collectServiceNames(trace);
      if (services.size >= 2) return { traceId, services: [...services].sort() };
    }
    return undefined;
  }, "no Loki-correlated Tempo trace crossed two TiangZ processes");
}

async function queryLoki(query) {
  const params = new URLSearchParams({
    query,
    start: String(BigInt(startedAtMs) * 1_000_000n),
    end: String(BigInt(Date.now()) * 1_000_000n),
    direction: "backward",
    limit: "5000",
  });
  const response = await fetch(`${lokiBase}/loki/api/v1/query_range?${params}`).catch(() => undefined);
  if (!response?.ok) return [];
  const body = await response.json();
  return (body.data?.result ?? []).flatMap((stream) =>
    (stream.values ?? []).map(([timestampNs, line]) => ({ timestampNs, line, labels: stream.stream })));
}

function collectServiceNames(value, result = new Set()) {
  if (Array.isArray(value)) {
    for (const nested of value) collectServiceNames(nested, result);
    return result;
  }
  if (!value || typeof value !== "object") return result;
  if (value.key === "service.name") {
    const name = value.value?.stringValue;
    if (typeof name === "string" && name) result.add(name);
  }
  for (const nested of Object.values(value)) collectServiceNames(nested, result);
  return result;
}

async function poll(timeoutMs, probe, failure) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(failure);
}

function fileTimestamp() {
  return new Date().toISOString().replaceAll(":", "-");
}
