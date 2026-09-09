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
  readonly migrations?: readonly VersionedEntityMigration[];
  Capture(value: TEntity): TSnapshot;
  Encode(value: TSnapshot): Uint8Array;
  Decode(payload: Uint8Array): TSnapshot;
}

/** 模块声明的相邻版本纯转换；输入为副本，不得产生数据库或业务副作用。
 * Module-declared adjacent-version pure conversion; input is copied and no storage or business side effects are allowed.
 */
export interface VersionedEntityMigration {
  readonly fromVersion: number;
  readonly toVersion: number;
  Migrate(payload: Uint8Array): Uint8Array;
}

/** 严格执行已声明的迁移链；未知版本、重复步骤或无效输出均拒绝。
 * Executes declared migration chains strictly, rejecting unknown versions, duplicate steps and invalid outputs.
 */
export function MigrateVersionedEntityPayload<TSnapshot, TEntity>(
  codec: VersionedEntityCodec<TSnapshot, TEntity>,
  schema: string,
  version: number,
  payload: Uint8Array,
): Uint8Array {
  if (schema !== codec.schema || !Number.isSafeInteger(codec.schemaVersion) || codec.schemaVersion < 1 || !Number.isSafeInteger(version) || version < 1 || version > codec.schemaVersion) {
    throw new Error(`unsupported entity snapshot schema: ${schema}@${version}; expected ${codec.schema}@${codec.schemaVersion}`);
  }
  const steps = new Map<number, VersionedEntityMigration>();
  for (const step of codec.migrations ?? []) {
    if (!Number.isSafeInteger(step.fromVersion) || step.fromVersion < 1 || step.toVersion !== step.fromVersion + 1 || step.toVersion > codec.schemaVersion || steps.has(step.fromVersion)) {
      throw new Error("invalid entity schema migration chain");
    }
    steps.set(step.fromVersion, step);
  }
  let result: Uint8Array = Uint8Array.from(payload);
  for (let current = version; current < codec.schemaVersion; current++) {
    const step = steps.get(current);
    if (!step) throw new Error(`missing entity schema migration: ${codec.schema}@${current}`);
    result = step.Migrate(result);
    if (!(result instanceof Uint8Array)) throw new Error("entity schema migration must return Uint8Array synchronously");
    result = Uint8Array.from(result);
  }
  return result;
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
    for (let attempt = 0; attempt <= SAVE_ATTEMPTS; attempt++) {
      const snapshot = await this.client.Load({ namespace: this.codec.recordNamespace, key });
      if (!snapshot) return undefined;
      const payload = MigrateVersionedEntityPayload(this.codec, snapshot.schema, snapshot.schemaVersion, snapshot.payload);
      const data = this.codec.Decode(payload);
      if (snapshot.schemaVersion === this.codec.schemaVersion) {
        return { data, revision: snapshot.revision, updatedAtUnixMs: snapshot.updatedAtUnixMs };
      }
      if (attempt === SAVE_ATTEMPTS) break;
      try {
        await this.PersistSnapshot(key, data, snapshot.revision);
      } catch (error) {
        if (!IsVersionedEntityRevisionConflict(error)) throw error;
      }
      // 迁移与并发写入后重新读取权威回执，旧版本不能覆盖更新的数据。
      // Reload authoritative state after migration or a concurrent write; old data must never overwrite newer revisions.
    }
    throw new Error("entity schema migration retry budget exhausted");
  }

  Save(key: string, value: TEntity, expectedRevision: bigint): Promise<VersionedEntitySaveResult> {
    return this.SaveSnapshot(key, this.codec.Capture(value), expectedRevision);
  }

  async SaveSnapshot(key: string, value: TSnapshot, expectedRevision: bigint): Promise<VersionedEntitySaveResult> {
    // 新建记录由CAS保护；更新前验证存储版本，防止回滚的旧代码降级已迁移记录。
    // CAS protects creation; validate stored versions before updates so rolled-back code cannot downgrade migrated records.
    if (expectedRevision > 0n) {
      const previous = await this.client.Load({ namespace: this.codec.recordNamespace, key });
      if (previous && (previous.schema !== this.codec.schema || previous.schemaVersion !== this.codec.schemaVersion)) {
        throw new Error(`unsupported entity snapshot schema: ${previous.schema}@${previous.schemaVersion}; load and migrate before saving`);
      }
    }
    return this.PersistSnapshot(key, value, expectedRevision);
  }

  /** 写入已校验版本的快照；迁移使用读取到的revision，所有重试复用请求身份。
   * Writes a version-checked snapshot; migrations use the loaded revision and all retries preserve request identity.
   */
  private async PersistSnapshot(key: string, value: TSnapshot, expectedRevision: bigint): Promise<VersionedEntitySaveResult> {
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
    let record = inMemoryVersionedEntityRecords.get(this.RecordKey(key));
    if (!record) return undefined;
    const migrated = MigrateVersionedEntityPayload(this.codec, record.schema, record.schemaVersion, record.payload);
    const data = this.codec.Decode(migrated);
    if (record.schemaVersion !== this.codec.schemaVersion) {
      record = { ...record, payload: Uint8Array.from(this.codec.Encode(data)),
        schemaVersion: this.codec.schemaVersion, revision: record.revision + 1n, updatedAtUnixMs: BigInt(Date.now()) };
      inMemoryVersionedEntityRecords.set(this.RecordKey(key), record);
    }
    return {
      data,
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
