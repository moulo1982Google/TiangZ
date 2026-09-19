import {
  DbProxyClient,
  DbProxyErrorCode,
  DbProxyRemoteError,
  type DbProxySnapshotWrite,
  type DbProxyTransactionalRecordWrite,
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
 * `.native`的`@queued`记录契约：只能排队写入。Enqueue成功只表示Redis AOF已接收，不表示PG已落库；
 * 写入不带版本校验并按记录合并，崩溃或换服后可能回退到最近落库状态。
 *
 * Contract for `.native` `@queued` records: queued writes only. Success means Redis AOF accepted
 * the write, not that PostgreSQL committed it; writes carry no revision check and coalesce per
 * record, so a crash or ownership move may roll back to the last persisted state.
 */
export interface QueuedEntityRepository<TSnapshot, TEntity> {
  Load(key: string): Promise<VersionedEntityLoadResult<TSnapshot> | undefined>;
  Enqueue(key: string, value: TEntity): Promise<void>;
  EnqueueSnapshot(key: string, value: TSnapshot): Promise<void>;
}

/**
 * `.native`的`@transactional`记录契约：只生成事务写入记录，由业务与其他记录一起交给CommitRecords。
 * 提交结果未知时必须以原operationId和完全相同的写入集合重试。
 *
 * Contract for `.native` `@transactional` records: builds transactional writes only, which domain
 * code commits together through CommitRecords. Uncertain outcomes must retry with the original
 * operationId and identical writes.
 */
export interface TransactionalEntityRepository<TSnapshot, TEntity> {
  Load(key: string): Promise<VersionedEntityLoadResult<TSnapshot> | undefined>;
  TransactionWrite(key: string, value: TEntity, expectedRevision: bigint): DbProxyTransactionalRecordWrite;
  TransactionWriteSnapshot(key: string, value: TSnapshot, expectedRevision: bigint): DbProxyTransactionalRecordWrite;
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
  private readonly requestIds: RepositoryRequestIds;

  constructor(
    private readonly codec: VersionedEntityCodec<TSnapshot, TEntity>,
    processName: string,
    client = new DbProxyClient(new HostDbProxyTransport()),
  ) {
    this.client = client;
    this.requestIds = new RepositoryRequestIds(processName, codec.recordNamespace);
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

  /** 生成事务写入记录，不访问存储；交给CommitRecords与其他记录一起提交。
   * Builds a transactional write without storage access, for CommitRecords with other records.
   */
  TransactionWrite(key: string, value: TEntity, expectedRevision: bigint): DbProxyTransactionalRecordWrite {
    return this.TransactionWriteSnapshot(key, this.codec.Capture(value), expectedRevision);
  }

  TransactionWriteSnapshot(key: string, value: TSnapshot, expectedRevision: bigint): DbProxyTransactionalRecordWrite {
    return CreateTransactionalRecordWrite(this.codec, key, value, expectedRevision);
  }

  /** 写入已校验版本的快照；迁移使用读取到的revision，所有重试复用请求身份。
   * Writes a version-checked snapshot; migrations use the loaded revision and all retries preserve request identity.
   */
  private PersistSnapshot(key: string, value: TSnapshot, expectedRevision: bigint): Promise<VersionedEntitySaveResult> {
    const write: DbProxySnapshotWrite = {
      requestId: this.requestIds.Next(),
      record: { namespace: this.codec.recordNamespace, key },
      schema: this.codec.schema,
      schemaVersion: this.codec.schemaVersion,
      payload: this.codec.Encode(value),
      expectedRevision,
      updatedAtUnixMs: BigInt(Date.now()),
    };
    return RetryStorageUnavailable(() => this.client.Save(write));
  }
}

/**
 * `@queued`记录的DBProxy实现。读取时旧版本只在内存迁移、不回写：回写会与尚未落库的排队数据竞争，
 * 可能用较旧的PG状态替换较新的排队值；下一次Enqueue自然写入当前版本。
 *
 * DBProxy implementation for `@queued` records. Older schemas migrate in memory without write-back:
 * writing back would race queued values not yet in PostgreSQL and could replace them with older
 * state; the next Enqueue writes the current schema.
 */
export class DbProxyQueuedEntityRepository<TSnapshot, TEntity>
implements QueuedEntityRepository<TSnapshot, TEntity> {
  private readonly client: DbProxyClient;
  private readonly requestIds: RepositoryRequestIds;

  constructor(
    private readonly codec: VersionedEntityCodec<TSnapshot, TEntity>,
    processName: string,
    client = new DbProxyClient(new HostDbProxyTransport()),
  ) {
    this.client = client;
    this.requestIds = new RepositoryRequestIds(processName, codec.recordNamespace);
  }

  Load(key: string): Promise<VersionedEntityLoadResult<TSnapshot> | undefined> {
    return LoadWithoutWriteBack(this.client, this.codec, key);
  }

  async Enqueue(key: string, value: TEntity): Promise<void> {
    return this.EnqueueSnapshot(key, this.codec.Capture(value));
  }

  /** 排队写入，只发送一次、不在仓库内重试：下一次排队写本来就会取代它，重试只会在存储过载时放大负载。
   * 失败时由调用方决定是否以新值再写；编码错误以拒绝返回，不同步抛出。
   * Queues a write once with no in-repository retry: the next queued write supersedes it anyway, and retries only
   * amplify load while storage is overloaded. On failure the caller decides whether to write a newer value; codec
   * errors reject rather than throw synchronously.
   */
  async EnqueueSnapshot(key: string, value: TSnapshot): Promise<void> {
    const write: DbProxySnapshotWrite = {
      requestId: this.requestIds.Next(),
      record: { namespace: this.codec.recordNamespace, key },
      schema: this.codec.schema,
      schemaVersion: this.codec.schemaVersion,
      payload: this.codec.Encode(value),
      updatedAtUnixMs: BigInt(Date.now()),
    };
    return this.client.EnqueueSnapshot(write);
  }
}

/**
 * `@transactional`记录的DBProxy实现。不提供单独保存；读取时旧版本只在内存迁移，
 * 由下一次事务以读取到的revision写入当前版本。
 *
 * DBProxy implementation for `@transactional` records. No standalone save; older schemas migrate
 * in memory and the next transaction writes the current schema at the loaded revision.
 */
export class DbProxyTransactionalEntityRepository<TSnapshot, TEntity>
implements TransactionalEntityRepository<TSnapshot, TEntity> {
  private readonly client: DbProxyClient;

  constructor(
    private readonly codec: VersionedEntityCodec<TSnapshot, TEntity>,
    processName: string,
    client = new DbProxyClient(new HostDbProxyTransport()),
  ) {
    // 事务身份由业务的operationId决定，仓库不生成请求号；保留processName使生成工厂形状一致。
    // Transaction identity is the domain operationId; processName keeps the generated factory shape uniform.
    if (processName.length === 0) throw new TypeError("transactional entity repository processName must not be empty");
    this.client = client;
  }

  Load(key: string): Promise<VersionedEntityLoadResult<TSnapshot> | undefined> {
    return LoadWithoutWriteBack(this.client, this.codec, key);
  }

  TransactionWrite(key: string, value: TEntity, expectedRevision: bigint): DbProxyTransactionalRecordWrite {
    return this.TransactionWriteSnapshot(key, this.codec.Capture(value), expectedRevision);
  }

  TransactionWriteSnapshot(key: string, value: TSnapshot, expectedRevision: bigint): DbProxyTransactionalRecordWrite {
    return CreateTransactionalRecordWrite(this.codec, key, value, expectedRevision);
  }
}

/** 同一仓库实例内唯一、跨实例不重复的请求号。 / Request IDs unique within one repository instance and distinct across instances. */
class RepositoryRequestIds {
  private readonly prefix: string;
  private sequence = 0;

  constructor(processName: string, recordNamespace: string) {
    repositoryInstanceSequence += 1;
    if (!Number.isSafeInteger(repositoryInstanceSequence)) throw new Error("DBProxy repository instance sequence exhausted");
    this.prefix = `${processName}:${recordNamespace}:${Date.now().toString(36)}:${repositoryInstanceSequence.toString(36)}`;
  }

  Next(): string {
    this.sequence += 1;
    if (!Number.isSafeInteger(this.sequence)) throw new Error("DBProxy entity request sequence exhausted");
    return `${this.prefix}:${this.sequence.toString(36)}`;
  }
}

/** 仅对存储暂不可用做有界重试；调用方必须在所有尝试中复用同一请求身份。
 * Bounded retry for storage unavailability only; callers must reuse one request identity across attempts.
 */
async function RetryStorageUnavailable<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === SAVE_ATTEMPTS || !(error instanceof DbProxyRemoteError) || error.code !== DbProxyErrorCode.StorageUnavailable) throw error;
      // 提交结果不明确时只能复用同一requestId；更换ID可能重复覆盖。 / Ambiguous commits must retry the same requestId.
      await waitBeforeStorageRetry(attempt);
    }
  }
  throw new Error("unreachable DBProxy entity save retry state");
}

async function LoadWithoutWriteBack<TSnapshot, TEntity>(
  client: DbProxyClient,
  codec: VersionedEntityCodec<TSnapshot, TEntity>,
  key: string,
): Promise<VersionedEntityLoadResult<TSnapshot> | undefined> {
  const snapshot = await client.Load({ namespace: codec.recordNamespace, key });
  if (!snapshot) return undefined;
  const payload = MigrateVersionedEntityPayload(codec, snapshot.schema, snapshot.schemaVersion, snapshot.payload);
  return { data: codec.Decode(payload), revision: snapshot.revision, updatedAtUnixMs: snapshot.updatedAtUnixMs };
}

function CreateTransactionalRecordWrite<TSnapshot, TEntity>(
  codec: VersionedEntityCodec<TSnapshot, TEntity>,
  key: string,
  value: TSnapshot,
  expectedRevision: bigint,
): DbProxyTransactionalRecordWrite {
  if (key.length === 0) throw new TypeError("versioned entity key must not be empty");
  if (expectedRevision < 0n) throw new RangeError("expectedRevision must not be negative");
  return {
    record: { namespace: codec.recordNamespace, key },
    schema: codec.schema,
    schemaVersion: codec.schemaVersion,
    expectedRevision,
    payload: codec.Encode(value),
    updatedAtUnixMs: BigInt(Date.now()),
  };
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
