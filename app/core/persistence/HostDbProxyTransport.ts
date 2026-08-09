import {
  DbProxyErrorCode,
  DbProxyRemoteError,
  type DbProxyRecordKey,
  type DbProxySnapshotEnvelope,
  type DbProxySnapshotWrite,
  type DbProxySnapshotWriteResult,
  type DbProxyTransactionalWrite,
  type DbProxyTransactionalWriteResult,
  type DbProxyTransactionReceipt,
  type DbProxyTransport,
  type DbProxyWriteDisposition,
} from "@tiangz/dbproxy-sdk";

interface HostDbProxyError {
  readonly code: number;
  readonly message: string;
  readonly actualRevision?: string;
}

interface HostSnapshot {
  readonly namespace: string;
  readonly key: string;
  readonly schema: string;
  readonly schemaVersion: number;
  readonly revision: string;
  readonly payload: readonly number[] | Uint8Array;
  readonly updatedAtUnixMs: string;
}

interface HostLoadResponse {
  readonly snapshot?: HostSnapshot;
  readonly error?: HostDbProxyError;
}

interface HostWriteResponse {
  readonly disposition?: DbProxyWriteDisposition;
  readonly revision?: string;
  readonly error?: HostDbProxyError;
}

interface HostEnqueueResponse {
  readonly accepted: boolean;
  readonly error?: HostDbProxyError;
}

interface HostTransactionResponse {
  readonly disposition?: DbProxyWriteDisposition;
  readonly newRevision?: string;
  readonly result: readonly number[] | Uint8Array;
  readonly error?: HostDbProxyError;
}

interface HostTransactionReceipt {
  readonly operationId: string;
  readonly namespace: string;
  readonly key: string;
  readonly newRevision: string;
  readonly result: readonly number[] | Uint8Array;
}

interface HostLoadTransactionResponse {
  readonly receipt?: HostTransactionReceipt;
  readonly error?: HostDbProxyError;
}

interface HostDbProxyApi {
  load(namespace: string, key: string): Promise<HostLoadResponse>;
  save(request: {
    readonly requestId: string;
    readonly namespace: string;
    readonly key: string;
    readonly schema: string;
    readonly schemaVersion: number;
    readonly payload: Uint8Array;
    readonly expectedRevision?: string;
    readonly updatedAtUnixMs: string;
  }): Promise<HostWriteResponse>;
  enqueueSnapshot(request: {
    readonly requestId: string;
    readonly namespace: string;
    readonly key: string;
    readonly schema: string;
    readonly schemaVersion: number;
    readonly payload: Uint8Array;
    readonly updatedAtUnixMs: string;
  }): Promise<HostEnqueueResponse>;
  applyTransaction(request: {
    readonly operationId: string;
    readonly namespace: string;
    readonly key: string;
    readonly schema: string;
    readonly schemaVersion: number;
    readonly expectedRevision: string;
    readonly payload: Uint8Array;
    readonly result: Uint8Array;
    readonly updatedAtUnixMs: string;
  }): Promise<HostTransactionResponse>;
  loadTransaction(
    operationId: string,
    namespace: string,
    key: string,
  ): Promise<HostLoadTransactionResponse>;
}

/**
 * 把运行时无关的DBProxy SDK接到Rust Host连接池。该类只做传输转换，
 * 不生成幂等ID、不重试业务冲突，也不理解任何玩家数据。Rust会在连接边界
 * 不确定时使用同一幂等ID重连一次；业务不得在外层重试时更换ID。
 *
 * Connects the runtime-neutral DBProxy SDK to the Rust Host pool. This class
 * only converts transport values: it does not invent idempotency IDs, retry
 * business conflicts, or understand player data. Rust may reconnect once with
 * the same ID after an ambiguous connection failure; outer retries must not
 * replace that ID.
 */
export class HostDbProxyTransport implements DbProxyTransport {
  private readonly host: HostDbProxyApi;

  constructor(host: HostDbProxyApi = requireHostDbProxyApi()) {
    this.host = host;
  }

  async load(record: DbProxyRecordKey): Promise<DbProxySnapshotEnvelope | undefined> {
    const response = await this.host.load(record.namespace, record.key);
    throwRemoteError(response.error);
    const snapshot = response.snapshot;
    if (!snapshot) return undefined;
    return {
      record: { namespace: snapshot.namespace, key: snapshot.key },
      schema: snapshot.schema,
      schemaVersion: snapshot.schemaVersion,
      revision: parseUint64(snapshot.revision, "snapshot.revision"),
      payload: Uint8Array.from(snapshot.payload),
      updatedAtUnixMs: parseUint64(snapshot.updatedAtUnixMs, "snapshot.updatedAtUnixMs"),
    };
  }

  async save(write: DbProxySnapshotWrite): Promise<DbProxySnapshotWriteResult> {
    const response = await this.host.save({
      requestId: write.requestId,
      namespace: write.record.namespace,
      key: write.record.key,
      schema: write.schema,
      schemaVersion: write.schemaVersion,
      payload: write.payload,
      expectedRevision: write.expectedRevision?.toString(),
      updatedAtUnixMs: write.updatedAtUnixMs.toString(),
    });
    throwRemoteError(response.error);
    return {
      disposition: requireDisposition(response.disposition),
      revision: parseUint64(response.revision, "save.revision"),
    };
  }

  async enqueueSnapshot(write: DbProxySnapshotWrite): Promise<void> {
    const response = await this.host.enqueueSnapshot({
      requestId: write.requestId,
      namespace: write.record.namespace,
      key: write.record.key,
      schema: write.schema,
      schemaVersion: write.schemaVersion,
      payload: write.payload,
      updatedAtUnixMs: write.updatedAtUnixMs.toString(),
    });
    throwRemoteError(response.error);
    if (!response.accepted) throw new Error("DBProxy rejected snapshot enqueue without an error");
  }

  async applyTransaction(
    write: DbProxyTransactionalWrite,
  ): Promise<DbProxyTransactionalWriteResult> {
    const response = await this.host.applyTransaction({
      operationId: write.operationId,
      namespace: write.record.namespace,
      key: write.record.key,
      schema: write.schema,
      schemaVersion: write.schemaVersion,
      expectedRevision: write.expectedRevision.toString(),
      payload: write.payload,
      result: write.result,
      updatedAtUnixMs: write.updatedAtUnixMs.toString(),
    });
    throwRemoteError(response.error);
    return {
      disposition: requireDisposition(response.disposition),
      newRevision: parseUint64(response.newRevision, "transaction.newRevision"),
      result: Uint8Array.from(response.result),
    };
  }

  async loadTransaction(
    operationId: string,
    record: DbProxyRecordKey,
  ): Promise<DbProxyTransactionReceipt | undefined> {
    const response = await this.host.loadTransaction(
      operationId,
      record.namespace,
      record.key,
    );
    throwRemoteError(response.error);
    const receipt = response.receipt;
    if (!receipt) return undefined;
    return {
      operationId: receipt.operationId,
      record: { namespace: receipt.namespace, key: receipt.key },
      newRevision: parseUint64(receipt.newRevision, "transactionReceipt.newRevision"),
      result: Uint8Array.from(receipt.result),
    };
  }
}

function requireHostDbProxyApi(): HostDbProxyApi {
  const host = (globalThis as typeof globalThis & { __hostDbProxy?: HostDbProxyApi })
    .__hostDbProxy;
  if (!host) throw new Error("Rust Host did not install __hostDbProxy");
  return host;
}

function throwRemoteError(error: HostDbProxyError | undefined): void {
  if (!error) return;
  throw new DbProxyRemoteError(
    error.code as DbProxyErrorCode,
    error.message,
    error.actualRevision === undefined
      ? undefined
      : parseUint64(error.actualRevision, "error.actualRevision"),
  );
}

function parseUint64(value: string | undefined, name: string): bigint {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${name} must be a uint64 decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed > 0xffff_ffff_ffff_ffffn) throw new RangeError(`${name} exceeds uint64`);
  return parsed;
}

function requireDisposition(
  value: DbProxyWriteDisposition | undefined,
): DbProxyWriteDisposition {
  if (value !== "applied" && value !== "duplicate") {
    throw new TypeError("DBProxy response has no valid disposition");
  }
  return value;
}
