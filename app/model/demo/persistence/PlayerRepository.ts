import type { MaybePromise } from "../../../core/public";
import type { ItemSnapshot } from "../../../generated/model/server/demo/protocol/messages";
import type { PlayerSnapshot } from "../map/PlayerUnit";

export type PersistedPlayerState = Omit<
  PlayerSnapshot,
  "gateName"
>;

export interface PlayerSaveData {
  readonly player: PersistedPlayerState;
  readonly items: readonly ItemSnapshot[];
  readonly reason: string;
}

export interface PlayerRepository {
  /** 持久化一份自包含玩家快照；实现不得保留可变引用。 / Persists one self-contained player snapshot; implementations must not retain mutable references. */
  Save(data: PlayerSaveData): MaybePromise<void>;
}

export class InMemoryPlayerRepository implements PlayerRepository {
  private readonly players = new Map<string, PlayerSaveData>();
  private readonly saveCounts = new Map<string, number>();

  /** 保存防御性副本，并递增测试可见的保存次数。 / Stores a defensive copy and increments a test-visible save count. */
  Save(data: PlayerSaveData): void {
    this.players.set(data.player.account, cloneSaveData(data));
    this.saveCounts.set(
      data.player.account,
      (this.saveCounts.get(data.player.account) ?? 0) + 1,
    );
  }

  /** 返回防御性副本，防止测试修改 Repository 权威数据。 / Returns a defensive copy so tests cannot mutate repository authority. */
  Get(account: string): PlayerSaveData | undefined {
    const data = this.players.get(account);
    return data ? cloneSaveData(data) : undefined;
  }

  /** 返回保存次数，主要用于生命周期幂等测试。 / Reports how many saves occurred, primarily for lifecycle idempotency tests. */
  SaveCount(account: string): number {
    return this.saveCounts.get(account) ?? 0;
  }
}

function cloneSaveData(data: PlayerSaveData): PlayerSaveData {
  return {
    reason: data.reason,
    player: {
      ...data.player,
      numerics: data.player.numerics.map((numeric) => ({ ...numeric })),
    },
    items: data.items.map((item) => ({ ...item })),
  };
}
