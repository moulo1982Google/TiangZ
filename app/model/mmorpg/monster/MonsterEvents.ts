import { defineSyncEvent, defineVetoEvent, SystemErrCode } from "../../../core/public";
import type { PlayerUnit } from "../map/PlayerUnit";
import type { MonsterUnit } from "./MonsterUnit";
import type { MonsterContentBehaviorAction } from "./MonsterContentProfileComponent";

export interface MonsterKilledEvent {
  readonly player: PlayerUnit;
  readonly monster: MonsterUnit;
}

/** 中立行为规则请求执行模块持有的不透明能力。 / A neutral behavior rule requested an opaque, module-owned ability execution. */
export interface MonsterBehaviorActionRequestedEvent {
  readonly monster: MonsterUnit;
  readonly target?: PlayerUnit;
  readonly action: MonsterContentBehaviorAction;
  readonly nowMs: number;
}

/**
 * 怪物执行一个权威行为Tick前的同步只读上下文；监听器可用非零模块私有原因暂停本Tick，
 * 但不得直接改移动、仇恨、Buff或战斗状态。
 *
 * Synchronous read-only context before one authoritative monster behavior
 * tick. A listener may pause this tick with a non-zero module-private reason,
 * but must not directly mutate movement, threat, buffs, or combat state.
 */
export interface BeforeMonsterBehaviorEvent {
  readonly monster: MonsterUnit;
  readonly nowMs: number;
}

/** 击杀事实在死亡状态提交后同步发布；监听器不得回滚怪物死亡。 / Publishes the kill fact after death is committed; listeners must never roll death back. */
export const MonsterEvents = {
  /** Core只把否决解释为“本Tick停止移动且不行动”，不解释眩晕、恐惧等具体游戏语义。 / Core only treats a veto as stopping movement and skipping this tick; it does not interpret game-specific stun, fear, or similar semantics. */
  BeforeBehavior: defineVetoEvent<BeforeMonsterBehaviorEvent, number>(
    "Monster.BeforeBehavior",
    SystemErrCode.Success,
  ),
  Killed: defineSyncEvent<MonsterKilledEvent>("Monster.Killed"),
  /** Core只发布请求；游戏模块决定是否以及如何执行。 / Core publishes the request; the game module decides whether/how to execute it. */
  BehaviorActionRequested: defineSyncEvent<MonsterBehaviorActionRequestedEvent>(
    "Monster.BehaviorActionRequested",
  ),
} as const;
