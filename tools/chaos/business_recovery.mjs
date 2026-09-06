import { openSync, readSync, fstatSync, closeSync } from "node:fs";

// Bounded reads keep a seven-day evidence file out of the polling hot path.
export function recentGameEvents(file) {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - 1024 * 1024);
    const buffer = Buffer.alloc(size - start);
    const read = readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, read).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    lines.pop(); // An incomplete last line is not evidence of completion.
    return lines.filter(Boolean).map(line => JSON.parse(line));
  } finally { closeSync(fd); }
}

export function recoveryBaseline(events) {
  const baseline = new Map();
  for (const event of events) {
    if (event.type === "shard_finished") baseline.set(event.shard, {
      accountGeneration: event.accountGeneration, epoch: event.epoch,
    });
  }
  if (baseline.size === 0) throw new Error("missing pre-fault game identity evidence");
  return baseline;
}

export function evaluateBusinessRecovery(events, baseline, recoveredAfterMs, requiredRounds = 2) {
  if (!Number.isInteger(requiredRounds) || requiredRounds < 1) throw new Error("invalid recovery rounds");
  if (baseline.size === 0) return { passed: false, reason: "missing baseline" };
  const latest = new Map();
  for (const event of events) {
    if (event.type !== "shard_finished" || !baseline.has(event.shard)) continue;
    const initial = baseline.get(event.shard);
    if (event.epoch <= initial.epoch || Date.parse(event.at) < recoveredAfterMs) continue;
    const rounds = latest.get(event.shard) ?? new Map();
    rounds.set(event.epoch, event); // Duplicate evidence must not count twice.
    latest.set(event.shard, rounds);
  }
  for (const [shard, initial] of baseline) {
    const rounds = [...(latest.get(shard)?.values() ?? [])].sort((a, b) => a.epoch - b.epoch).slice(-requiredRounds);
    if (rounds.length !== requiredRounds) return { passed: false, reason: `${shard}: insufficient fresh rounds` };
    if (rounds.some(e => e.accountGeneration !== initial.accountGeneration)) {
      return { passed: false, reason: `${shard}: account replacement is not recovery` };
    }
    if (rounds.some(e => e.healthy !== true || e.completed !== true)) {
      return { passed: false, reason: `${shard}: business has not recovered` };
    }
    // A round that started before infrastructure recovery can hide setup failures.
    if (rounds.some(e => !events.some(start => start.type === "epoch_started" && start.epoch === e.epoch && Date.parse(start.at) >= recoveredAfterMs))) {
      return { passed: false, reason: `${shard}: setup predates recovery` };
    }
  }
  return { passed: true, shards: [...baseline.keys()], requiredRounds };
}
