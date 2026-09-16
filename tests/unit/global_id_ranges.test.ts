import { afterEach, expect, test } from "vitest";
import { DbProxyErrorCode, DbProxyRemoteError, type DbProxySnapshotEnvelope, type DbProxySnapshotWrite,
  type DbProxySnapshotWriteResult } from "@tiangz/dbproxy-sdk";
import { GlobalIdRangeAllocator } from "../../app/core/persistence/GlobalIdRangeAllocator";
import { GlobalIdSystem } from "../../app/core/runtime/IdSystem";
import { GLOBAL_ID_COUNTER_LIMIT, GLOBAL_ID_EPOCH_SECONDS } from "../../app/core/runtime/GlobalIdLayout";
import { PrepareGlobalIds } from "../../app/core/persistence/PrepareGlobalIds";

const wall = () => (GLOBAL_ID_EPOCH_SECONDS + 100) * 1000;
const allocators: GlobalIdRangeAllocator[] = [];
afterEach(() => { for (const allocator of allocators.splice(0)) allocator.Dispose(); });
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

class Store {
  snapshot: DbProxySnapshotEnvelope | undefined;
  receipts = new Map<string, { write: DbProxySnapshotWrite; revision: bigint }>();
  writes: DbProxySnapshotWrite[] = [];
  unavailable = false;
  loseReply = false;
  async Load(): Promise<DbProxySnapshotEnvelope | undefined> { return structuredClone(this.snapshot); }
  async Save(write: DbProxySnapshotWrite): Promise<DbProxySnapshotWriteResult> {
    this.writes.push(structuredClone(write));
    if (this.unavailable) throw new DbProxyRemoteError(DbProxyErrorCode.StorageUnavailable, "offline");
    const receipt = this.receipts.get(write.requestId);
    if (receipt) {
      expect(write).toEqual(receipt.write);
      return { disposition: "duplicate", revision: receipt.revision };
    }
    if ((this.snapshot?.revision ?? 0n) !== write.expectedRevision) throw new DbProxyRemoteError(DbProxyErrorCode.RevisionConflict, "conflict");
    const revision = (this.snapshot?.revision ?? 0n) + 1n;
    this.snapshot = { record: write.record, schema: write.schema, schemaVersion: write.schemaVersion,
      revision, payload: write.payload.slice(), updatedAtUnixMs: write.updatedAtUnixMs };
    this.receipts.set(write.requestId, { write: structuredClone(write), revision });
    if (this.loseReply) { this.loseReply = false; throw new Error("reply lost after commit"); }
    return { disposition: "applied", revision };
  }
}
function allocator(store = new Store(), block = 8, now = wall, retry = () => 2000) {
  const value = new GlobalIdRangeAllocator(store, 7, 3, block, now, retry);
  allocators.push(value);
  return value;
}
function generator(source: GlobalIdRangeAllocator) {
  const ids = new GlobalIdSystem();
  ids.Configure({ originServerId: 7, workerId: 3, allocation: "dbproxy" }, source);
  return ids;
}

test("same-second process restarts burn unused ranges and preserve the 63-bit layout", async () => {
  const store = new Store(), first = allocator(store); await first.Start();
  const a = generator(first).Next(); first.Dispose();
  const second = allocator(store); await second.Start(); const b = generator(second).Next();
  expect(b).toBeGreaterThan(a);
  expect(GlobalIdSystem.OriginServerId(a)).toBe(7);
  expect((a >> 12n) & 127n).toBe(3n);
  expect(a >> 49n).toBe(7n);
  expect(b).toBeLessThan(1n << 63n);
});
test("concurrent same-slot allocators do not adopt another contender's duplicate receipt", async () => {
  const store = new Store(), all = Array.from({ length: 8 }, () => allocator(store));
  await Promise.all(all.map(item => item.Start()));
  const values = all.map(item => generator(item).Next());
  expect(new Set(values).size).toBe(all.length);
  expect(store.receipts.size).toBe(all.length);
});
test("lost commit replies retain identical requests, burn duplicate ranges, and continue", async () => {
  const store = new Store(), source = allocator(store); store.loseReply = true;
  await expect(source.Start()).rejects.toThrow("reply lost");
  const original = structuredClone(store.writes[0]);
  await source.Start();
  expect(store.writes[1]).toEqual(original);
  expect(source.NextCounter()).toBe(100 * 4096 + 8);
});
test("wall-clock rollback after a process restart cannot lower the durable high-water mark", async () => {
  const store = new Store(), a = allocator(store); await a.Start(); const first = a.NextCounter(); a.Dispose();
  const b = allocator(store, 8, () => wall() - 90000); await b.Start();
  expect(b.NextCounter()).toBeGreaterThan(first);
});
test("exhaustion never falls back; failed prefetch retries with the same request after cooldown", async () => {
  let retryClock = 0;
  const store = new Store(), source = allocator(store, 4, wall, () => retryClock);
  await source.Start(); store.unavailable = true;
  expect(source.NextCounter()).toBe(100 * 4096);
  source.NextCounter(); await tick();
  source.NextCounter(); source.NextCounter();
  expect(() => source.NextCounter()).toThrow("depleted");
  const request = structuredClone(store.writes.at(-1));
  store.unavailable = false; retryClock = 1001;
  expect(() => source.NextCounter()).toThrow("depleted"); await tick();
  expect(store.writes.at(-1)).toEqual(request);
  expect(source.NextCounter()).toBe(100 * 4096 + 4);
});
test("refill is single-flight and does not eagerly issue one request per ID", async () => {
  const store = new Store(), source = allocator(store, 20);
  await Promise.all([source.Start(), source.Start()]);
  for (let i = 0; i < 9; i++) source.NextCounter();
  expect(store.writes).toHaveLength(1);
  source.NextCounter(); await tick();
  expect(store.writes).toHaveLength(2);
  for (let i = 0; i < 9; i++) source.NextCounter(); await tick();
  expect(store.writes).toHaveLength(2);
});
test("shutdown while a reservation is pending burns the result instead of reopening", async () => {
  const store = new Store(); let release!: () => void;
  const original = store.Save.bind(store);
  store.Save = async write => { await new Promise<void>(resolve => { release = resolve; }); return original(write); };
  const source = allocator(store), started = source.Start(); await tick();
  source.Dispose(); release(); await expect(started).rejects.toThrow("closed");
  expect(() => source.NextCounter()).toThrow("closed");
});
test("wrong schema, corrupt payload, and regressed records fail closed", async () => {
  for (const mutate of [
    (s: DbProxySnapshotEnvelope) => ({ ...s, schema: "wrong" }),
    (s: DbProxySnapshotEnvelope) => ({ ...s, payload: new Uint8Array(7) }),
    (s: DbProxySnapshotEnvelope) => ({ ...s, payload: new Uint8Array(8).fill(255) }),
  ]) {
    const store = new Store(), a = allocator(store); await a.Start(); a.Dispose();
    store.snapshot = mutate(store.snapshot!);
    await expect(allocator(store).Start()).rejects.toThrow("invalid global id");
  }
});
test("supported ID space cannot overflow or wrap", async () => {
  const source = allocator(new Store(), 8192, () => (GLOBAL_ID_EPOCH_SECONDS + 2 ** 30 - 1) * 1000);
  await expect(source.Start()).rejects.toThrow("exhausted");
  expect(GLOBAL_ID_COUNTER_LIMIT).toBe(2 ** 42);
});
test("a live allocator refuses a missing high-water record instead of recreating it", async () => {
  const store = new Store(), source = allocator(store, 2); await source.Start();
  store.snapshot = undefined;
  source.NextCounter(); await tick(); source.NextCounter();
  let failure: unknown;
  try { source.NextCounter(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(String((failure as Error).cause)).toContain("regressed");
  expect(store.writes).toHaveLength(1);
});
test("CAS contention has a bounded budget", async () => {
  const store = new Store();
  store.Save = async write => { store.writes.push(write); throw new DbProxyRemoteError(DbProxyErrorCode.RevisionConflict, "conflict"); };
  await expect(allocator(store).Start()).rejects.toThrow("contention budget");
  expect(store.writes).toHaveLength(16);
});
test("invalid configuration fails before writes and DBProxy mode has no implicit fallback", async () => {
  const store = new Store();
  expect(() => new GlobalIdRangeAllocator(store, 0, 0)).toThrow("originServerId");
  expect(() => new GlobalIdRangeAllocator(store, 1, 128)).toThrow("workerId");
  expect(() => allocator(store, 0)).toThrow("block size");
  expect(() => new GlobalIdSystem().Configure({ allocation: "dbproxy" })).toThrow("prepared");
  await expect(PrepareGlobalIds({ name: "test", identity: { allocation: "dbproxy" } })).rejects.toThrow("requires process.persistence");
  expect(store.writes).toHaveLength(0);
});
