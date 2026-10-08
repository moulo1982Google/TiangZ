import { afterEach, expect, test, vi } from "vitest";
import { DbProxyClient, DbProxyErrorCode, DbProxyRemoteError, type DbProxyTransport, type DbProxySnapshotWrite } from "@tiangz/dbproxy-sdk";
import { HostDbProxyTransport } from "../../app/core/persistence/HostDbProxyTransport";
import { DbProxyEntityRepository, DbProxyQueuedEntityRepository } from "../../app/core/persistence/VersionedEntityRepository";

const codec = {
  recordNamespace: "budget", schema: "counter", schemaVersion: 1,
  Capture: (value: number) => value,
  Encode: (value: number) => Uint8Array.of(value),
  Decode: (value: Uint8Array) => value[0]!,
};
const unavailable = () => new DbProxyRemoteError(DbProxyErrorCode.StorageUnavailable, "receipt unknown");

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

// All operations in this fixture complete synchronously; no physical I/O can outlive a call.
function fixture(timeout = 100) {
  let now = 1000;
  const options: number[] = [];
  const writes: DbProxySnapshotWrite[] = [];
  const transport = {
    supportsRequestTimeout: true, requestTimeoutMs: timeout, monotonicNowMs: () => now,
    load: vi.fn<DbProxyTransport["load"]>(async (_record, budget) => { options.push(budget!.timeoutMs); return undefined; }),
    save: vi.fn<DbProxyTransport["save"]>(async (write, budget) => {
      options.push(budget!.timeoutMs); writes.push(write); return { disposition: "applied", revision: 1n };
    }),
    enqueueSnapshot: vi.fn<DbProxyTransport["enqueueSnapshot"]>(async (_write, budget) => { options.push(budget!.timeoutMs); }),
  };
  return { transport, client: new DbProxyClient(transport as unknown as DbProxyTransport), options, writes, advance: (ms: number) => { now += ms; } };
}

test("schema guard and repeated saves consume one deadline with stable bytes and ID", async () => {
  const f = fixture();
  const buffer = Uint8Array.of(7);
  f.transport.load.mockImplementationOnce(async (_record, budget) => { f.options.push(budget!.timeoutMs); f.advance(30); return undefined; });
  f.transport.save.mockImplementationOnce(async (write, budget) => {
    f.writes.push(write); f.options.push(budget!.timeoutMs); f.advance(25); buffer[0] = 99; throw unavailable();
  });
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const delays: number[] = [];
  vi.stubGlobal("__hostSleep", async (delay: number) => { delays.push(delay); f.advance(delay); });
  const repository = new DbProxyEntityRepository({ ...codec, Encode: () => buffer }, "unit", f.client);
  await repository.SaveSnapshot("one", 7, 1n);
  expect(f.options).toEqual([100, 70, 32]);
  expect(delays).toEqual([13]);
  expect(f.writes).toHaveLength(2);
  expect(f.writes[0]).toEqual(f.writes[1]);
  expect(f.writes[1]!.payload).toEqual(Uint8Array.of(7));
});

test("expiration after a version read prevents writing, while the next operation has a fresh budget", async () => {
  const f = fixture();
  f.transport.load.mockImplementationOnce(async (_record, budget) => { f.options.push(budget!.timeoutMs); f.advance(100); return undefined; });
  const repository = new DbProxyEntityRepository(codec, "unit", f.client);
  await expect(repository.SaveSnapshot("one", 1, 1n)).rejects.toThrow(/budget.*exhausted/);
  expect(f.writes).toHaveLength(0);
  await repository.SaveSnapshot("two", 2, 0n);
  expect(f.options).toEqual([100, 100]);
});

test("migration write and authoritative reread cannot renew the load budget", async () => {
  const f = fixture();
  f.transport.load.mockImplementationOnce(async (record, budget) => {
    f.options.push(budget!.timeoutMs); f.advance(60);
    return { record, schema: codec.schema, schemaVersion: 1, payload: Uint8Array.of(1), revision: 1n, updatedAtUnixMs: 1n };
  });
  f.transport.save.mockImplementationOnce(async (write, budget) => {
    f.writes.push(write); f.options.push(budget!.timeoutMs); f.advance(40);
    throw new DbProxyRemoteError(DbProxyErrorCode.RevisionConflict, "concurrent migration");
  });
  const repository = new DbProxyEntityRepository({ ...codec, schemaVersion: 2,
    migrations: [{ fromVersion: 1, toVersion: 2, Migrate: (bytes: Uint8Array) => bytes }] }, "unit", f.client);
  await expect(repository.Load("one")).rejects.toThrow(/budget.*exhausted/);
  expect(f.options).toEqual([100, 40]);
  expect(f.transport.load).toHaveBeenCalledTimes(1);
});

test("backoff that does not fit preserves the last error without sleeping or retrying", async () => {
  const f = fixture(10);
  const error = unavailable();
  f.transport.save.mockRejectedValueOnce(error);
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const sleep = vi.fn(); vi.stubGlobal("__hostSleep", sleep);
  const repository = new DbProxyEntityRepository(codec, "unit", f.client);
  await expect(repository.SaveSnapshot("one", 1, 0n)).rejects.toBe(error);
  expect(f.transport.save).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});

test("capture and encoding time are inside both normal and queued entry budgets", async () => {
  const f = fixture();
  const slow = { ...codec, Capture: (n: number) => { f.advance(60); return n; }, Encode: (n: number) => { f.advance(40); return Uint8Array.of(n); } };
  const repository = new DbProxyEntityRepository(slow, "unit", f.client);
  const queued = new DbProxyQueuedEntityRepository(slow, "unit", f.client);
  await expect(repository.Save("one", 1, 0n)).rejects.toThrow(/budget.*exhausted/);
  await expect(queued.Enqueue("one", 1)).rejects.toThrow(/budget.*exhausted/);
  expect(f.options).toEqual([]);
});

test("concurrent repository calls keep independent deadlines", async () => {
  const f = fixture();
  let finish!: () => void;
  f.transport.load.mockImplementationOnce(async (_record, budget) => {
    f.options.push(budget!.timeoutMs); await new Promise<void>(resolve => { finish = resolve; }); return undefined;
  });
  const repository = new DbProxyEntityRepository(codec, "unit", f.client);
  const first = repository.SaveSnapshot("one", 1, 1n);
  f.advance(30);
  await repository.SaveSnapshot("two", 2, 0n);
  f.advance(20); finish(); await first;
  expect(f.options).toEqual([100, 100, 50]);
});

test("Host transport freezes an absolute deadline before converting parameters", async () => {
  let now = 1000;
  const deadlines: (number | undefined)[] = [];
  const transport = new HostDbProxyTransport({ supportsRequestTimeout: true, requestTimeoutMs: 100,
    monotonicNowMs: () => now,
    save: async (_request, deadline) => { deadlines.push(deadline); return { disposition: "applied", revision: "1" }; },
  } as ConstructorParameters<typeof HostDbProxyTransport>[0]);
  await transport.save({ requestId: "one", get record() { now += 10; return { namespace: "budget", key: "one" }; },
    schema: "counter", schemaVersion: 1, payload: Uint8Array.of(1), updatedAtUnixMs: 1n }, { timeoutMs: 50 });
  expect(deadlines).toEqual([1050]);
  expect(now).toBeGreaterThan(1000);
});

test("an older Host cannot advertise or silently ignore request scopes", () => {
  const unused = async (): Promise<never> => { throw new Error("unexpected I/O"); };
  const transport = new HostDbProxyTransport({ load: unused, loadMulti: unused, save: unused, saveMulti: unused,
    enqueueSnapshot: unused, enqueueMultiSnapshot: unused, applyTransaction: unused, loadTransaction: unused,
    applyMultiTransaction: unused, loadMultiTransaction: unused });
  expect(() => new DbProxyClient(transport).WithRequestBudget(100)).toThrow(/request timeout/);
});
