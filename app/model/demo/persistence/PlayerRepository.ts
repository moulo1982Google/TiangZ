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

export interface PlayerRepository {
  /** 读取一份自包含快照；不存在时返回undefined，调用方才创建业务默认值。 / Loads one self-contained snapshot; undefined means business defaults should be created. */
  Load(account: string): MaybePromise<PlayerLoadResult | undefined>;
  /** 以期望revision提交完整快照；实现必须在返回前取得可靠提交结果。 / Commits a full snapshot with expected revision and returns only after a reliable commit result. */
  Save(data: PlayerSaveData, expectedRevision: bigint): MaybePromise<PlayerSaveResult>;
  /** 原子提交关键业务后的完整玩家记录，并保存可恢复结果。 / Atomically commits the post-operation player record and its recoverable result. */
  ApplyTransaction(
    write: PlayerTransactionWrite,
    expectedRevision: bigint,
  ): MaybePromise<PlayerTransactionResult>;
  /** 按稳定operationId查询既有事务；不得根据当前快照猜测是否提交。 / Loads a committed transaction by stable operationId instead of inferring from the current snapshot. */
  LoadTransaction(
    account: string,
    operationId: string,
  ): MaybePromise<PlayerTransactionReceipt | undefined>;
}

interface InMemoryRecord {
  readonly data: PlayerSaveData;
  readonly revision: bigint;
  readonly updatedAtUnixMs: bigint;
}

interface InMemoryTransactionRecord {
  readonly account: string;
  readonly expectedRevision: bigint;
  readonly payload: Uint8Array;
  readonly result: Uint8Array;
  readonly revision: bigint;
}

/** 非DBProxy演示与单元测试使用的版本化Repository。 / Versioned Repository used by non-DBProxy demos and unit tests. */
export class InMemoryPlayerRepository implements PlayerRepository {
  private readonly players = new Map<string, InMemoryRecord>();
  private readonly saveCounts = new Map<string, number>();
  private readonly transactions = new Map<string, InMemoryTransactionRecord>();

  Load(account: string): PlayerLoadResult | undefined {
    const record = this.players.get(account);
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
    const current = this.players.get(data.player.account);
    const actualRevision = current?.revision ?? 0n;
    if (actualRevision !== expectedRevision) {
      throw new Error(
        `player snapshot revision conflict: expected=${expectedRevision}, actual=${actualRevision}`,
      );
    }
    const revision = actualRevision + 1n;
    this.players.set(data.player.account, {
      data: ClonePlayerSaveData(data),
      revision,
      updatedAtUnixMs: BigInt(Date.now()),
    });
    this.saveCounts.set(
      data.player.account,
      (this.saveCounts.get(data.player.account) ?? 0) + 1,
    );
    return { disposition: "applied", revision };
  }

  /** 模拟DBProxy先查幂等回执、再做revision CAS的顺序，避免本地测试掩盖重试问题。 / Mirrors DBProxy's receipt-first then revision-CAS order so local tests expose retry mistakes. */
  ApplyTransaction(
    write: PlayerTransactionWrite,
    expectedRevision: bigint,
  ): PlayerTransactionResult {
    requireOperationId(write.operationId);
    const account = write.data.player.account;
    const payload = EncodePlayerSaveData(write.data);
    const existing = this.transactions.get(write.operationId);
    if (existing) {
      if (
        existing.account !== account ||
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

    const current = this.players.get(account);
    const actualRevision = current?.revision ?? 0n;
    if (actualRevision !== expectedRevision) {
      throw new Error(
        `player transaction revision conflict: expected=${expectedRevision}, actual=${actualRevision}`,
      );
    }
    const revision = actualRevision + 1n;
    this.players.set(account, {
      data: ClonePlayerSaveData(write.data),
      revision,
      updatedAtUnixMs: BigInt(Date.now()),
    });
    this.transactions.set(write.operationId, {
      account,
      expectedRevision,
      payload: payload.slice(),
      result: write.result.slice(),
      revision,
    });
    return { disposition: "applied", revision, result: write.result.slice() };
  }

  LoadTransaction(account: string, operationId: string): PlayerTransactionReceipt | undefined {
    requireOperationId(operationId);
    const transaction = this.transactions.get(operationId);
    if (!transaction || transaction.account !== account) return undefined;
    return { revision: transaction.revision, result: transaction.result.slice() };
  }

  /** 返回防御性副本，防止测试修改Repository权威数据。 / Returns a defensive copy so tests cannot mutate repository authority. */
  Get(account: string): PlayerSaveData | undefined {
    const data = this.players.get(account)?.data;
    return data ? ClonePlayerSaveData(data) : undefined;
  }

  /** 返回保存次数，主要用于生命周期幂等测试。 / Reports save count, primarily for lifecycle idempotency tests. */
  SaveCount(account: string): number {
    return this.saveCounts.get(account) ?? 0;
  }
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
