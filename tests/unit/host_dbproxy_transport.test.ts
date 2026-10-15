import { afterEach, expect, test, vi } from "vitest";
import { DbProxyErrorCode, DbProxyRemoteError, type DbProxyRecordCommit, type DbProxySnapshotWrite } from "@tiangz/dbproxy-sdk";
import { HostDbProxyTransport, IsHostDbProxyAvailable } from "../../app/core/persistence/HostDbProxyTransport";

// The fake host returns exactly what the Rust bridge hands to V8: uint64 values as decimal strings, bytes as arrays.
type Host = ConstructorParameters<typeof HostDbProxyTransport>[0];
const record = { namespace: "player", key: "p1" };
const hostSnapshot = { namespace: "player", key: "p1", schema: "player", schemaVersion: 2, revision: "7",
  payload: [1, 2], updatedAtUnixMs: "1700000000000" };
const write: DbProxySnapshotWrite = { requestId: "r1", record, schema: "player", schemaVersion: 2,
  payload: Uint8Array.of(9), expectedRevision: 6n, updatedAtUnixMs: 1700000000001n };

afterEach(() => { vi.unstubAllGlobals(); });

function transport(overrides: object = {}) {
  const host = {
    supportsRequestTimeout: true, monotonicNowMs: () => 1000,
    load: vi.fn(async () => ({ snapshot: hostSnapshot })),
    loadMulti: vi.fn(async () => ({ snapshots: [hostSnapshot, undefined] })),
    save: vi.fn(async () => ({ disposition: "applied" as const, revision: "8" })),
    saveMulti: vi.fn(async () => ({ entries: [] })),
    enqueueSnapshot: vi.fn(async () => ({ accepted: true })),
    enqueueMultiSnapshot: vi.fn(async () => ({ entries: [] })),
    applyTransaction: vi.fn(async () => ({ disposition: "applied" as const, newRevision: "8", result: [5] })),
    loadTransaction: vi.fn(async () => ({})),
    applyMultiTransaction: vi.fn(async () => ({ disposition: "duplicate" as const, records: [], result: [] })),
    loadMultiTransaction: vi.fn(async () => ({})),
    ...overrides,
  };
  return { host, transport: new HostDbProxyTransport(host as unknown as NonNullable<Host>) };
}

test("snapshot reads convert decimal strings to bigint and byte arrays to Uint8Array", async () => {
  const { host, transport: t } = transport();
  const expected = { record, schema: "player", schemaVersion: 2, revision: 7n, payload: Uint8Array.of(1, 2),
    updatedAtUnixMs: 1700000000000n };
  await expect(t.load(record)).resolves.toEqual(expected);
  expect(host.load).toHaveBeenCalledWith("player", "p1");
  await expect(t.loadMulti([record, record])).resolves.toEqual([expected, undefined]);
  host.load.mockResolvedValueOnce({} as never);
  await expect(t.load(record)).resolves.toBeUndefined();
});

test("writes send uint64 values as strings and pass the frozen deadline", async () => {
  const { host, transport: t } = transport();
  await expect(t.save(write, { timeoutMs: 250 })).resolves.toEqual({ disposition: "applied", revision: 8n });
  expect(host.save).toHaveBeenCalledWith({ requestId: "r1", namespace: "player", key: "p1", schema: "player",
    schemaVersion: 2, payload: write.payload, expectedRevision: "6", updatedAtUnixMs: "1700000000001" }, 1250);
  await t.enqueueSnapshot({ ...write, expectedRevision: undefined });
  expect(host.enqueueSnapshot).toHaveBeenCalledWith(expect.objectContaining({ requestId: "r1", updatedAtUnixMs: "1700000000001" }));
  host.enqueueSnapshot.mockResolvedValueOnce({ accepted: false });
  await expect(t.enqueueSnapshot(write)).rejects.toThrow("rejected snapshot enqueue without an error");
});

test("batch entries keep per-entry failures, including an actual revision", async () => {
  const { host, transport: t } = transport();
  host.saveMulti.mockResolvedValueOnce({ entries: [
    { ok: true, disposition: "duplicate", revision: "3" },
    { ok: false, error: { code: DbProxyErrorCode.RevisionConflict, message: "conflict", actualRevision: "4" } },
    { ok: false, error: { code: DbProxyErrorCode.StorageUnavailable, message: "offline", actualRevision: null } },
  ] } as never);
  await expect(t.saveMulti([write, write, write])).resolves.toEqual([
    { ok: true, result: { disposition: "duplicate", revision: 3n } },
    { ok: false, error: { code: DbProxyErrorCode.RevisionConflict, message: "conflict", actualRevision: 4n } },
    { ok: false, error: { code: DbProxyErrorCode.StorageUnavailable, message: "offline", actualRevision: undefined } },
  ]);
  expect((host.saveMulti.mock.calls[0] as unknown[])[0]).toContainEqual({ requestId: "r1", record, schema: "player",
    schemaVersion: 2, payload: write.payload, expectedRevision: "6", updatedAtUnixMs: "1700000000001" });
  host.enqueueMultiSnapshot.mockResolvedValueOnce({ entries: [
    { ok: true }, { ok: false, error: { code: DbProxyErrorCode.StorageUnavailable, message: "busy" } },
  ] } as never);
  await expect(t.enqueueMultiSnapshot([write, write])).resolves.toEqual([
    { ok: true }, { ok: false, error: { code: DbProxyErrorCode.StorageUnavailable, message: "busy", actualRevision: undefined } },
  ]);
  host.enqueueMultiSnapshot.mockResolvedValueOnce({ entries: [{ ok: false }] } as never);
  await expect(t.enqueueMultiSnapshot([write])).rejects.toThrow("batch entry failed without an error");
});

test("single-record transactions and their receipts round-trip", async () => {
  const { host, transport: t } = transport();
  const transaction = { operationId: "op1", record, schema: "player", schemaVersion: 2, expectedRevision: 7n,
    payload: Uint8Array.of(1), result: Uint8Array.of(5), updatedAtUnixMs: 1n };
  await expect(t.applyTransaction(transaction)).resolves.toEqual({ disposition: "applied", newRevision: 8n, result: Uint8Array.of(5) });
  expect(host.applyTransaction).toHaveBeenCalledWith(expect.objectContaining({ operationId: "op1", namespace: "player",
    expectedRevision: "7", updatedAtUnixMs: "1" }));
  await expect(t.loadTransaction("op1", record)).resolves.toBeUndefined();
  host.loadTransaction.mockResolvedValueOnce({ receipt: { operationId: "op1", namespace: "player", key: "p1",
    newRevision: "8", result: [5] } } as never);
  await expect(t.loadTransaction("op1", record, { timeoutMs: 10 })).resolves.toEqual({ operationId: "op1", record,
    newRevision: 8n, result: Uint8Array.of(5) });
  expect(host.loadTransaction).toHaveBeenLastCalledWith("op1", "player", "p1", 1010);
});

test("multi-record transactions, CommitRecords and multi receipts round-trip", async () => {
  const { host, transport: t } = transport();
  const multi = { operationId: "op2", result: Uint8Array.of(1), writes: [{ record, schema: "player", schemaVersion: 2,
    expectedRevision: 3n, payload: Uint8Array.of(4), updatedAtUnixMs: 5n }] };
  host.applyMultiTransaction.mockResolvedValueOnce({ disposition: "applied", records: [{ namespace: "player", key: "p1",
    newRevision: "4" }], result: [1] } as never);
  await expect(t.applyMultiTransaction(multi)).resolves.toEqual({ disposition: "applied",
    records: [{ record, newRevision: 4n }], result: Uint8Array.of(1) });
  expect(host.applyMultiTransaction).toHaveBeenCalledWith({ operationId: "op2", result: multi.result, writes: [{
    record, schema: "player", schemaVersion: 2, expectedRevision: "3", payload: multi.writes[0]!.payload, updatedAtUnixMs: "5" }] });

  await expect(t.commitRecords(multi as unknown as DbProxyRecordCommit)).rejects.toThrow("does not support CommitRecords");
  const commitRecords = vi.fn(async () => ({ disposition: "duplicate" as const, records: [{ namespace: "player", key: "p1",
    newRevision: 4 }], result: [] }));
  const withCommit = transport({ commitRecords } as never).transport;
  await expect(withCommit.commitRecords(multi as unknown as DbProxyRecordCommit, { timeoutMs: 5 })).resolves.toEqual({
    disposition: "duplicate", records: [{ record, newRevision: 4n }], result: new Uint8Array() });
  expect(commitRecords).toHaveBeenCalledWith(multi, 1005);

  await expect(t.loadMultiTransaction("op2", [record])).resolves.toBeUndefined();
  host.loadMultiTransaction.mockResolvedValueOnce({ receipt: { operationId: "op2", records: [{ namespace: "player",
    key: "p1", newRevision: "4" }], result: [1] } } as never);
  await expect(t.loadMultiTransaction("op2", [record])).resolves.toEqual({ operationId: "op2",
    records: [{ record, newRevision: 4n }], result: Uint8Array.of(1) });
});

test("host errors keep their numeric code, so an expired receipt stays distinguishable", async () => {
  const { host, transport: t } = transport();
  host.loadMultiTransaction.mockResolvedValueOnce({ error: { code: 2007, message: "operation receipt expired" } } as never);
  const error = await t.loadMultiTransaction("op2", [record]).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(DbProxyRemoteError);
  expect(error).toMatchObject({ code: DbProxyErrorCode.OperationExpired, actualRevision: undefined });
  host.save.mockResolvedValueOnce({ error: { code: DbProxyErrorCode.RevisionConflict, message: "conflict", actualRevision: "12" } } as never);
  await expect(t.save(write)).rejects.toMatchObject({ code: DbProxyErrorCode.RevisionConflict, actualRevision: 12n });
});

test("malformed host values are rejected instead of guessed", async () => {
  const { host, transport: t } = transport();
  const revision = (value: unknown) => host.save.mockResolvedValueOnce({ disposition: "applied", revision: value } as never);
  for (const bad of ["07", "-1", "1.5", "", 1.5, -1, Number.MAX_SAFE_INTEGER + 1, undefined, null]) {
    revision(bad);
    await expect(t.save(write)).rejects.toThrow(TypeError);
  }
  revision("18446744073709551616");
  await expect(t.save(write)).rejects.toThrow("exceeds uint64");
  revision(-1n);
  await expect(t.save(write)).rejects.toThrow("must not be negative");
  revision(18446744073709551615n);
  await expect(t.save(write)).resolves.toMatchObject({ revision: 18446744073709551615n });
  host.save.mockResolvedValueOnce({ disposition: "ignored", revision: "1" } as never);
  await expect(t.save(write)).rejects.toThrow("no valid disposition");
});

test("request budgets require a capable host and a sane clock", async () => {
  const { transport: legacy } = transport({ supportsRequestTimeout: false, monotonicNowMs: undefined } as never);
  expect(legacy.supportsRequestTimeout).toBe(false);
  expect(legacy.supportsOutboxRelay).toBe(false);
  expect(legacy.requestTimeoutMs).toBe(5000);
  await expect(legacy.load(record)).resolves.toBeDefined();
  await expect(legacy.load(record, { timeoutMs: 10 })).rejects.toThrow("does not support DBProxy request timeouts");
  expect(() => legacy.monotonicNowMs()).toThrow("does not provide a monotonic DBProxy clock");

  const { transport: t } = transport({ supportsOutboxRelay: true, requestTimeoutMs: 800 } as never);
  expect(t.supportsOutboxRelay).toBe(true);
  expect(t.requestTimeoutMs).toBe(800);
  for (const timeoutMs of [0, 120_001, 1.5]) {
    await expect(t.load(record, { timeoutMs })).rejects.toThrow(RangeError);
  }
  const { transport: broken } = transport({ monotonicNowMs: () => Number.NaN } as never);
  await expect(broken.load(record, { timeoutMs: 10 })).rejects.toThrow("invalid monotonic clock");
});

test("the default constructor uses the installed host bridge", async () => {
  expect(IsHostDbProxyAvailable()).toBe(false);
  expect(() => new HostDbProxyTransport()).toThrow("did not install __hostDbProxy");
  const { host } = transport();
  vi.stubGlobal("__hostDbProxy", host);
  expect(IsHostDbProxyAvailable()).toBe(true);
  await expect(new HostDbProxyTransport().load(record)).resolves.toMatchObject({ revision: 7n });
});
