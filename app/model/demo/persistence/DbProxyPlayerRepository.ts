import {
  DbProxyClient,
  DbProxyErrorCode,
  DbProxyRemoteError,
  type DbProxySnapshotWrite,
  type DbProxyTransactionalWrite,
} from "@tiangz/dbproxy-sdk";
import {
  HostDbProxyTransport,
  type ProcessConfig,
} from "../../../core/public";
import {
  DecodePlayerSaveData,
  EncodePlayerSaveData,
  PLAYER_PERSISTENCE_SCHEMA,
  PLAYER_PERSISTENCE_SCHEMA_VERSION,
} from "./PlayerPersistenceCodec";
import {
  InMemoryPlayerRepository,
  type PlayerLoadResult,
  type PlayerRepository,
  type PlayerSaveData,
  type PlayerSaveResult,
  type PlayerTransactionReceipt,
  type PlayerTransactionResult,
  type PlayerTransactionWrite,
} from "./PlayerRepository";

const PLAYER_NAMESPACE = "player";
const SAVE_ATTEMPTS = 3;

/** Demo玩家Repository：业务拥有Payload，DBProxy只负责版本、幂等和可靠存储。 / Demo player Repository: business owns the payload while DBProxy owns revision, idempotency, and durable storage. */
export class DbProxyPlayerRepository implements PlayerRepository {
  private readonly client: DbProxyClient;
  private readonly requestPrefix: string;
  private requestSequence = 0;

  constructor(processName: string, client = new DbProxyClient(new HostDbProxyTransport())) {
    this.client = client;
    this.requestPrefix = `${processName}:player:${Date.now().toString(36)}`;
  }

  async Load(characterId: bigint): Promise<PlayerLoadResult | undefined> {
    const key = keyOf(characterId);
    const snapshot = await this.client.Load({ namespace: PLAYER_NAMESPACE, key });
    if (!snapshot) return undefined;
    if (
      snapshot.schema !== PLAYER_PERSISTENCE_SCHEMA ||
      snapshot.schemaVersion !== PLAYER_PERSISTENCE_SCHEMA_VERSION
    ) {
      throw new Error(
        `unsupported player snapshot schema: ${snapshot.schema}@${snapshot.schemaVersion}`,
      );
    }
    const data = DecodePlayerSaveData(snapshot.payload);
    if (data.player.characterId !== characterId) {
      throw new Error(`player snapshot key mismatch: key=${key}, payload=${data.player.characterId}`);
    }
    return {
      data,
      revision: snapshot.revision,
      updatedAtUnixMs: snapshot.updatedAtUnixMs,
    };
  }

  /**
   * 每次逻辑保存只生成一次requestId；Rust连接层若重连会原样重放该ID。
   * 调用方不得捕获失败后自行构造另一个Repository实例重复提交。
   *
   * Generates one requestId per logical save. The Rust connection layer replays
   * the same ID after reconnect. Callers must not retry through a newly-created
   * Repository instance after swallowing an ambiguous failure.
   */
  async Save(data: PlayerSaveData, expectedRevision: bigint): Promise<PlayerSaveResult> {
    this.requestSequence += 1;
    if (!Number.isSafeInteger(this.requestSequence)) {
      throw new Error("DBProxy player save request sequence exhausted");
    }
    const write: DbProxySnapshotWrite = {
      requestId: `${this.requestPrefix}:${this.requestSequence.toString(36)}`,
      record: { namespace: PLAYER_NAMESPACE, key: keyOf(data.player.characterId) },
      schema: PLAYER_PERSISTENCE_SCHEMA,
      schemaVersion: PLAYER_PERSISTENCE_SCHEMA_VERSION,
      payload: EncodePlayerSaveData(data),
      expectedRevision,
      updatedAtUnixMs: BigInt(Date.now()),
    };
    for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt += 1) {
      try {
        return await this.client.Save(write);
      } catch (error) {
        if (
          attempt === SAVE_ATTEMPTS ||
          !(error instanceof DbProxyRemoteError) ||
          error.code !== DbProxyErrorCode.StorageUnavailable
        ) {
          throw error;
        }
        // PostgreSQL可能已经提交而Redis同步失败；必须复用同一requestId确认结果。
        // PostgreSQL may have committed before Redis sync failed; reuse the same requestId.
      }
    }
    throw new Error("unreachable DBProxy save retry state");
  }

  /**
   * 关键业务只提交一次完整的操作后快照；网络重试始终复用业务提供的operationId。
   * DBProxy在PostgreSQL事务中同时保存快照和结果回执，Redis只负责提交后的缓存同步。
   *
   * Critical business operations commit one complete post-operation snapshot.
   * Network retries always reuse the business operationId. DBProxy stores the
   * snapshot and receipt in one PostgreSQL transaction; Redis is updated later.
   */
  async ApplyTransaction(
    write: PlayerTransactionWrite,
    expectedRevision: bigint,
  ): Promise<PlayerTransactionResult> {
    const request: DbProxyTransactionalWrite = {
      operationId: write.operationId,
      record: { namespace: PLAYER_NAMESPACE, key: keyOf(write.data.player.characterId) },
      schema: PLAYER_PERSISTENCE_SCHEMA,
      schemaVersion: PLAYER_PERSISTENCE_SCHEMA_VERSION,
      expectedRevision,
      payload: EncodePlayerSaveData(write.data),
      result: write.result.slice(),
      updatedAtUnixMs: BigInt(Date.now()),
    };
    for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.client.ApplyTransaction(request);
        return {
          disposition: result.disposition,
          revision: result.newRevision,
          result: result.result.slice(),
        };
      } catch (error) {
        if (
          attempt === SAVE_ATTEMPTS ||
          !(error instanceof DbProxyRemoteError) ||
          error.code !== DbProxyErrorCode.StorageUnavailable
        ) {
          throw error;
        }
        // 事务可能已经提交但ACK丢失；只能复用相同operationId重试。
        // The transaction may have committed before its ACK was lost; retry only with the same operationId.
      }
    }
    throw new Error("unreachable DBProxy transaction retry state");
  }

  async LoadTransaction(
    characterId: bigint,
    operationId: string,
  ): Promise<PlayerTransactionReceipt | undefined> {
    const receipt = await this.client.LoadTransaction(operationId, {
      namespace: PLAYER_NAMESPACE,
      key: keyOf(characterId),
    });
    return receipt
      ? { revision: receipt.newRevision, result: receipt.result.slice() }
      : undefined;
  }
}

/** MapHost工厂的唯一Repository选择点；业务代码不得到处判断DBProxy配置。 / Sole Repository selection point for MapHost factories; gameplay code must not branch on DBProxy configuration. */
const inMemoryRepositories = new Map<string, InMemoryPlayerRepository>();

export function CreatePlayerRepository(process: ProcessConfig): PlayerRepository {
  if (process.persistence?.dbProxy) return new DbProxyPlayerRepository(process.name);
  // 同一V8内的多个MapHost共享内存Repository；跨V8迁移由PlayerPersistenceComponent交接快照。
  // MapHosts in one V8 share the in-memory Repository; cross-V8 transfer uses
  // the snapshot handoff owned by PlayerPersistenceComponent.
  let repository = inMemoryRepositories.get(process.name);
  if (!repository) {
    repository = new InMemoryPlayerRepository();
    inMemoryRepositories.set(process.name, repository);
  }
  return repository;
}

function keyOf(characterId: bigint): string {
  if (characterId <= 0n) throw new Error(`player characterId must be positive: ${characterId}`);
  return characterId.toString(10);
}
