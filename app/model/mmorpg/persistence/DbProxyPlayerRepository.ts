import {
  DbProxyClient,
  DbProxyErrorCode,
  DbProxyRemoteError,
  type DbProxyMultiTransactionalWrite,
  type DbProxySnapshotWrite,
  type DbProxyTransactionalRecordWrite,
  type DbProxyTransactionalWrite,
} from "@tiangz/dbproxy-sdk";
import { HostDbProxyTransport, type ProcessConfig } from "../../../core/public";
import {
  DecodePlayerDomainData,
  EncodePlayerDomainData,
  PLAYER_DOMAIN_SCHEMAS,
  PLAYER_DOMAIN_SCHEMA_VERSION,
} from "./PlayerPersistenceCodec";
import {
  CharacterIdOfDomainData,
  EmptyPlayerPersistenceRevisions,
  InMemoryPlayerRepository,
  PLAYER_PERSISTENCE_DOMAINS,
  type PlayerDomainSaveData,
  type PlayerLoadResult,
  type PlayerMultiTransactionReceipt,
  type PlayerMultiTransactionResult,
  type PlayerMultiTransactionWrite,
  type PlayerPersistenceDomain,
  type PlayerRepository,
  type PlayerSaveResult,
  type PlayerTransactionReceipt,
  type PlayerTransactionRecordKey,
  type PlayerTransactionRecordWrite,
  type PlayerTransactionResult,
  type PlayerTransactionRevision,
  type PlayerTransactionWrite,
} from "./PlayerRepository";

const PLAYER_NAMESPACE = "player";
const SAVE_ATTEMPTS = 3;

/** 领域化玩家Repository：业务拥有Payload，DBProxy拥有每个领域的revision、幂等和可靠存储。 / Domain-aware player Repository: business owns payloads while DBProxy owns per-domain revisions, idempotency, and durable storage. */
export class DbProxyPlayerRepository implements PlayerRepository {
  private readonly client: DbProxyClient;
  private readonly requestPrefix: string;
  private requestSequence = 0;

  constructor(processName: string, client = new DbProxyClient(new HostDbProxyTransport())) {
    this.client = client;
    this.requestPrefix = `${processName}:player-domain:${Date.now().toString(36)}`;
  }

  async Load(characterId: bigint): Promise<PlayerLoadResult | undefined> {
    requireCharacterId(characterId);
    const snapshots = await Promise.all(PLAYER_PERSISTENCE_DOMAINS.map((domain) =>
      this.client.Load(recordOf(characterId, domain))
    ));
    if (snapshots.every((snapshot) => !snapshot)) return undefined;
    const data = {} as {
      inventory?: PlayerLoadResult["data"]["inventory"];
      progression?: PlayerLoadResult["data"]["progression"];
      quest?: PlayerLoadResult["data"]["quest"];
      runtime?: PlayerLoadResult["data"]["runtime"];
      wallet?: PlayerLoadResult["data"]["wallet"];
    };
    const revisions = EmptyPlayerPersistenceRevisions();
    const updatedAtUnixMs = EmptyPlayerPersistenceRevisions();
    for (let index = 0; index < PLAYER_PERSISTENCE_DOMAINS.length; index += 1) {
      const domain = PLAYER_PERSISTENCE_DOMAINS[index];
      const snapshot = snapshots[index];
      if (!snapshot) continue;
      if (snapshot.schema !== PLAYER_DOMAIN_SCHEMAS[domain] || snapshot.schemaVersion !== PLAYER_DOMAIN_SCHEMA_VERSION) {
        throw new Error(`unsupported player ${domain} schema: ${snapshot.schema}@${snapshot.schemaVersion}`);
      }
      const decoded = DecodePlayerDomainData(domain, snapshot.payload);
      if (CharacterIdOfDomainData(domain, decoded) !== characterId) {
        throw new Error(`player ${domain} key mismatch: key=${characterId}`);
      }
      if (domain === "inventory") data.inventory = decoded as PlayerLoadResult["data"]["inventory"];
      else if (domain === "progression") data.progression = decoded as PlayerLoadResult["data"]["progression"];
      else if (domain === "quest") data.quest = decoded as PlayerLoadResult["data"]["quest"];
      else if (domain === "runtime") data.runtime = decoded as PlayerLoadResult["data"]["runtime"];
      else data.wallet = decoded as PlayerLoadResult["data"]["wallet"];
      revisions[domain] = snapshot.revision;
      updatedAtUnixMs[domain] = snapshot.updatedAtUnixMs;
    }
    return { data, revisions, updatedAtUnixMs };
  }

  /** 每个逻辑领域保存只生成一次requestId；连接重试必须原样复用。 / Generates one requestId per logical domain save and reuses it across connection retries. */
  async SaveDomain(
    domain: PlayerPersistenceDomain,
    data: PlayerDomainSaveData,
    expectedRevision: bigint,
  ): Promise<PlayerSaveResult> {
    const characterId = CharacterIdOfDomainData(domain, data);
    const write: DbProxySnapshotWrite = {
      requestId: this.NextRequestId(domain),
      record: recordOf(characterId, domain),
      schema: PLAYER_DOMAIN_SCHEMAS[domain],
      schemaVersion: PLAYER_DOMAIN_SCHEMA_VERSION,
      payload: EncodePlayerDomainData(domain, data),
      expectedRevision,
      updatedAtUnixMs: BigInt(Date.now()),
    };
    const saved = await retryStorageUnavailable(() => this.client.Save(write));
    return { disposition: saved.disposition, domain, revision: saved.revision };
  }

  /** 一条记录走单记录事务，多条记录走DBProxy多记录事务；两条路径共享相同领域回执。 / Uses a single-record transaction for one record and a DBProxy multi-record transaction otherwise, with one domain receipt shape. */
  async ApplyTransaction(write: PlayerTransactionWrite): Promise<PlayerTransactionResult> {
    const records = normalizeWrites(write.records);
    if (records.length === 1) {
      const entry = records[0];
      const characterId = CharacterIdOfDomainData(entry.domain, entry.data);
      const request: DbProxyTransactionalWrite = {
        operationId: write.operationId,
        ...toDbWrite(entry),
        result: write.result.slice(),
      };
      const committed = await retryStorageUnavailable(() => this.client.ApplyTransaction(request));
      return {
        disposition: committed.disposition,
        revisions: [{ characterId, domain: entry.domain, revision: committed.newRevision }],
        result: committed.result.slice(),
      };
    }
    const request: DbProxyMultiTransactionalWrite = {
      operationId: write.operationId,
      writes: records.map(toDbWrite),
      result: write.result.slice(),
    };
    const committed = await retryStorageUnavailable(() => this.client.ApplyMultiTransaction(request));
    return {
      disposition: committed.disposition,
      revisions: committed.records.map((record) => fromDbRevision(record.record.key, record.newRevision)),
      result: committed.result.slice(),
    };
  }

  async LoadTransaction(
    records: readonly PlayerTransactionRecordKey[],
    operationId: string,
  ): Promise<PlayerTransactionReceipt | undefined> {
    const normalized = normalizeKeys(records);
    if (normalized.length === 1) {
      const key = normalized[0];
      const receipt = await this.client.LoadTransaction(operationId, recordOf(key.characterId, key.domain));
      return receipt
        ? {
          revisions: [{ characterId: key.characterId, domain: key.domain, revision: receipt.newRevision }],
          result: receipt.result.slice(),
        }
        : undefined;
    }
    const receipt = await this.client.LoadMultiTransaction(
      operationId,
      normalized.map((key) => recordOf(key.characterId, key.domain)),
    );
    return receipt
      ? {
        revisions: receipt.records.map((record) => fromDbRevision(record.record.key, record.newRevision)),
        result: receipt.result.slice(),
      }
      : undefined;
  }

  async ApplyMultiTransaction(write: PlayerMultiTransactionWrite): Promise<PlayerMultiTransactionResult> {
    if (write.records.length < 2) throw new Error("player multi transaction requires at least two records");
    return this.ApplyTransaction(write);
  }

  async LoadMultiTransaction(
    records: readonly PlayerTransactionRecordKey[],
    operationId: string,
  ): Promise<PlayerMultiTransactionReceipt | undefined> {
    if (records.length < 2) throw new Error("player multi transaction requires at least two records");
    return this.LoadTransaction(records, operationId);
  }

  private NextRequestId(domain: PlayerPersistenceDomain): string {
    this.requestSequence += 1;
    if (!Number.isSafeInteger(this.requestSequence)) throw new Error("DBProxy player save request sequence exhausted");
    return `${this.requestPrefix}:${domain}:${this.requestSequence.toString(36)}`;
  }
}

/** MapHost工厂的唯一Repository选择点；业务不得分散判断DBProxy配置。 / Sole Repository selection point; gameplay must not branch on DBProxy configuration. */
const inMemoryRepositories = new Map<string, InMemoryPlayerRepository>();

export function CreatePlayerRepository(process: ProcessConfig): PlayerRepository {
  if (process.persistence?.dbProxy) return new DbProxyPlayerRepository(process.name);
  let repository = inMemoryRepositories.get(process.name);
  if (!repository) {
    repository = new InMemoryPlayerRepository();
    inMemoryRepositories.set(process.name, repository);
  }
  return repository;
}

function toDbWrite(entry: PlayerTransactionRecordWrite): DbProxyTransactionalRecordWrite {
  const characterId = CharacterIdOfDomainData(entry.domain, entry.data);
  return {
    record: recordOf(characterId, entry.domain),
    schema: PLAYER_DOMAIN_SCHEMAS[entry.domain],
    schemaVersion: PLAYER_DOMAIN_SCHEMA_VERSION,
    expectedRevision: entry.expectedRevision,
    payload: EncodePlayerDomainData(entry.domain, entry.data),
    updatedAtUnixMs: BigInt(Date.now()),
  };
}

function recordOf(characterId: bigint, domain: PlayerPersistenceDomain): { namespace: string; key: string } {
  requireCharacterId(characterId);
  return { namespace: PLAYER_NAMESPACE, key: `${characterId.toString(10)}:${domain}` };
}

function fromDbRevision(key: string, revision: bigint): PlayerTransactionRevision {
  const match = /^(\d+):(inventory|progression|quest|runtime|wallet)$/.exec(key);
  if (!match) throw new Error(`invalid player domain record key from DBProxy: ${key}`);
  return { characterId: BigInt(match[1]), domain: match[2] as PlayerPersistenceDomain, revision };
}

function normalizeWrites(records: readonly PlayerTransactionRecordWrite[]): readonly PlayerTransactionRecordWrite[] {
  if (records.length === 0) throw new Error("player transaction requires at least one record");
  const sorted = [...records].sort((left, right) => compareKeys(
    CharacterIdOfDomainData(left.domain, left.data), left.domain,
    CharacterIdOfDomainData(right.domain, right.data), right.domain,
  ));
  for (let index = 0; index < sorted.length; index += 1) {
    const record = sorted[index];
    if (record.expectedRevision < 0n) {
      throw new Error(`player transaction revision must be non-negative: ${record.expectedRevision}`);
    }
    if (index === 0) continue;
    const previous = sorted[index - 1];
    if (
      CharacterIdOfDomainData(previous.domain, previous.data) === CharacterIdOfDomainData(record.domain, record.data) &&
      previous.domain === record.domain
    ) {
      throw new Error(`duplicate player transaction record: ${record.domain}`);
    }
  }
  return sorted;
}

function normalizeKeys(records: readonly PlayerTransactionRecordKey[]): readonly PlayerTransactionRecordKey[] {
  if (records.length === 0) throw new Error("player transaction requires at least one record key");
  const sorted = [...records].sort((left, right) => compareKeys(left.characterId, left.domain, right.characterId, right.domain));
  for (let index = 0; index < sorted.length; index += 1) {
    requireCharacterId(sorted[index].characterId);
    if (
      index > 0 &&
      sorted[index - 1].characterId === sorted[index].characterId &&
      sorted[index - 1].domain === sorted[index].domain
    ) {
      throw new Error(`duplicate player transaction record key: ${sorted[index].characterId}/${sorted[index].domain}`);
    }
  }
  return sorted;
}

function compareKeys(leftId: bigint, leftDomain: PlayerPersistenceDomain, rightId: bigint, rightDomain: PlayerPersistenceDomain): number {
  if (leftId !== rightId) return leftId < rightId ? -1 : 1;
  return leftDomain.localeCompare(rightDomain);
}

function requireCharacterId(characterId: bigint): void {
  if (characterId <= 0n) throw new Error(`player characterId must be positive: ${characterId}`);
}

async function retryStorageUnavailable<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
  for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === SAVE_ATTEMPTS || !(error instanceof DbProxyRemoteError) || error.code !== DbProxyErrorCode.StorageUnavailable) throw error;
      // PostgreSQL可能已提交但ACK或Redis同步失败；调用闭包必须复用同一请求标识。
      // PostgreSQL may have committed before an ACK or Redis sync failure; the closure must reuse the same request identity.
    }
  }
  throw new Error("unreachable DBProxy retry state");
}
