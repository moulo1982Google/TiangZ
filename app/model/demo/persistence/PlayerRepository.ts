import type { MaybePromise } from "../../../core/public";
import type { ItemSnapshot } from "../../../generated/model/server/demo/protocol/messages";
import type { ActionDefinition } from "../action/ActionType";
import type { BuffTransferState } from "../buff/Buff";
import type { PlayerSnapshot } from "../map/PlayerUnit";
import type { QuestTransferState } from "../quest/QuestComponent";
import type { SkillTransferState } from "../skill/SkillComponent";
import {
  ClonePlayerSaveData,
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

export interface PlayerRepository {
  /** 读取一份自包含快照；不存在时返回undefined，调用方才创建业务默认值。 / Loads one self-contained snapshot; undefined means business defaults should be created. */
  Load(account: string): MaybePromise<PlayerLoadResult | undefined>;
  /** 以期望revision提交完整快照；实现必须在返回前取得可靠提交结果。 / Commits a full snapshot with expected revision and returns only after a reliable commit result. */
  Save(data: PlayerSaveData, expectedRevision: bigint): MaybePromise<PlayerSaveResult>;
}

interface InMemoryRecord {
  readonly data: PlayerSaveData;
  readonly revision: bigint;
  readonly updatedAtUnixMs: bigint;
}

/** 非DBProxy演示与单元测试使用的版本化Repository。 / Versioned Repository used by non-DBProxy demos and unit tests. */
export class InMemoryPlayerRepository implements PlayerRepository {
  private readonly players = new Map<string, InMemoryRecord>();
  private readonly saveCounts = new Map<string, number>();

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
