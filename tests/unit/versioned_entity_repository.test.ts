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

import { DbProxyEntityRepository } from "../../app/core/persistence/VersionedEntityRepository";

const codec = {
  recordNamespace: "unit-test",
  schema: "UnitTestSnapshot",
  schemaVersion: 1,
  Capture: (value: { readonly value: number }) => value,
  Encode: (value: { readonly value: number }) => new TextEncoder().encode(JSON.stringify(value)),
  Decode: (payload: Uint8Array) => JSON.parse(new TextDecoder().decode(payload)) as { value: number },
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DbProxyEntityRepository retry", () => {
  test("backs off with full jitter while preserving request identity", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const transport = new RetryTransport(2);
    const repository = new DbProxyEntityRepository(
      codec,
      "unit-test",
      new DbProxyClient(transport),
    );

    const saving = repository.SaveSnapshot("player-1", { value: 7 }, 0n);
    await Promise.resolve();
    expect(transport.requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(12);
    expect(transport.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.requests).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(24);
    expect(transport.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(saving).resolves.toEqual({ disposition: "applied", revision: 1n });
    expect(transport.requests).toHaveLength(3);
    expect(new Set(transport.requests.map((write) => write.requestId)).size).toBe(1);
  });

  test("does not retry non-storage failures", async () => {
    const transport = new RetryTransport(0, DbProxyErrorCode.RevisionConflict);
    const repository = new DbProxyEntityRepository(codec, "unit-test", new DbProxyClient(transport));
    await expect(repository.SaveSnapshot("player-2", { value: 8 }, 0n)).rejects
      .toMatchObject({ code: DbProxyErrorCode.RevisionConflict });
    expect(transport.requests).toHaveLength(1);
  });
});

class RetryTransport implements DbProxyTransport {
  readonly requests: DbProxySnapshotWrite[] = [];

  constructor(
    private remainingStorageFailures: number,
    private readonly terminalCode?: DbProxyErrorCode,
  ) {}

  load(_record: DbProxyRecordKey): Promise<DbProxySnapshotEnvelope | undefined> {
    return Promise.resolve(undefined);
  }

  loadMulti(_records: readonly DbProxyRecordKey[]): Promise<readonly (DbProxySnapshotEnvelope | undefined)[]> {
    return Promise.resolve([]);
  }

  save(write: DbProxySnapshotWrite): Promise<DbProxySnapshotWriteResult> {
    this.requests.push(write);
    if (this.terminalCode !== undefined) {
      return Promise.reject(new DbProxyRemoteError(this.terminalCode, "terminal"));
    }
    if (this.remainingStorageFailures > 0) {
      this.remainingStorageFailures -= 1;
      return Promise.reject(new DbProxyRemoteError(DbProxyErrorCode.StorageUnavailable, "unavailable"));
    }
    return Promise.resolve({ disposition: "applied", revision: 1n });
  }

  saveMulti(_writes: readonly DbProxySnapshotWrite[]): Promise<readonly DbProxyBatchSnapshotWriteResult[]> {
    return Promise.reject(new Error("not used"));
  }

  enqueueSnapshot(_write: DbProxySnapshotWrite): Promise<void> {
    return Promise.resolve();
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
