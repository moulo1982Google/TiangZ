import { test } from "node:test";
import assert from "node:assert/strict";
import { cpuPercent, cpuTotals, resourceViolation, hasDroppedLogs, memoryPressure, cpuPressure } from "./local_validation_resources.mjs";

test("CPU telemetry uses deltas and cannot mistake process lifetime for current load", () => {
  assert.equal(cpuPercent(undefined, { idle: 10, total: 20 }), null);
  assert.equal(cpuPercent({ idle: 10, total: 20 }, { idle: 35, total: 120 }), 75);
  assert.equal(cpuPercent({ idle: 10, total: 20 }, { idle: 10, total: 20 }), null);
  assert.deepEqual(cpuTotals([{ times: { idle: 10, user: 2, sys: 3, nice: 0, irq: 1 } }]), { idle: 10, total: 16 });
});

test("one observed memory cliff aborts instead of waiting three minutes", () => {
  const normal = { availableMemoryBytes: 4 * 1024 ** 3, freeDiskBytes: 100 * 1024 ** 3, artifactBytes: 500 * 1024 ** 2 };
  assert.equal(resourceViolation(normal), undefined);
  assert.match(resourceViolation({ ...normal, availableMemoryBytes: 617 * 1024 ** 2 }), /memory/);
  assert.equal(resourceViolation({ ...normal, availableMemoryBytes: 1024 ** 3 }), undefined);
  assert.match(resourceViolation({ ...normal, freeDiskBytes: 9 * 1024 ** 3 }), /disk/);
  assert.match(resourceViolation({ ...normal, artifactBytes: 3 * 1024 ** 3 }), /evidence/);
  for (const bad of [NaN, undefined, -1, Infinity]) assert.match(resourceViolation({ ...normal, availableMemoryBytes: bad }), /invalid/);
});

test("log loss checks every process label rather than accepting the first zero", () => {
  assert.equal(hasDroppedLogs('tiangz_process_dropped_logs_total{process="a"} 0\n'), false);
  assert.equal(hasDroppedLogs('tiangz_process_dropped_logs_total{process="a"} 0\ntiangz_process_dropped_logs_total{process="b"} 1\n'), true);
  assert.equal(hasDroppedLogs('tiangz_process_dropped_logs_total 1e+2\n'), true);
});

test("pressure evidence captures a sudden drop without calling it a pass or a failure", () => {
  assert.equal(memoryPressure(undefined, 4 * 1024 ** 3), false);
  assert.equal(memoryPressure(4 * 1024 ** 3, 3.5 * 1024 ** 3), true);
  assert.equal(memoryPressure(4 * 1024 ** 3, 3.9 * 1024 ** 3), false);
  assert.equal(memoryPressure(1.8 * 1024 ** 3, 1.9 * 1024 ** 3), true);
  assert.equal(resourceViolation({ availableMemoryBytes: 1.9 * 1024 ** 3, freeDiskBytes: 20 * 1024 ** 3, artifactBytes: 0 }), undefined);
});

test("high CPU requests evidence but is not itself a correctness failure", () => {
  for (const value of [null, undefined, NaN, Infinity, -1, 89.99, 101]) assert.equal(cpuPressure(value), false);
  for (const value of [90, 99.5, 100]) assert.equal(cpuPressure(value), true);
  assert.equal(resourceViolation({ availableMemoryBytes: 3 * 1024 ** 3, freeDiskBytes: 20 * 1024 ** 3,
    artifactBytes: 0, systemCpuPercent: 100 }), undefined);
});
