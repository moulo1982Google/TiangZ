import type { MaybePromise } from "../../../core/public";
import type { ItemSnapshot } from "../../../generated/model/server/demo/protocol/messages";
import type { ActionDefinition } from "../action/ActionType";
import type { BuffTransferState } from "../buff/Buff";
import type { PlayerSnapshot } from "../map/PlayerUnit";
import type { QuestTransferState } from "../quest/QuestComponent";
import type { SkillTransferState } from "../skill/SkillComponent";
import { ClonePlayerDomainData, EncodePlayerDomainData, ProjectPlayerDomainData } from "./PlayerPersistenceCodec";

export const PLAYER_PERSISTENCE_DOMAINS = [
  "inventory",
  "progression",
  "quest",
  "runtime",
  "wallet",
] as const;
export type PlayerPersistenceDomain = typeof PLAYER_PERSISTENCE_DOMAINS[number];

export interface PlayerPersistenceRevisions {
  inventory: bigint;
  progression: bigint;
  quest: bigint;
  runtime: bigint;
  wallet: bigint;
}

export interface PersistedNumericValue {
  readonly numericType: number;
  readonly value: bigint;
}

export type PersistedPlayerState = Omit<PlayerSnapshot, "gateName" | "unitId" | "numerics"> & {
  readonly numerics: readonly PersistedNumericValue[];
};

/** Buff来源只保存稳定语义，不保存地图内临时UnitId。 / Buff sources persist stable semantics instead of map-local UnitIds. */
export interface PersistedBuffState extends Omit<BuffTransferState, "sourceUnitId"> {
  readonly source: "self" | "detached";
  readonly addAction?: ActionDefinition;
  readonly tickAction?: ActionDefinition;
  readonly removeAction?: ActionDefinition;
}

/** 聚合值只用于Entity捕获和业务规划，不对应单条数据库记录。 / Aggregate values are used only for Entity capture and planning, not as one database record. */
export interface PlayerSaveData {
  readonly player: PersistedPlayerState;
  readonly items: readonly ItemSnapshot[];
  readonly buffs: readonly PersistedBuffState[];
  readonly skill: SkillTransferState;
  readonly quests: QuestTransferState;
  readonly reason: string;
}

export interface PlayerWalletSaveData {
  readonly account: string;
  readonly characterId: bigint;
  readonly gold: bigint;
  readonly reason: string;
}

export interface PlayerProgressionSaveData {
  readonly account: string;
  readonly characterId: bigint;
  readonly numerics: readonly PersistedNumericValue[];
  readonly reason: string;
}

export interface PlayerInventorySaveData {
  readonly account: string;
  readonly characterId: bigint;
  readonly items: readonly ItemSnapshot[];
  readonly reason: string;
}

export interface PlayerQuestSaveData {
  readonly account: string;
  readonly characterId: bigint;
  readonly quests: QuestTransferState;
  readonly reason: string;
}

export interface PlayerRuntimeSaveData {
  readonly player: Omit<PersistedPlayerState, "gold" | "numerics">;
  readonly buffs: readonly PersistedBuffState[];
  readonly skill: SkillTransferState;
  readonly reason: string;
}

export interface PlayerDomainDataMap {
  readonly inventory: PlayerInventorySaveData;
  readonly progression: PlayerProgressionSaveData;
  readonly quest: PlayerQuestSaveData;
  readonly runtime: PlayerRuntimeSaveData;
  readonly wallet: PlayerWalletSaveData;
}
export type PlayerDomainSaveData = PlayerDomainDataMap[PlayerPersistenceDomain];

export interface PlayerLoadedDomains {
  readonly inventory?: PlayerInventorySaveData;
  readonly progression?: PlayerProgressionSaveData;
  readonly quest?: PlayerQuestSaveData;
  readonly runtime?: PlayerRuntimeSaveData;
  readonly wallet?: PlayerWalletSaveData;
}

export interface PlayerLoadResult {
  readonly data: PlayerLoadedDomains;
  readonly revisions: PlayerPersistenceRevisions;
  readonly updatedAtUnixMs: Readonly<Record<PlayerPersistenceDomain, bigint>>;
}

export interface PlayerSaveResult {
  readonly disposition: "applied" | "duplicate";
  readonly domain: PlayerPersistenceDomain;
  readonly revision: bigint;
}

export interface PlayerTransactionRecordWrite {
  readonly domain: PlayerPersistenceDomain;
  readonly data: PlayerDomainSaveData;
  readonly expectedRevision: bigint;
}

/** 一次事务可以覆盖同一玩家或多个玩家的若干领域记录。 / One transaction may cover domain records from one or several players. */
export interface PlayerTransactionWrite {
  readonly operationId: string;
  readonly records: readonly PlayerTransactionRecordWrite[];
  readonly result: Uint8Array;
}

export interface PlayerTransactionRevision {
  readonly characterId: bigint;
  readonly domain: PlayerPersistenceDomain;
  readonly revision: bigint;
}

export interface PlayerTransactionResult {
  readonly disposition: "applied" | "duplicate";
  readonly revisions: readonly PlayerTransactionRevision[];
  readonly result: Uint8Array;
}

export interface PlayerTransactionReceipt {
  readonly revisions: readonly PlayerTransactionRevision[];
  readonly result: Uint8Array;
}

export interface PlayerTransactionRecordKey {
  readonly characterId: bigint;
  readonly domain: PlayerPersistenceDomain;
}

export type PlayerMultiTransactionWrite = PlayerTransactionWrite;
export type PlayerMultiTransactionResult = PlayerTransactionResult;
export type PlayerMultiTransactionReceipt = PlayerTransactionReceipt;
export type PlayerMultiTransactionRevision = PlayerTransactionRevision;

export interface PlayerRepository {
  /** 分别读取五个领域记录；缺失领域由玩家工厂使用业务默认值。 / Loads five domain records independently; the player factory supplies defaults for missing domains. */
  Load(characterId: bigint): MaybePromise<PlayerLoadResult | undefined>;
  /** 可靠保存一个领域快照并返回其新revision。 / Reliably saves one domain snapshot and returns its new revision. */
  SaveDomain(domain: PlayerPersistenceDomain, data: PlayerDomainSaveData, expectedRevision: bigint): MaybePromise<PlayerSaveResult>;
  /** 原子提交任意领域记录集合，并保存可恢复业务回执。 / Atomically commits an arbitrary domain-record set and stores a recoverable receipt. */
  ApplyTransaction(write: PlayerTransactionWrite): MaybePromise<PlayerTransactionResult>;
  LoadTransaction(records: readonly PlayerTransactionRecordKey[], operationId: string): MaybePromise<PlayerTransactionReceipt | undefined>;
  ApplyMultiTransaction(write: PlayerMultiTransactionWrite): MaybePromise<PlayerMultiTransactionResult>;
  LoadMultiTransaction(records: readonly PlayerTransactionRecordKey[], operationId: string): MaybePromise<PlayerMultiTransactionReceipt | undefined>;
  /** 仅供无DBProxy跨进程迁移交接。 / Used only for no-DBProxy transfer handoff. */
  AdoptTransfer?(data: PlayerSaveData, revisions: PlayerPersistenceRevisions): void;
}

interface InMemoryRecord {
  readonly data: PlayerDomainSaveData;
  readonly revision: bigint;
  readonly updatedAtUnixMs: bigint;
}

interface InMemoryTransactionRecord {
  readonly keys: readonly string[];
  readonly expectedRevisions: readonly bigint[];
  readonly payloads: readonly Uint8Array[];
  readonly result: Uint8Array;
  readonly revisions: readonly PlayerTransactionRevision[];
}

/** 非DBProxy演示与单元测试使用的领域化版本Repository。 / Domain-versioned Repository used by non-DBProxy demos and unit tests. */
export class InMemoryPlayerRepository implements PlayerRepository {
  private readonly records = new Map<string, InMemoryRecord>();
  private readonly saveCounts = new Map<string, number>();
  private readonly transactions = new Map<string, InMemoryTransactionRecord>();

  Load(characterId: bigint): PlayerLoadResult | undefined {
    requireCharacterId(characterId);
    const inventory = this.records.get(recordKey(characterId, "inventory"));
    const progression = this.records.get(recordKey(characterId, "progression"));
    const quest = this.records.get(recordKey(characterId, "quest"));
    const runtime = this.records.get(recordKey(characterId, "runtime"));
    const wallet = this.records.get(recordKey(characterId, "wallet"));
    if (!inventory && !progression && !quest && !runtime && !wallet) return undefined;
    return {
      data: {
        inventory: inventory ? ClonePlayerDomainData("inventory", inventory.data) : undefined,
        progression: progression ? ClonePlayerDomainData("progression", progression.data) : undefined,
        quest: quest ? ClonePlayerDomainData("quest", quest.data) : undefined,
        runtime: runtime ? ClonePlayerDomainData("runtime", runtime.data) : undefined,
        wallet: wallet ? ClonePlayerDomainData("wallet", wallet.data) : undefined,
      },
      revisions: {
        inventory: inventory?.revision ?? 0n,
        progression: progression?.revision ?? 0n,
        quest: quest?.revision ?? 0n,
        runtime: runtime?.revision ?? 0n,
        wallet: wallet?.revision ?? 0n,
      },
      updatedAtUnixMs: {
        inventory: inventory?.updatedAtUnixMs ?? 0n,
        progression: progression?.updatedAtUnixMs ?? 0n,
        quest: quest?.updatedAtUnixMs ?? 0n,
        runtime: runtime?.updatedAtUnixMs ?? 0n,
        wallet: wallet?.updatedAtUnixMs ?? 0n,
      },
    };
  }

  SaveDomain(domain: PlayerPersistenceDomain, data: PlayerDomainSaveData, expectedRevision: bigint): PlayerSaveResult {
    const characterId = CharacterIdOfDomainData(domain, data);
    const key = recordKey(characterId, domain);
    const actualRevision = this.records.get(key)?.revision ?? 0n;
    if (actualRevision !== expectedRevision) {
      throw new Error(`player ${domain} revision conflict: expected=${expectedRevision}, actual=${actualRevision}`);
    }
    const revision = actualRevision + 1n;
    this.records.set(key, { data: ClonePlayerDomainData(domain, data), revision, updatedAtUnixMs: BigInt(Date.now()) });
    this.saveCounts.set(key, (this.saveCounts.get(key) ?? 0) + 1);
    return { disposition: "applied", domain, revision };
  }

  ApplyTransaction(write: PlayerTransactionWrite): PlayerTransactionResult {
    requireOperationId(write.operationId);
    const records = normalizeTransactionRecords(write.records);
    const keys = records.map((record) => recordKey(CharacterIdOfDomainData(record.domain, record.data), record.domain));
    const payloads = records.map((record) => EncodePlayerDomainData(record.domain, record.data));
    const expectedRevisions = records.map((record) => record.expectedRevision);
    const existing = this.transactions.get(write.operationId);
    if (existing) {
      if (!stringArraysEqual(existing.keys, keys) || !bigintArraysEqual(existing.expectedRevisions, expectedRevisions) || !byteArraysEqual(existing.payloads, payloads) || !bytesEqual(existing.result, write.result)) {
        throw new Error(`player transaction operation conflict: ${write.operationId}`);
      }
      return { disposition: "duplicate", revisions: cloneRevisions(existing.revisions), result: existing.result.slice() };
    }
    records.forEach((record, index) => {
      const actualRevision = this.records.get(keys[index])?.revision ?? 0n;
      if (actualRevision !== record.expectedRevision) {
        throw new Error(`player transaction revision conflict: record=${keys[index]}, expected=${record.expectedRevision}, actual=${actualRevision}`);
      }
    });
    const revisions = records.map((record) => ({
      characterId: CharacterIdOfDomainData(record.domain, record.data),
      domain: record.domain,
      revision: record.expectedRevision + 1n,
    }));
    const now = BigInt(Date.now());
    records.forEach((record, index) => this.records.set(keys[index], {
      data: ClonePlayerDomainData(record.domain, record.data),
      revision: revisions[index].revision,
      updatedAtUnixMs: now,
    }));
    this.transactions.set(write.operationId, {
      keys,
      expectedRevisions,
      payloads: payloads.map((payload) => payload.slice()),
      result: write.result.slice(),
      revisions: cloneRevisions(revisions),
    });
    return { disposition: "applied", revisions, result: write.result.slice() };
  }

  LoadTransaction(records: readonly PlayerTransactionRecordKey[], operationId: string): PlayerTransactionReceipt | undefined {
    requireOperationId(operationId);
    const keys = normalizeTransactionKeys(records).map((record) => recordKey(record.characterId, record.domain));
    const transaction = this.transactions.get(operationId);
    if (!transaction || !stringArraysEqual(transaction.keys, keys)) return undefined;
    return { revisions: cloneRevisions(transaction.revisions), result: transaction.result.slice() };
  }

  ApplyMultiTransaction(write: PlayerMultiTransactionWrite): PlayerMultiTransactionResult {
    if (write.records.length < 2) throw new Error("player multi transaction requires at least two records");
    return this.ApplyTransaction(write);
  }

  LoadMultiTransaction(records: readonly PlayerTransactionRecordKey[], operationId: string): PlayerMultiTransactionReceipt | undefined {
    if (records.length < 2) throw new Error("player multi transaction requires at least two records");
    return this.LoadTransaction(records, operationId);
  }

  /** 测试辅助：依次保存聚合快照的全部领域。 / Test helper that saves every domain of one aggregate snapshot in order. */
  Save(data: PlayerSaveData, expectedRevisions: PlayerPersistenceRevisions = EmptyPlayerPersistenceRevisions()): PlayerPersistenceRevisions {
    const revisions = { ...expectedRevisions };
    for (const domain of PLAYER_PERSISTENCE_DOMAINS) {
      revisions[domain] = this.SaveDomain(domain, ProjectPlayerDomainData(data, domain), revisions[domain]).revision;
    }
    return revisions;
  }

  GetDomain<TDomain extends PlayerPersistenceDomain>(characterId: bigint, domain: TDomain): PlayerDomainDataMap[TDomain] | undefined {
    const data = this.records.get(recordKey(characterId, domain))?.data;
    return data ? ClonePlayerDomainData(domain, data) as PlayerDomainDataMap[TDomain] : undefined;
  }

  SaveCount(characterId: bigint, domain?: PlayerPersistenceDomain): number {
    if (domain) return this.saveCounts.get(recordKey(characterId, domain)) ?? 0;
    return PLAYER_PERSISTENCE_DOMAINS.reduce((total, value) => total + (this.saveCounts.get(recordKey(characterId, value)) ?? 0), 0);
  }

  /** 接收跨进程迁移快照，只在目标没有更高revision时写入。 / Accepts a transfer snapshot only when the target has no newer revision. */
  AdoptTransfer(data: PlayerSaveData, revisions: PlayerPersistenceRevisions): void {
    for (const domain of PLAYER_PERSISTENCE_DOMAINS) {
      const projected = ProjectPlayerDomainData(data, domain);
      const key = recordKey(CharacterIdOfDomainData(domain, projected), domain);
      const current = this.records.get(key);
      if (current && current.revision >= revisions[domain]) continue;
      this.records.set(key, { data: ClonePlayerDomainData(domain, projected), revision: revisions[domain], updatedAtUnixMs: BigInt(Date.now()) });
    }
  }
}

export function EmptyPlayerPersistenceRevisions(): PlayerPersistenceRevisions {
  return { inventory: 0n, progression: 0n, quest: 0n, runtime: 0n, wallet: 0n };
}

export function ClonePlayerPersistenceRevisions(revisions: PlayerPersistenceRevisions): PlayerPersistenceRevisions {
  return { ...revisions };
}

export function CharacterIdOfDomainData(domain: PlayerPersistenceDomain, data: PlayerDomainSaveData): bigint {
  const characterId = domain === "runtime"
    ? (data as PlayerRuntimeSaveData).player.characterId
    : (data as { characterId: bigint }).characterId;
  requireCharacterId(characterId);
  return characterId;
}

function normalizeTransactionRecords(records: readonly PlayerTransactionRecordWrite[]): readonly PlayerTransactionRecordWrite[] {
  if (records.length === 0) throw new Error("player transaction requires at least one record");
  const sorted = [...records].sort((left, right) => compareRecordKeys(CharacterIdOfDomainData(left.domain, left.data), left.domain, CharacterIdOfDomainData(right.domain, right.data), right.domain));
  for (let index = 0; index < sorted.length; index += 1) {
    const record = sorted[index];
    if (record.expectedRevision < 0n) throw new Error(`player transaction revision must be non-negative: ${record.expectedRevision}`);
    if (index > 0) {
      const previous = sorted[index - 1];
      if (CharacterIdOfDomainData(previous.domain, previous.data) === CharacterIdOfDomainData(record.domain, record.data) && previous.domain === record.domain) {
        throw new Error(`duplicate player transaction record: ${record.domain}`);
      }
    }
  }
  return sorted;
}

function normalizeTransactionKeys(records: readonly PlayerTransactionRecordKey[]): readonly PlayerTransactionRecordKey[] {
  if (records.length === 0) throw new Error("player transaction requires at least one record key");
  const sorted = [...records].sort((left, right) => compareRecordKeys(left.characterId, left.domain, right.characterId, right.domain));
  for (let index = 0; index < sorted.length; index += 1) {
    requireCharacterId(sorted[index].characterId);
    if (index > 0 && sorted[index - 1].characterId === sorted[index].characterId && sorted[index - 1].domain === sorted[index].domain) {
      throw new Error(`duplicate player transaction record key: ${sorted[index].characterId}/${sorted[index].domain}`);
    }
  }
  return sorted;
}

function recordKey(characterId: bigint, domain: PlayerPersistenceDomain): string {
  requireCharacterId(characterId);
  return `${characterId.toString(10)}:${domain}`;
}
function requireCharacterId(characterId: bigint): void {
  if (characterId <= 0n) throw new Error(`player characterId must be positive: ${characterId}`);
}
function requireOperationId(operationId: string): void {
  if (operationId.trim().length === 0) throw new Error("player transaction operationId is required");
}
function compareRecordKeys(leftId: bigint, leftDomain: PlayerPersistenceDomain, rightId: bigint, rightDomain: PlayerPersistenceDomain): number {
  if (leftId !== rightId) return leftId < rightId ? -1 : 1;
  return leftDomain.localeCompare(rightDomain);
}
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}
function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function bigintArraysEqual(left: readonly bigint[], right: readonly bigint[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function byteArraysEqual(left: readonly Uint8Array[], right: readonly Uint8Array[]): boolean {
  return left.length === right.length && left.every((value, index) => bytesEqual(value, right[index]));
}
function cloneRevisions(revisions: readonly PlayerTransactionRevision[]): readonly PlayerTransactionRevision[] {
  return revisions.map((value) => ({ ...value }));
}
