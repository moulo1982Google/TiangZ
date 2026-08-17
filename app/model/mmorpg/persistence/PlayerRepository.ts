import type { MaybePromise } from "../../../core/public";
import type { ItemSnapshot } from "../../../generated/model/server/demo/protocol/messages";
import type { ActionDefinition } from "../action/ActionType";
import type { BuffTransferState } from "../buff/Buff";
import type { PlayerSnapshot } from "../map/PlayerUnit";
import type { QuestTransferState } from "../quest/QuestComponent";
import type { SkillTransferState } from "../skill/SkillComponent";
import {
  ClonePlayerSaveData,
  EncodePlayerSaveData,
} from "./PlayerPersistenceCodec";

export interface PersistedNumericValue {
  readonly numericType: number;
  readonly value: bigint;
}

export type PersistedPlayerState = Omit<
  PlayerSnapshot,
  "gateName" | "unitId" | "numerics"
> & {
  readonly numerics: readonly PersistedNumericValue[];
};

/**
 * Buff来源不能保存地图内临时UnitId。自身来源在恢复时映射到新的UnitId；其他来源
 * 暂时脱离，未来拥有持久角色ID后再扩展为稳定来源。
 *
 * Buff sources cannot persist map-local UnitIds. A self source maps to the new
 * UnitId during restore; other sources are detached until stable character IDs
 * are introduced.
 */
export interface PersistedBuffState extends Omit<BuffTransferState, "sourceUnitId"> {
  readonly source: "self" | "detached";
  readonly addAction?: ActionDefinition;
  readonly tickAction?: ActionDefinition;
  readonly removeAction?: ActionDefinition;
}

export interface PlayerSaveData {
  readonly player: PersistedPlayerState;
  readonly items: readonly ItemSnapshot[];
  readonly buffs: readonly PersistedBuffState[];
  readonly skill: SkillTransferState;
  readonly quests: QuestTransferState;
  readonly reason: string;
}

export interface PlayerLoadResult {
  readonly data: PlayerSaveData;
  readonly revision: bigint;
  readonly updatedAtUnixMs: bigint;
}

export interface PlayerSaveResult {
  readonly disposition: "applied" | "duplicate";
  readonly revision: bigint;
}

/** 一次关键玩家事务；result由业务定义并由DBProxy原样保存，用于重试时返回首次结果。 / One critical player transaction whose business-defined result is stored verbatim for retry recovery. */
export interface PlayerTransactionWrite {
  readonly operationId: string;
  readonly data: PlayerSaveData;
  readonly result: Uint8Array;
}

export interface PlayerTransactionResult {
  readonly disposition: "applied" | "duplicate";
  readonly revision: bigint;
  readonly result: Uint8Array;
}

export interface PlayerTransactionReceipt {
  readonly revision: bigint;
  readonly result: Uint8Array;
}

/** 多角色关键事务中的一条玩家写入；所有条目必须由Repository一次提交或全部拒绝。 / One player write in a multi-character critical transaction; the Repository must commit every entry or reject them all. */
export interface PlayerMultiTransactionEntry {
  readonly data: PlayerSaveData;
  readonly expectedRevision: bigint;
}

/** 跨玩家事务写入；operationId在所有参与角色之间共享，result保存确定性的业务回执。 / Cross-player transaction write sharing one operationId and one deterministic business receipt across every participant. */
export interface PlayerMultiTransactionWrite {
  readonly operationId: string;
  readonly entries: readonly PlayerMultiTransactionEntry[];
  readonly result: Uint8Array;
}

export interface PlayerMultiTransactionRevision {
  readonly characterId: bigint;
  readonly revision: bigint;
}

export interface PlayerMultiTransactionResult {
  readonly disposition: "applied" | "duplicate";
  readonly revisions: readonly PlayerMultiTransactionRevision[];
  readonly result: Uint8Array;
}

export interface PlayerMultiTransactionReceipt {
  readonly revisions: readonly PlayerMultiTransactionRevision[];
  readonly result: Uint8Array;
}

export interface PlayerRepository {
  /** 读取一份自包含快照；不存在时返回undefined，调用方才创建业务默认值。 / Loads one self-contained snapshot; undefined means business defaults should be created. */
  Load(characterId: bigint): MaybePromise<PlayerLoadResult | undefined>;
  /** 以期望revision提交完整快照；实现必须在返回前取得可靠提交结果。 / Commits a full snapshot with expected revision and returns only after a reliable commit result. */
  Save(data: PlayerSaveData, expectedRevision: bigint): MaybePromise<PlayerSaveResult>;
  /** 原子提交关键业务后的完整玩家记录，并保存可恢复结果。 / Atomically commits the post-operation player record and its recoverable result. */
  ApplyTransaction(
    write: PlayerTransactionWrite,
    expectedRevision: bigint,
  ): MaybePromise<PlayerTransactionResult>;
  /** 按稳定operationId查询既有事务；不得根据当前快照猜测是否提交。 / Loads a committed transaction by stable operationId instead of inferring from the current snapshot. */
  LoadTransaction(
    characterId: bigint,
    operationId: string,
  ): MaybePromise<PlayerTransactionReceipt | undefined>;
  /** 原子提交多个玩家记录；任一revision冲突时不得写入任何参与者。 / Atomically commits multiple player records and writes none when any expected revision conflicts. */
  ApplyMultiTransaction(
    write: PlayerMultiTransactionWrite,
  ): MaybePromise<PlayerMultiTransactionResult>;
  /** 按稳定operationId和完整参与者集合读取多记录事务回执。 / Loads a multi-record receipt by stable operationId and its complete participant set. */
  LoadMultiTransaction(
    characterIds: readonly bigint[],
    operationId: string,
  ): MaybePromise<PlayerMultiTransactionReceipt | undefined>;
  /** 仅用于无DBProxy的跨进程迁移，把迁移快照交给目标进程的内存Repository；持久化Repository不得用它覆盖权威数据。 / Used only for no-DBProxy process transfer to hand a snapshot to the target in-memory Repository; durable repositories must not use it to overwrite authority. */
  AdoptTransfer?(data: PlayerSaveData, revision: bigint): void;
}

interface InMemoryRecord {
  readonly data: PlayerSaveData;
  readonly revision: bigint;
  readonly updatedAtUnixMs: bigint;
}

interface InMemoryTransactionRecord {
  readonly characterId: bigint;
  readonly expectedRevision: bigint;
  readonly payload: Uint8Array;
  readonly result: Uint8Array;
  readonly revision: bigint;
}

interface InMemoryMultiTransactionRecord {
  readonly characterIds: readonly bigint[];
  readonly expectedRevisions: readonly bigint[];
  readonly payloads: readonly Uint8Array[];
  readonly result: Uint8Array;
  readonly revisions: readonly PlayerMultiTransactionRevision[];
}

/** 非DBProxy演示与单元测试使用的版本化Repository。 / Versioned Repository used by non-DBProxy demos and unit tests. */
export class InMemoryPlayerRepository implements PlayerRepository {
  private readonly players = new Map<string, InMemoryRecord>();
  private readonly saveCounts = new Map<string, number>();
  private readonly transactions = new Map<string, InMemoryTransactionRecord>();
  private readonly multiTransactions = new Map<string, InMemoryMultiTransactionRecord>();

  Load(characterId: bigint): PlayerLoadResult | undefined {
    const record = this.players.get(keyOf(characterId));
    return record
      ? {
        data: ClonePlayerSaveData(record.data),
        revision: record.revision,
        updatedAtUnixMs: record.updatedAtUnixMs,
      }
      : undefined;
  }

  /** 采用与DBProxy相同的CAS语义，避免本地模式掩盖陈旧快照覆盖问题。 / Uses DBProxy-equivalent CAS semantics so local mode cannot hide stale-snapshot overwrites. */
  Save(data: PlayerSaveData, expectedRevision: bigint): PlayerSaveResult {
    const current = this.players.get(keyOf(data.player.characterId));
    const actualRevision = current?.revision ?? 0n;
    if (actualRevision !== expectedRevision) {
      throw new Error(
        `player snapshot revision conflict: expected=${expectedRevision}, actual=${actualRevision}`,
      );
    }
    const revision = actualRevision + 1n;
    this.players.set(keyOf(data.player.characterId), {
      data: ClonePlayerSaveData(data),
      revision,
      updatedAtUnixMs: BigInt(Date.now()),
    });
    this.saveCounts.set(
      keyOf(data.player.characterId),
      (this.saveCounts.get(keyOf(data.player.characterId)) ?? 0) + 1,
    );
    return { disposition: "applied", revision };
  }

  /** 模拟DBProxy先查幂等回执、再做revision CAS的顺序，避免本地测试掩盖重试问题。 / Mirrors DBProxy's receipt-first then revision-CAS order so local tests expose retry mistakes. */
  ApplyTransaction(
    write: PlayerTransactionWrite,
    expectedRevision: bigint,
  ): PlayerTransactionResult {
    requireOperationId(write.operationId);
    const characterId = write.data.player.characterId;
    const payload = EncodePlayerSaveData(write.data);
    const existing = this.transactions.get(write.operationId);
    if (existing) {
      if (
        existing.characterId !== characterId ||
        existing.expectedRevision !== expectedRevision ||
        !bytesEqual(existing.payload, payload) ||
        !bytesEqual(existing.result, write.result)
      ) {
        throw new Error(`player transaction operation conflict: ${write.operationId}`);
      }
      return {
        disposition: "duplicate",
        revision: existing.revision,
        result: write.result.slice(),
      };
    }

    const current = this.players.get(keyOf(characterId));
    const actualRevision = current?.revision ?? 0n;
    if (actualRevision !== expectedRevision) {
      throw new Error(
        `player transaction revision conflict: expected=${expectedRevision}, actual=${actualRevision}`,
      );
    }
    const revision = actualRevision + 1n;
    this.players.set(keyOf(characterId), {
      data: ClonePlayerSaveData(write.data),
      revision,
      updatedAtUnixMs: BigInt(Date.now()),
    });
    this.transactions.set(write.operationId, {
      characterId,
      expectedRevision,
      payload: payload.slice(),
      result: write.result.slice(),
      revision,
    });
    return { disposition: "applied", revision, result: write.result.slice() };
  }

  LoadTransaction(characterId: bigint, operationId: string): PlayerTransactionReceipt | undefined {
    requireOperationId(operationId);
    const transaction = this.transactions.get(operationId);
    if (!transaction || transaction.characterId !== characterId) return undefined;
    return { revision: transaction.revision, result: transaction.result.slice() };
  }

  /** 先校验全部幂等参数和revision，再一次性替换所有记录；校验阶段不修改任何玩家。 / Validates every idempotency argument and revision before replacing all records, with no mutation during preflight. */
  ApplyMultiTransaction(write: PlayerMultiTransactionWrite): PlayerMultiTransactionResult {
    requireOperationId(write.operationId);
    const entries = normalizeMultiEntries(write.entries);
    const characterIds = entries.map((entry) => entry.data.player.characterId);
    const expectedRevisions = entries.map((entry) => entry.expectedRevision);
    const payloads = entries.map((entry) => EncodePlayerSaveData(entry.data));
    const existing = this.multiTransactions.get(write.operationId);
    if (existing) {
      if (
        !bigintArraysEqual(existing.characterIds, characterIds) ||
        !bigintArraysEqual(existing.expectedRevisions, expectedRevisions) ||
        !byteArraysEqual(existing.payloads, payloads) ||
        !bytesEqual(existing.result, write.result)
      ) {
        throw new Error(`player multi transaction operation conflict: ${write.operationId}`);
      }
      return {
        disposition: "duplicate",
        revisions: cloneRevisions(existing.revisions),
        result: existing.result.slice(),
      };
    }

    for (const entry of entries) {
      const characterId = entry.data.player.characterId;
      const actualRevision = this.players.get(keyOf(characterId))?.revision ?? 0n;
      if (actualRevision !== entry.expectedRevision) {
        throw new Error(
          `player multi transaction revision conflict: characterId=${characterId}, expected=${entry.expectedRevision}, actual=${actualRevision}`,
        );
      }
    }

    const revisions = entries.map((entry) => ({
      characterId: entry.data.player.characterId,
      revision: entry.expectedRevision + 1n,
    }));
    const now = BigInt(Date.now());
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      this.players.set(keyOf(entry.data.player.characterId), {
        data: ClonePlayerSaveData(entry.data),
        revision: revisions[index].revision,
        updatedAtUnixMs: now,
      });
    }
    this.multiTransactions.set(write.operationId, {
      characterIds,
      expectedRevisions,
      payloads: payloads.map((payload) => payload.slice()),
      result: write.result.slice(),
      revisions: cloneRevisions(revisions),
    });
    return {
      disposition: "applied",
      revisions: cloneRevisions(revisions),
      result: write.result.slice(),
    };
  }

  LoadMultiTransaction(
    characterIds: readonly bigint[],
    operationId: string,
  ): PlayerMultiTransactionReceipt | undefined {
    requireOperationId(operationId);
    const normalizedIds = normalizeCharacterIds(characterIds);
    const transaction = this.multiTransactions.get(operationId);
    if (!transaction || !bigintArraysEqual(transaction.characterIds, normalizedIds)) return undefined;
    return {
      revisions: cloneRevisions(transaction.revisions),
      result: transaction.result.slice(),
    };
  }

  /** 返回防御性副本，防止测试修改Repository权威数据。 / Returns a defensive copy so tests cannot mutate repository authority. */
  Get(characterId: bigint): PlayerSaveData | undefined {
    const data = this.players.get(keyOf(characterId))?.data;
    return data ? ClonePlayerSaveData(data) : undefined;
  }

  /** 返回保存次数，主要用于生命周期幂等测试。 / Reports save count, primarily for lifecycle idempotency tests. */
  SaveCount(characterId: bigint): number {
    return this.saveCounts.get(keyOf(characterId)) ?? 0;
  }

  /** 接收跨进程迁移的运行时交接；只在目标没有更高revision时写入。 / Accepts a runtime transfer handoff and writes only when the target has no newer revision. */
  AdoptTransfer(data: PlayerSaveData, revision: bigint): void {
    const characterId = data.player.characterId;
    const key = keyOf(characterId);
    const current = this.players.get(key);
    if (current && current.revision > revision) return;
    if (current && current.revision === revision) return;
    this.players.set(key, {
      data: ClonePlayerSaveData(data),
      revision,
      updatedAtUnixMs: BigInt(Date.now()),
    });
  }
}

function keyOf(characterId: bigint): string {
  if (characterId <= 0n) throw new Error(`player characterId must be positive: ${characterId}`);
  return characterId.toString(10);
}

function requireOperationId(operationId: string): void {
  if (operationId.trim().length === 0) throw new Error("player transaction operationId is required");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function normalizeMultiEntries(
  entries: readonly PlayerMultiTransactionEntry[],
): readonly PlayerMultiTransactionEntry[] {
  if (entries.length < 2) throw new Error("player multi transaction requires at least two entries");
  const sorted = [...entries].sort((left, right) => compareBigInt(
    left.data.player.characterId,
    right.data.player.characterId,
  ));
  for (let index = 0; index < sorted.length; index += 1) {
    const entry = sorted[index];
    keyOf(entry.data.player.characterId);
    if (entry.expectedRevision < 0n) {
      throw new Error(`player multi transaction revision must be non-negative: ${entry.expectedRevision}`);
    }
    if (index > 0 && sorted[index - 1].data.player.characterId === entry.data.player.characterId) {
      throw new Error(`duplicate player in multi transaction: ${entry.data.player.characterId}`);
    }
  }
  return sorted;
}

function normalizeCharacterIds(characterIds: readonly bigint[]): readonly bigint[] {
  if (characterIds.length < 2) throw new Error("player multi transaction requires at least two character IDs");
  const sorted = [...characterIds].sort(compareBigInt);
  for (let index = 0; index < sorted.length; index += 1) {
    keyOf(sorted[index]);
    if (index > 0 && sorted[index - 1] === sorted[index]) {
      throw new Error(`duplicate player in multi transaction receipt: ${sorted[index]}`);
    }
  }
  return sorted;
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bigintArraysEqual(left: readonly bigint[], right: readonly bigint[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function byteArraysEqual(left: readonly Uint8Array[], right: readonly Uint8Array[]): boolean {
  return left.length === right.length && left.every((value, index) => bytesEqual(value, right[index]));
}

function cloneRevisions(
  revisions: readonly PlayerMultiTransactionRevision[],
): readonly PlayerMultiTransactionRevision[] {
  return revisions.map((value) => ({ ...value }));
}
