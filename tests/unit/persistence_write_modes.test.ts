import {
  DbProxyClient,
  DbProxyErrorCode,
  DbProxyRemoteError,
  type DbProxyBatchSnapshotEnqueueResult,
  type DbProxyBatchSnapshotWriteResult,
  type DbProxyRecordKey,
  type DbProxySnapshotEnvelope,
  type DbProxySnapshotWrite,
  type DbProxySnapshotWriteResult,
  type DbProxyTransactionReceipt,
  type DbProxyTransactionalWrite,
  type DbProxyTransactionalWriteResult,
  type DbProxyTransport,
} from "@tiangz/dbproxy-sdk";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  DbProxyEntityRepository,
  DbProxyQueuedEntityRepository,
  DbProxyTransactionalEntityRepository,
  type VersionedEntityCodec,
} from "../../app/core/persistence/VersionedEntityRepository";

interface Counter { readonly value: number }

/** v1字节为原值，v2为原值+10，用来观察读取时的迁移。 / v1 stores the raw value; v2 adds 10 so reads expose migration. */
function counterCodec(schemaVersion: 1 | 2): VersionedEntityCodec<Counter, Counter> {
  return {
    recordNamespace: "unit.write-modes",
    schema: "unit.Counter",
    schemaVersion,
    migrations: schemaVersion === 2 ? [{ fromVersion: 1, toVersion: 2, Migrate: (bytes) => new Uint8Array([bytes[0]! + 10]) }] : [],
    Capture: (value) => value,
    Encode: (value) => new Uint8Array([value.value]),
    Decode: (payload) => ({ value: payload[0]! }),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("@queued repository", () => {
  test("enqueues without a revision check and exposes no CAS or transactional writes", async () => {
    const transport = new RecordingTransport();
    const repository = new DbProxyQueuedEntityRepository(counterCodec(1), "unit-process", new DbProxyClient(transport));

    await repository.EnqueueSnapshot("p-1", { value: 3 });
    await repository.Enqueue("p-1", { value: 4 });

    expect(transport.saves).toHaveLength(0);
    expect(transport.enqueues).toHaveLength(2);
    const [first, second] = transport.enqueues;
    expect(first).toMatchObject({ record: { namespace: "unit.write-modes", key: "p-1" }, schema: "unit.Counter", schemaVersion: 1 });
    expect(first?.expectedRevision).toBeUndefined();
    expect(Array.from(second?.payload ?? [])).toEqual([4]);
    expect(first?.requestId).not.toBe(second?.requestId);
    expect(first?.requestId).toMatch(/^unit-process:unit\.write-modes:[0-9a-z]+:[0-9a-z]+:1$/);

    // 运行时和类型层都不能取得其他写法。 / Neither runtime nor types expose other write paths.
    expect("Save" in repository).toBe(false);
    expect("SaveSnapshot" in repository).toBe(false);
    expect("TransactionWrite" in repository).toBe(false);
    // @ts-expect-error @queued records must not be saved with CAS.
    void repository.Save;
    // @ts-expect-error @queued records must not join transactions.
    void repository.TransactionWrite;
  });

  test("sends each queued write once, without retrying storage unavailability", async () => {
    const transport = new RecordingTransport();
    transport.enqueueFailures.push(DbProxyErrorCode.StorageUnavailable);
    const repository = new DbProxyQueuedEntityRepository(counterCodec(1), "unit-process", new DbProxyClient(transport));

    // 下一次排队写会取代失败的这次；仓库重试只会在过载时放大负载。 / The next queued write supersedes a failed one; repository retries only amplify overload.
    await expect(repository.EnqueueSnapshot("p-2", { value: 5 })).rejects.toMatchObject({ code: DbProxyErrorCode.StorageUnavailable });
    expect(transport.enqueues).toHaveLength(1);

    await expect(repository.EnqueueSnapshot("p-2", { value: 6 })).resolves.toBeUndefined();
    expect(transport.enqueues).toHaveLength(2);
    expect(transport.enqueues[0]?.requestId).not.toBe(transport.enqueues[1]?.requestId);
  });

  test("reports codec failures as rejections, never synchronous throws", async () => {
    const transport = new RecordingTransport();
    const failing = { ...counterCodec(1), Encode: () => { throw new TypeError("invalid snapshot"); } };
    const repository = new DbProxyQueuedEntityRepository(failing, "unit-process", new DbProxyClient(transport));
    const pending = repository.EnqueueSnapshot("p-4", { value: 1 });
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toThrow("invalid snapshot");
    await expect(repository.Enqueue("p-4", { value: 1 })).rejects.toThrow("invalid snapshot");
    expect(transport.enqueues).toHaveLength(0);
  });

  test("migrates older schemas in memory without writing them back", async () => {
    const transport = new RecordingTransport();
    transport.stored.set("unit.write-modes/p-3", snapshot("p-3", 1, 7, 4n));
    const repository = new DbProxyQueuedEntityRepository(counterCodec(2), "unit-process", new DbProxyClient(transport));

    await expect(repository.Load("p-3")).resolves.toMatchObject({ data: { value: 17 }, revision: 4n });
    expect(transport.saves).toHaveLength(0);
    expect(transport.enqueues).toHaveLength(0);
  });
});

describe("@transactional repository", () => {
  test("builds transactional writes without storage access and exposes no standalone writes", () => {
    const transport = new RecordingTransport();
    const repository = new DbProxyTransactionalEntityRepository(counterCodec(1), "unit-process", new DbProxyClient(transport));

    const write = repository.TransactionWrite("w-1", { value: 9 }, 3n);
    expect(write).toMatchObject({
      record: { namespace: "unit.write-modes", key: "w-1" },
      schema: "unit.Counter",
      schemaVersion: 1,
      expectedRevision: 3n,
    });
    expect(Array.from(write.payload)).toEqual([9]);
    expect(typeof write.updatedAtUnixMs).toBe("bigint");
    expect(repository.TransactionWriteSnapshot("w-1", { value: 0 }, 0n).expectedRevision).toBe(0n);
    expect(transport.saves).toHaveLength(0);
    expect(transport.enqueues).toHaveLength(0);

    expect(() => repository.TransactionWrite("w-1", { value: 1 }, -1n)).toThrow(RangeError);
    expect(() => repository.TransactionWrite("", { value: 1 }, 0n)).toThrow(TypeError);
    expect(() => new DbProxyTransactionalEntityRepository(counterCodec(1), "", new DbProxyClient(transport))).toThrow(TypeError);

    expect("Save" in repository).toBe(false);
    expect("Enqueue" in repository).toBe(false);
    // @ts-expect-error @transactional records must not be saved outside a transaction.
    void repository.Save;
    // @ts-expect-error @transactional records must not be queued.
    void repository.Enqueue;
  });

  test("migrates older schemas in memory; the next transaction writes the current schema", async () => {
    const transport = new RecordingTransport();
    transport.stored.set("unit.write-modes/w-2", snapshot("w-2", 1, 2, 6n));
    const repository = new DbProxyTransactionalEntityRepository(counterCodec(2), "unit-process", new DbProxyClient(transport));

    const loaded = await repository.Load("w-2");
    expect(loaded).toMatchObject({ data: { value: 12 }, revision: 6n });
    expect(transport.saves).toHaveLength(0);
    const write = repository.TransactionWriteSnapshot("w-2", loaded!.data, loaded!.revision);
    expect(write.schemaVersion).toBe(2);
    expect(write.expectedRevision).toBe(6n);
  });
});

describe("ordinary repository", () => {
  test("keeps CAS saves and can also contribute transactional writes", async () => {
    const transport = new RecordingTransport();
    const repository = new DbProxyEntityRepository(counterCodec(1), "unit-process", new DbProxyClient(transport));

    await expect(repository.SaveSnapshot("o-1", { value: 1 }, 0n)).resolves.toEqual({ disposition: "applied", revision: 1n });
    expect(transport.saves[0]?.expectedRevision).toBe(0n);
    expect(transport.saves[0]?.requestId).toMatch(/^unit-process:unit\.write-modes:[0-9a-z]+:[0-9a-z]+:1$/);
    expect(repository.TransactionWrite("o-1", { value: 2 }, 1n)).toMatchObject({ expectedRevision: 1n, schemaVersion: 1 });
    // @ts-expect-error ordinary records must not be queued.
    void repository.Enqueue;
  });

  test("still writes migrated schemas back through CAS on load", async () => {
    const transport = new RecordingTransport();
    transport.stored.set("unit.write-modes/o-2", snapshot("o-2", 1, 3, 2n));
    const repository = new DbProxyEntityRepository(counterCodec(2), "unit-process", new DbProxyClient(transport));

    await expect(repository.Load("o-2")).resolves.toMatchObject({ data: { value: 13 }, revision: 3n });
    expect(transport.saves).toHaveLength(1);
    expect(transport.saves[0]).toMatchObject({ expectedRevision: 2n, schemaVersion: 2 });
  });
});

function snapshot(key: string, schemaVersion: number, value: number, revision: bigint): DbProxySnapshotEnvelope {
  return {
    record: { namespace: "unit.write-modes", key },
    schema: "unit.Counter",
    schemaVersion,
    revision,
    payload: new Uint8Array([value]),
    updatedAtUnixMs: 1n,
  };
}

/** 进程内DBProxy替身：Save执行CAS，Enqueue直接覆盖，记录全部请求。 / In-process DBProxy double: Save applies CAS, Enqueue overwrites, and every request is recorded. */
class RecordingTransport implements DbProxyTransport {
  readonly saves: DbProxySnapshotWrite[] = [];
  readonly enqueues: DbProxySnapshotWrite[] = [];
  readonly enqueueFailures: DbProxyErrorCode[] = [];
  readonly stored = new Map<string, DbProxySnapshotEnvelope>();

  load(record: DbProxyRecordKey): Promise<DbProxySnapshotEnvelope | undefined> {
    return Promise.resolve(this.stored.get(`${record.namespace}/${record.key}`));
  }

  loadMulti(records: readonly DbProxyRecordKey[]): Promise<readonly (DbProxySnapshotEnvelope | undefined)[]> {
    return Promise.all(records.map((record) => this.load(record)));
  }

  save(write: DbProxySnapshotWrite): Promise<DbProxySnapshotWriteResult> {
    this.saves.push(write);
    const id = `${write.record.namespace}/${write.record.key}`;
    const actual = this.stored.get(id)?.revision ?? 0n;
    if (write.expectedRevision !== undefined && write.expectedRevision !== actual) {
      return Promise.reject(new DbProxyRemoteError(DbProxyErrorCode.RevisionConflict, "conflict", actual));
    }
    const revision = actual + 1n;
    this.stored.set(id, { record: write.record, schema: write.schema, schemaVersion: write.schemaVersion, revision,
      payload: write.payload, updatedAtUnixMs: write.updatedAtUnixMs });
    return Promise.resolve({ disposition: "applied", revision });
  }

  saveMulti(_writes: readonly DbProxySnapshotWrite[]): Promise<readonly DbProxyBatchSnapshotWriteResult[]> {
    return Promise.reject(new Error("not used"));
  }

  enqueueSnapshot(write: DbProxySnapshotWrite): Promise<void> {
    this.enqueues.push(write);
    const failure = this.enqueueFailures.shift();
    return failure === undefined ? Promise.resolve() : Promise.reject(new DbProxyRemoteError(failure, "injected"));
  }

  enqueueMultiSnapshot(_writes: readonly DbProxySnapshotWrite[]): Promise<readonly DbProxyBatchSnapshotEnqueueResult[]> {
    return Promise.reject(new Error("not used"));
  }

  applyTransaction(_write: DbProxyTransactionalWrite): Promise<DbProxyTransactionalWriteResult> {
    return Promise.reject(new Error("not used"));
  }

  loadTransaction(_operationId: string, _record: DbProxyRecordKey): Promise<DbProxyTransactionReceipt | undefined> {
    return Promise.resolve(undefined);
  }

  applyMultiTransaction(
    ..._args: Parameters<DbProxyTransport["applyMultiTransaction"]>
  ): ReturnType<DbProxyTransport["applyMultiTransaction"]> {
    return Promise.reject(new Error("not used"));
  }

  loadMultiTransaction(
    ..._args: Parameters<DbProxyTransport["loadMultiTransaction"]>
  ): ReturnType<DbProxyTransport["loadMultiTransaction"]> {
    return Promise.resolve(undefined);
  }
}
