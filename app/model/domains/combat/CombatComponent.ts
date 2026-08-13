import { Component, component } from "../../../core/public";

export const AutoAttackPhase = { Inactive: 0, Waiting: 1, Swinging: 2 } as const;
export type AutoAttackPhaseValue = (typeof AutoAttackPhase)[keyof typeof AutoAttackPhase];

export const DamageSchool = { Physical: 1, Frost: 2, Fire: 3, Holy: 4, Shadow: 5 } as const;
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
}

export interface DamageAbsorption {
  readonly modifierId: number;
  readonly absorbed: bigint;
  readonly remaining: bigint;
}

export interface DamageResult {
  readonly requestedDamage: bigint;
  readonly absorbedDamage: bigint;
  readonly finalDamage: bigint;
  readonly remainingHp: bigint;
  readonly killed: boolean;
  readonly absorptions: readonly DamageAbsorption[];
  readonly damageSchool: DamageSchoolValue;
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

/**
 * 通用战斗状态容器；距离、朝向、怪物仇恨和地图调度不属于Combat本身。
 * Generic combat state container; range, facing, monster threat, and map
 * scheduling are intentionally outside Combat.
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

  protected override OnDestroy(): void {
    this.damageAbsorbers.clear();
  }
}
