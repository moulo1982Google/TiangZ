import { Component, component } from "../../../core/public";

/** 自动攻击所处阶段；状态激活与当前读条刻意分开。 / Auto-attack phases; activation and the current swing are deliberately separate. */
export const AutoAttackPhase = {
  Inactive: 0,
  Waiting: 1,
  Swinging: 2,
} as const;

export type AutoAttackPhaseValue = (typeof AutoAttackPhase)[keyof typeof AutoAttackPhase];

/**
 * 给Hotfix和客户端广播使用的平A状态快照。
 * swingStartAtMs 为0表示当前没有正在进行的读条；它不是持久化字段。
 *
 * Auto-attack state exposed to Hotfix and client broadcasts. A zero
 * swingStartAtMs means no swing is currently progressing; it is not persisted.
 */
export interface AutoAttackState {
  readonly enabled: boolean;
  readonly targetUnitId: number;
  readonly phase: AutoAttackPhaseValue;
  readonly swingStartAtMs: number;
  readonly swingIntervalMs: number;
}

/** Hotfix实现向稳定Model暴露的最小操作面。 / Minimal stable surface exposed by Model for the Hotfix implementation. */
export interface CombatComponent {
  AutoAttackState(): AutoAttackState;
  SetAutoAttackInterval(intervalMs: number): AutoAttackState;
  ToggleAutoAttack(targetUnitId: number, enabled: boolean): AutoAttackState;
  BeginAutoAttackSwing(nowMs: number): AutoAttackState;
  ResetAutoAttackSwing(): AutoAttackState;
}

/**
 * 玩家战斗状态的稳定容器；读条推进和伤害结算放在Hotfix System。
 * 该组件不自行注册Update，也不为每次平A创建Timer，避免玩家数量增长时产生大量调度目标。
 *
 * Stable container for player combat state; Hotfix Systems own swing progress
 * and damage resolution. It does not register its own Update or create a Timer
 * per swing, preventing one scheduler target per player as population grows.
 */
@component()
export class CombatComponent extends Component {
  protected autoAttackEnabled = false;
  protected autoAttackTargetUnitId = 0;
  protected autoAttackPhase: AutoAttackPhaseValue = AutoAttackPhase.Inactive;
  protected autoAttackSwingStartAtMs = 0;
  protected autoAttackIntervalMs = 2_000;
}
