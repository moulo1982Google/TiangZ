import { defineSyncEvent } from "../../../core/public";
import type { PlayerUnit } from "../map/PlayerUnit";
import type { MonsterUnit } from "./MonsterUnit";

export interface MonsterKilledEvent {
  readonly player: PlayerUnit;
  readonly monster: MonsterUnit;
}

/** 击杀事实在死亡状态提交后同步发布；监听器不得回滚怪物死亡。 / Publishes the kill fact after death is committed; listeners must never roll death back. */
export const MonsterEvents = {
  Killed: defineSyncEvent<MonsterKilledEvent>("Monster.Killed"),
} as const;
