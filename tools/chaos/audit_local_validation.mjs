// Read-only audit of a completed local drill; never treats partial reconciliation as a pass.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { hasDroppedLogs, resourceViolation } from "./local_validation_resources.mjs";

const base = fileURLToPath(new URL("../../../.build-tmp/local-validation/", import.meta.url));
const dir = path.resolve(base, process.argv[2] ?? "");
assert.ok(dir.startsWith(base), "expected a validation run name");
const json = name => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
const jsonl = name => fs.readFileSync(path.join(dir, name), "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
assert.equal(fs.existsSync(path.join(dir, "failure.json")), false, "failed run cannot pass an audit");
assert.equal(fs.existsSync(path.join(dir, "failure-diagnostics.json")), false, "unexpected terminal failure evidence");
const final = json("final.json");
const started = json("started.json");
assert.equal(final.passed, true);
assert.equal(final.seconds, started.seconds);
assert.equal(final.players, started.players);
assert.ok(Date.parse(final.at) >= Date.parse(started.deadlineAt), "drill stopped before its deadline");
const events = jsonl("events.jsonl");
const resources = jsonl("resources.jsonl");
for (const sample of resources) assert.equal(resourceViolation(sample), undefined);
const faults = events.filter(e => e.type === "fault_started");
const recovered = events.filter(e => e.type === "business_recovered");
assert.equal(faults.length, final.actions);
assert.deepEqual(recovered.map(e => e.action), faults.map(e => e.action));
for (const e of faults) assert.equal(e.phase, e.action);
const windows = events.filter(e => ["game_round_started", "game_shard_finished"].includes(e.type));
for (const e of windows) assert.equal(typeof e.faultWindow, "boolean");
const healthy = events.filter(e => e.type === "game_shard_finished" && e.phase === "healthy" && !e.faultWindow);
assert.ok(healthy.length >= 2);
assert.ok(healthy.every(e => e.healthy && e.result.probe.errors === 0 && e.result.business.transportErrors === 0));
const aof = events.filter(e => e.type === "aof_backlog_survived");
for (const e of aof) assert.ok(e.acknowledged > 0 && e.verified === e.acknowledged);
let drops = 0, contractErrors = 0, soakFinal, relayFinal;
for (const name of fs.readdirSync(dir)) {
  if (!/^metrics-.*\.log$/.test(name) && !["persistence-soak.log", "relay-soak.log"].includes(name)) continue;
  for await (const line of readline.createInterface({ input: fs.createReadStream(path.join(dir, name)), crlfDelay: Infinity })) {
    if (hasDroppedLogs(line + "\n")) drops++;
    if (line.startsWith("SOAK_CONTRACT_ERROR ")) contractErrors++;
    if (line.startsWith("SOAK_FINAL ")) soakFinal = JSON.parse(line.slice(11));
    if (line.startsWith("RELAY_FINAL ")) relayFinal = JSON.parse(line.slice(12));
  }
}
assert.equal(drops, 0);
assert.equal(contractErrors, 0);
assert.equal(soakFinal?.validation.passed, true);
assert.equal(relayFinal?.passed, true);
assert.deepEqual(relayFinal, final.relayFinal);
for (const key of ["readsBehindAcknowledgedRevision", "missingSnapshots", "invariantErrors"]) assert.equal(soakFinal.totals[key], 0);
assert.deepEqual(final.sqlCounts, [relayFinal.committed, relayFinal.committed, 0]);
assert.equal(final.streamUnique, relayFinal.committed);
assert.deepEqual(final.facts, [relayFinal.committed * 2, relayFinal.committed * 2, relayFinal.committed]);
assert.ok(final.trades[0] > 0 && final.trades[0] === final.trades[1]);
const pressure = fs.readdirSync(dir).filter(name => /^resource-pressure-\d+\.json$/.test(name)).map(name => ({ name, ...json(name) }));
console.log(JSON.stringify({ passed: true, at: new Date().toISOString(),
  scope: "saved evidence audit; live SQL/MQ reconciliation was performed by the controller",
  actions: faults.length, recoveryRetries: events.filter(e => e.type === "business_recovery_retry").length,
  drops, contractErrors, soakFinal, final, aof,
  resource: { minimumGiB: Math.min(...resources.map(r => r.availableMemoryBytes)) / 1024 ** 3,
    cpuPeak: Math.max(...resources.map(r => r.systemCpuPercent ?? 0)),
    maxSampleGapMs: Math.max(...resources.map(r => r.sampleGapMs ?? 0)) },
  pressureSnapshots: pressure.map(d => ({ name: d.name, failed: !!d.processSnapshotError, elapsedMs: d.processSnapshotElapsedMs })),
  lastBusiness: healthy.slice(-2).map(e => ({ map: e.mapId, p99Ms: e.result.business.p99Ms })),
}));
