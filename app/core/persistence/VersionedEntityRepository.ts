import {
  DbProxyClient,
  DbProxyErrorCode,
  DbProxyRemoteError,
  type DbProxySnapshotWrite,
} from "@tiangz/dbproxy-sdk";
import { HostDbProxyTransport } from "./HostDbProxyTransport";

const SAVE_ATTEMPTS = 3;
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

/**
 * 普通单Entity快照的通用Repository。它只处理schema校验、revision CAS和同ID重试；
 * 聚合查询、索引、跨玩家事务和恢复生命周期仍由领域Repository负责。
 *
 * Generic repository for one ordinary Entity snapshot. It handles schema
 * checks, revision CAS, and same-ID retry only. Queries, indexes, cross-player
 * transactions, and restoration lifecycle remain domain-repository concerns.
 */
export class DbProxyEntityRepository<TSnapshot, TEntity> {
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
      }
    }
    throw new Error("unreachable DBProxy entity save retry state");
  }
}
