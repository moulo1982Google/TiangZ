import {
  DbProxyClient,
  DbProxyErrorCode,
  DbProxyRemoteError,
  type DbProxySnapshotWrite,
} from "@tiangz/dbproxy-sdk";
import { HostDbProxyTransport, IsHostDbProxyAvailable } from "./HostDbProxyTransport";

const SAVE_ATTEMPTS = 3;
const SAVE_RETRY_BASE_DELAY_MS = 25;
const SAVE_RETRY_MAX_DELAY_MS = 200;
let repositoryInstanceSequence = 0;

/** `.native`生成Codec所遵循的稳定契约；DBProxy不会看到TEntity或TSnapshot。 / Stable contract for `.native` codecs; DBProxy never sees TEntity or TSnapshot. */
export interface VersionedEntityCodec<TSnapshot, TEntity> {
  readonly recordNamespace: string;
  readonly schema: string;
  readonly schemaVersion: number;
  Capture(value: TEntity): TSnapshot;
  Encode(value: TSnapshot): Uint8Array;
  Decode(payload: Uint8Array): TSnapshot;
}

export interface VersionedEntityLoadResult<TSnapshot> {
  readonly data: TSnapshot;
  readonly revision: bigint;
  readonly updatedAtUnixMs: bigint;
}

export interface VersionedEntitySaveResult {
  readonly disposition: "applied" | "duplicate";
  readonly revision: bigint;
}

/** 引擎和外置模块均可使用的运行时中立CAS仓库契约。/ Runtime-neutral CAS repository contract usable by engine and external modules. */
export interface VersionedEntityRepository<TSnapshot, TEntity> {
  Load(key: string): Promise<VersionedEntityLoadResult<TSnapshot> | undefined>;
  Save(key: string, value: TEntity, expectedRevision: bigint): Promise<VersionedEntitySaveResult>;
  SaveSnapshot(key: string, value: TSnapshot, expectedRevision: bigint): Promise<VersionedEntitySaveResult>;
}

/**
 * 普通单Entity快照的通用Repository。它只处理schema校验、revision CAS和同ID重试；
 * 聚合查询、索引、跨玩家事务和恢复生命周期仍由领域Repository负责。
 *
 * Generic repository for one ordinary Entity snapshot. It handles schema
 * checks, revision CAS, and same-ID retry only. Queries, indexes, cross-player
 * transactions, and restoration lifecycle remain domain-repository concerns.
 */
export class DbProxyEntityRepository<TSnapshot, TEntity>
implements VersionedEntityRepository<TSnapshot, TEntity> {
  private readonly client: DbProxyClient;
  private readonly requestPrefix: string;
  private requestSequence = 0;

  constructor(
    private readonly codec: VersionedEntityCodec<TSnapshot, TEntity>,
    processName: string,
    client = new DbProxyClient(new HostDbProxyTransport()),
  ) {
    this.client = client;
    repositoryInstanceSequence += 1;
    if (!Number.isSafeInteger(repositoryInstanceSequence)) throw new Error("DBProxy repository instance sequence exhausted");
    this.requestPrefix = `${processName}:${codec.recordNamespace}:${Date.now().toString(36)}:${repositoryInstanceSequence.toString(36)}`;
  }

  async Load(key: string): Promise<VersionedEntityLoadResult<TSnapshot> | undefined> {
    const snapshot = await this.client.Load({ namespace: this.codec.recordNamespace, key });
    if (!snapshot) return undefined;
    if (snapshot.schema !== this.codec.schema || snapshot.schemaVersion !== this.codec.schemaVersion) {
      throw new Error(`unsupported entity snapshot schema: ${snapshot.schema}@${snapshot.schemaVersion}; expected ${this.codec.schema}@${this.codec.schemaVersion}`);
    }
    return {
      data: this.codec.Decode(snapshot.payload),
      revision: snapshot.revision,
      updatedAtUnixMs: snapshot.updatedAtUnixMs,
    };
  }

  Save(key: string, value: TEntity, expectedRevision: bigint): Promise<VersionedEntitySaveResult> {
    return this.SaveSnapshot(key, this.codec.Capture(value), expectedRevision);
  }

  async SaveSnapshot(key: string, value: TSnapshot, expectedRevision: bigint): Promise<VersionedEntitySaveResult> {
    this.requestSequence += 1;
    if (!Number.isSafeInteger(this.requestSequence)) throw new Error("DBProxy entity request sequence exhausted");
    const write: DbProxySnapshotWrite = {
      requestId: `${this.requestPrefix}:${this.requestSequence.toString(36)}`,
      record: { namespace: this.codec.recordNamespace, key },
      schema: this.codec.schema,
      schemaVersion: this.codec.schemaVersion,
      payload: this.codec.Encode(value),
      expectedRevision,
      updatedAtUnixMs: BigInt(Date.now()),
    };
    for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt += 1) {
      try {
        return await this.client.Save(write);
      } catch (error) {
        if (attempt === SAVE_ATTEMPTS || !(error instanceof DbProxyRemoteError) || error.code !== DbProxyErrorCode.StorageUnavailable) throw error;
        // 提交结果不明确时只能复用同一requestId；更换ID可能重复覆盖。 / Ambiguous commits must retry the same requestId.
        await waitBeforeStorageRetry(attempt);
      }
    }
    throw new Error("unreachable DBProxy entity save retry state");
  }
}

/** 使用墙钟指数退避与full jitter，避免同一故障窗口内的Entity同步重试。 / Uses wall-clock exponential backoff with full jitter so Entities do not retry in lockstep during one outage. */
async function waitBeforeStorageRetry(failedAttempt: number): Promise<void> {
  const ceiling = Math.min(
    SAVE_RETRY_MAX_DELAY_MS,
    SAVE_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, failedAttempt - 1)),
  );
  const delayMs = Math.floor(Math.random() * (ceiling + 1));
  if (delayMs === 0) return;
  const hostSleep = (globalThis as unknown as {
    __hostSleep?: (milliseconds: number) => Promise<void>;
  }).__hostSleep;
  if (hostSleep) {
    await hostSleep(delayMs);
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

interface InMemoryVersionedEntityRecord {
  readonly schema: string;
  readonly schemaVersion: number;
  readonly revision: bigint;
  readonly payload: Uint8Array;
  readonly updatedAtUnixMs: bigint;
}

const inMemoryVersionedEntityRecords = new Map<string, InMemoryVersionedEntityRecord>();

/**
 * 供测试和明确不使用DBProxy的运行时使用的进程内实现；值仍穿过Codec边界并执行严格CAS。
 * Process-local implementation for tests and runtimes that deliberately run
 * without DBProxy. Values still cross the codec boundary and use strict CAS,
 * so enabling DBProxy does not change repository semantics.
 */
export class InMemoryVersionedEntityRepository<TSnapshot, TEntity>
implements VersionedEntityRepository<TSnapshot, TEntity> {
  constructor(private readonly codec: VersionedEntityCodec<TSnapshot, TEntity>) {}

  async Load(key: string): Promise<VersionedEntityLoadResult<TSnapshot> | undefined> {
    const record = inMemoryVersionedEntityRecords.get(this.RecordKey(key));
    if (!record) return undefined;
    this.RequireSchema(record);
    return {
      data: this.codec.Decode(Uint8Array.from(record.payload)),
      revision: record.revision,
      updatedAtUnixMs: record.updatedAtUnixMs,
    };
  }

  Save(key: string, value: TEntity, expectedRevision: bigint): Promise<VersionedEntitySaveResult> {
    return this.SaveSnapshot(key, this.codec.Capture(value), expectedRevision);
  }

  async SaveSnapshot(
    key: string,
    value: TSnapshot,
    expectedRevision: bigint,
  ): Promise<VersionedEntitySaveResult> {
    if (expectedRevision < 0n) throw new RangeError("expectedRevision must not be negative");
    const recordKey = this.RecordKey(key);
    const previous = inMemoryVersionedEntityRecords.get(recordKey);
    if (previous) this.RequireSchema(previous);
    const actualRevision = previous?.revision ?? 0n;
    if (actualRevision !== expectedRevision) {
      throw new DbProxyRemoteError(
        DbProxyErrorCode.RevisionConflict,
        `revision conflict for ${this.codec.recordNamespace}/${key}`,
        actualRevision,
      );
    }
    const revision = actualRevision + 1n;
    inMemoryVersionedEntityRecords.set(recordKey, {
      schema: this.codec.schema,
      schemaVersion: this.codec.schemaVersion,
      revision,
      payload: Uint8Array.from(this.codec.Encode(value)),
      updatedAtUnixMs: BigInt(Date.now()),
    });
    return { disposition: "applied", revision };
  }

  private RecordKey(key: string): string {
    if (key.length === 0) throw new TypeError("versioned entity key must not be empty");
    return `${this.codec.recordNamespace}\u0000${key}`;
  }

  private RequireSchema(record: InMemoryVersionedEntityRecord): void {
    if (record.schema !== this.codec.schema || record.schemaVersion !== this.codec.schemaVersion) {
      throw new Error(`unsupported entity snapshot schema: ${record.schema}@${record.schemaVersion}; expected ${this.codec.schema}@${this.codec.schemaVersion}`);
    }
  }
}

/** Host桥存在时选择持久DBProxy，否则选择严格的进程内存储。/ Selects durable DBProxy storage when the Host bridge exists, otherwise strict process-local storage. */
export function CreateVersionedEntityRepository<TSnapshot, TEntity>(
  codec: VersionedEntityCodec<TSnapshot, TEntity>,
  ownerId: string,
): VersionedEntityRepository<TSnapshot, TEntity> {
  if (ownerId.length === 0) throw new TypeError("versioned entity repository ownerId must not be empty");
  return IsHostDbProxyAvailable()
    ? new DbProxyEntityRepository(codec, ownerId)
    : new InMemoryVersionedEntityRepository(codec);
}

/** 让领域代码无需依赖DBProxy SDK即可识别并重试乐观并发。/ Lets domain code retry optimistic concurrency without depending on the DBProxy SDK. */
export function IsVersionedEntityRevisionConflict(error: unknown): boolean {
  return error instanceof DbProxyRemoteError && error.code === DbProxyErrorCode.RevisionConflict;
}
