import test from "node:test";
import assert from "node:assert/strict";
import { LocalReplicaController } from "./local_replica_controller.mjs";
test("bounded serialized startup and drain-before-stop", async () => {
  let release; let safe = false; let stops = 0;
  const c = new LocalReplicaController({ min: 0, max: 2, cooldownMs: 0,
    start: async id => { await new Promise(resolve => { release = resolve; }); return id; },
    drain: async () => safe, stop: async () => { stops++; } });
  const first = c.reconcile(2); const duplicate = c.reconcile(2);
  release(); await Promise.all([first, duplicate]);
  assert.equal(c.instances.size, 1); assert.equal(c.sequence, 1);
  await assert.rejects(c.reconcile(3), /bounds/);
  await c.reconcile(0); assert.equal(stops, 0); assert.equal(c.instances.size, 1);
  safe = true; await c.reconcile(0); assert.equal(stops, 1); assert.equal(c.instances.size, 0);
  await c.close(); await assert.rejects(c.reconcile(0), /closed/);
});
test("startup failure backs off, shutdown owns a late startup", async () => {
  let now = 0; let calls = 0; let resolve; let stopped = 0;
  const c = new LocalReplicaController({ min: 0, max: 1, now: () => now,
    start: async () => { if (++calls === 1) throw new Error("fixture"); return new Promise(done => { resolve = done; }); },
    drain: async () => true, stop: async () => { stopped++; } });
  await assert.rejects(c.reconcile(1)); await c.reconcile(1); assert.equal(calls, 1);
  now = 501; const start = c.reconcile(1); const close = c.close(); resolve({});
  await start; await close; assert.equal(stopped, 1); assert.equal(c.instances.size, 0);
});
