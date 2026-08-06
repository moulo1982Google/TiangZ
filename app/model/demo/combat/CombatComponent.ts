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

/**
 * 一次权威伤害请求；source/ability/action只用于规则、日志和仇恨，不改变结算入口。
 *
 * One authoritative damage request. Source/ability/action metadata is for
 * rules, logs, and threat; it never changes the single damage entrypoint.
 */
export interface DamageRequest {
  readonly amount: bigint;
  readonly sourceUnitId?: number;
  readonly abilityId?: number;
  readonly actionId?: number;
}

/** 伤害处理器消耗的护盾明细；用于战斗结果和后续Buff详情投影。 / Shield details consumed by the damage pipeline for results and future Buff projections. */
export interface DamageAbsorption {
  readonly modifierId: number;
  readonly absorbed: bigint;
  readonly remaining: bigint;
}

/**
 * 伤害结算结果；调用者应使用finalDamage和killed，不要再次修改CurrentHp。
 *
 * Damage resolution result. Callers must use finalDamage and killed instead of
 * modifying CurrentHp a second time.
 */
export interface DamageResult {
  readonly requestedDamage: bigint;
  readonly absorbedDamage: bigint;
  readonly finalDamage: bigint;
  readonly remainingHp: bigint;
  readonly killed: boolean;
  readonly absorptions: readonly DamageAbsorption[];
}

/** 治疗结算结果；治疗自动受MaxHp限制。 / Healing resolution result; healing is clamped by MaxHp. */
export interface HealingResult {
  readonly requestedHealing: bigint;
  readonly restoredHealing: bigint;
  readonly currentHp: bigint;
}

/**
 * CombatComponent内部的伤害吸收状态；Buff只需保存modifierId，不需要成为受伤入口。
 *
 * Internal damage-absorber state. A Buff only needs the modifierId and never
 * becomes the entrypoint for incoming damage.
 */
export interface DamageAbsorberState {
  readonly modifierId: number;
  readonly priority: number;
  remaining: bigint;
}

/** Hotfix实现向稳定Model暴露的最小操作面。 / Minimal stable surface exposed by Model for the Hotfix implementation. */
export interface CombatComponent {
  AutoAttackState(): AutoAttackState;
  SetAutoAttackInterval(intervalMs: number): AutoAttackState;
  ToggleAutoAttack(targetUnitId: number, enabled: boolean): AutoAttackState;
  BeginAutoAttackSwing(nowMs: number): AutoAttackState;
  ResetAutoAttackSwing(): AutoAttackState;
  RegisterDamageAbsorber(amount: bigint, priority?: number): number;
  UpdateDamageAbsorber(modifierId: number, remaining: bigint): boolean;
  GetDamageAbsorberRemaining(modifierId: number): bigint | undefined;
  RemoveDamageAbsorber(modifierId: number): boolean;
  ApplyDamage(request: DamageRequest): DamageResult;
  ApplyHealing(amount: bigint): HealingResult;
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
  protected readonly damageAbsorbers = new Map<number, DamageAbsorberState>();
  protected nextDamageAbsorberId = 1;

  /** 组件销毁时清理运行时伤害处理器；Buff生命周期结束不能留下悬挂效果。 / Clears runtime damage modifiers on disposal so Buff lifecycles cannot leave dangling effects. */
  protected override OnDestroy(): void {
    this.damageAbsorbers.clear();
  }
}
