// Read-only status without starting PowerShell/CIM or rescanning large runtime logs.
import { closeSync, existsSync, fstatSync, openSync, readSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const base = fileURLToPath(new URL("../../../.build-tmp/local-validation/", import.meta.url));
const dir = path.resolve(base, process.argv[2] ?? "");
if (!dir.startsWith(base)) throw new Error("expected a validation run name");
function tail(name) {
  const file = path.join(dir, name);
  if (!existsSync(file)) return [];
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - 128 * 1024);
    const buffer = Buffer.alloc(size - start);
    const read = readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, read).toString("utf8").trimEnd().split(/\r?\n/);
    return start ? lines.slice(1) : lines;
  } finally { closeSync(fd); }
}
const resources = tail("resources.jsonl").filter(Boolean).map(JSON.parse);
const events = tail("events.jsonl").filter(Boolean).map(JSON.parse);
const latest = resources.at(-1);
const persistence = tail("persistence-soak.log").findLast(line => /^SOAK_(INTERVAL|FINAL|CONTRACT_ERROR) /.test(line));
const persistenceValue = persistence ? JSON.parse(persistence.slice(persistence.indexOf(" ") + 1)) : null;
console.log(JSON.stringify({ now: new Date().toISOString(),
  latestResource: latest && { at: latest.at, freeGiB: latest.availableMemoryBytes / 1024 ** 3,
    cpu: latest.systemCpuPercent, gapMs: latest.sampleGapMs },
  recentEvents: events.slice(-3).map(({ at, type, phase, action, epoch, mapId }) => ({ at, type, phase, action, epoch, mapId })),
  latestGameShards: events.filter(e => e.type === "game_shard_finished").slice(-2).map(e => ({
    at: e.at, mapId: e.mapId, faultWindow: e.faultWindow, healthy: e.healthy,
    probeErrors: e.result?.probe?.errors, businessErrors: e.result?.business?.transportErrors,
    businessP99Ms: e.result?.business?.p99Ms,
  })),
  latestPersistence: persistenceValue ? { marker: persistence.split(" ", 1)[0],
    elapsedSeconds: persistenceValue.elapsedSeconds, total: persistenceValue.total ?? persistenceValue.totals,
    validation: persistenceValue.validation } : null,
}));
for (const file of ["started.json", "failure.json", "final.json"]) {
  if (!existsSync(path.join(dir, file))) continue;
  const value = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
  console.log(file, JSON.stringify(file === "started.json"
    ? { startedAt: value.startedAt, deadlineAt: value.deadlineAt, seconds: value.seconds, players: value.players, pid: value.pid }
    : value));
}
