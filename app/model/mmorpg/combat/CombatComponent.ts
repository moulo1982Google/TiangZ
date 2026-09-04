import { Component, component } from "../../../core/public";

export const AutoAttackPhase = { Inactive: 0, Waiting: 1, Swinging: 2 } as const;
export type AutoAttackPhaseValue = (typeof AutoAttackPhase)[keyof typeof AutoAttackPhase];

/** 冷内容或外置模块配置近战包络前使用的中立兜底值。 / Neutral fallback used until cold content or an external module configures its melee envelope. */
export const DEFAULT_AUTO_ATTACK_RANGE_METERS = 2;

/** 私有即时战斗结果的类型；旁观者不接收这条消息。 / Immediate private combat-result kinds; bystanders never receive this message. */
export const CombatResultType = { Damage: 1, Healing: 2 } as const;
export type CombatResultTypeValue = (typeof CombatResultType)[keyof typeof CombatResultType];

export const DamageSchool = {
  Physical: 1,
  Frost: 2,
  Fire: 3,
  Holy: 4,
  Shadow: 5,
  Arcane: 6,
  Nature: 7,
} as const;
export type DamageSchoolValue = (typeof DamageSchool)[keyof typeof DamageSchool];

export interface AutoAttackState {
  readonly enabled: boolean;
  readonly targetUnitId: number;
  readonly phase: AutoAttackPhaseValue;
  readonly swingStartAtMs: number;
  readonly swingIntervalMs: number;
}

export interface DamageRequest {
  readonly amount: bigint;
  readonly sourceUnitId?: number;
  readonly abilityId?: number;
  readonly actionId?: number;
  readonly damageSchool?: DamageSchoolValue;
  /** 是否允许外置规则在扣血前规避本次伤害；法术和持续效果默认不可规避。 / Whether extensions may prevent this damage before health mutation; spells and periodic effects are non-preventable by default. */
  readonly canBePrevented?: boolean;
}

export interface DamageAbsorption {
  readonly modifierId: number;
  readonly absorbed: bigint;
  readonly remaining: bigint;
}

export interface DamageResult {
  /** 修饰前的调用方伤害；finalDamage已经包含目标伤害乘数与吸收器。 / Caller damage before modifiers; finalDamage includes target multipliers and absorbers. */
  readonly requestedDamage: bigint;
  readonly absorbedDamage: bigint;
  readonly finalDamage: bigint;
  readonly remainingHp: bigint;
  readonly killed: boolean;
  readonly absorptions: readonly DamageAbsorption[];
  readonly damageSchool: DamageSchoolValue;
  /** 非零值是不透明的模块规避原因；Combat只负责透传，不解释具体命中规则。 / A non-zero opaque module reason; Combat forwards it without interpreting game-specific hit rules. */
  readonly preventedReason: number;
}

export interface HealingResult {
  readonly requestedHealing: bigint;
  readonly restoredHealing: bigint;
  readonly currentHp: bigint;
}

export interface HealingPlan {
  readonly amount: bigint;
  readonly baseCurrentHp: bigint;
  readonly nextCurrentHp: bigint;
  readonly result: HealingResult;
}

export interface DamageAbsorberState {
  readonly modifierId: number;
  readonly priority: number;
  remaining: bigint;
}

export interface CombatComponent {
  AutoAttackState(): AutoAttackState;
  AutoAttackRangeMeters(): number;
  SetAutoAttackRangeMeters(rangeMeters: number): number;
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
  PlanHealing(amount: bigint): HealingPlan;
  CommitHealingPlan(plan: HealingPlan): HealingResult;
  ApplyCommittedHealing(plan: HealingPlan): HealingResult;
}

/** MMORPG战斗状态容器；距离、朝向、仇恨和地图调度仍由mmorpg适配层负责。
 * MMORPG combat state container; range, facing, threat, and map scheduling
 * remain in the MMORPG adapter rather than this component.
 */
@component()
export class CombatComponent extends Component {
  protected autoAttackEnabled = false;
  protected autoAttackTargetUnitId = 0;
  protected autoAttackPhase: AutoAttackPhaseValue = AutoAttackPhase.Inactive;
  protected autoAttackSwingStartAtMs = 0;
  protected autoAttackIntervalMs = 2_000;
  protected autoAttackRangeMeters = DEFAULT_AUTO_ATTACK_RANGE_METERS;
  protected readonly damageAbsorbers = new Map<number, DamageAbsorberState>();
  protected nextDamageAbsorberId = 1;
  protected nextDamageAttemptSequence = 1;

  protected override OnDestroy(): void {
    this.damageAbsorbers.clear();
  }
}
