import { ChildEntity, lifecycle, type TimerId } from "../../../core/public";
import type { ActionDefinition } from "../action/ActionType";

/** Buff创建时需要的运行时状态；墙钟时间用于传送、下线恢复，不保存TimerId。 / Runtime state required to create a Buff; wall-clock times survive transfer and offline restore, while TimerIds do not. */
export interface AwakeBuff {
  readonly configId: number;
  readonly stacks?: number;
  readonly appliedAtMs: number;
  readonly expireAtMs: number;
  readonly tickIntervalMs: number;
  readonly nextTickAtMs: number;
  readonly revision: number;
  readonly restoring?: boolean;
  readonly addAction?: ActionDefinition;
  readonly tickAction?: ActionDefinition;
  readonly removeAction?: ActionDefinition;
  readonly sourceUnitId?: number;
  readonly sourceAbilityId?: number;
  readonly conflictPriority?: number;
  readonly restoringDamageAbsorberRemaining?: bigint;
}

/** 跨地图传输的纯值快照；不得携带Entity、Native handle、Timer或Promise。 / Pure-value cross-map state; never include an Entity, Native handle, Timer, or Promise. */
export interface BuffTransferState {
  readonly buffInstanceId: bigint;
  readonly configId: number;
  readonly stacks: number;
  readonly appliedAtMs: number;
  readonly expireAtMs: number;
  readonly tickIntervalMs: number;
  readonly nextTickAtMs: number;
  readonly revision: number;
  readonly sourceUnitId: number;
  readonly sourceAbilityId: number;
  readonly conflictPriority: number;
  readonly damageAbsorberRemaining: bigint;
  readonly addAction?: ActionDefinition;
  readonly tickAction?: ActionDefinition;
  readonly removeAction?: ActionDefinition;
}

/** AOI公开的Buff外观；私有自定义状态不放进这个视图。 / AOI-public Buff appearance; private custom state does not belong in this view. */
export interface BuffPublicState {
  readonly unitId: number;
  readonly buffInstanceId: bigint;
  readonly buffConfigId: number;
  readonly stacks: number;
  readonly expireTimeMs: bigint;
  readonly revision: number;
}

/** Buff刷新时已经由集合拥有者解析出的确定参数。 / Fully resolved refresh parameters supplied by the owning collection. */
export interface BuffRefreshRequest {
  readonly nowMs: number;
  readonly expireAtMs: number;
  readonly tickIntervalMs: number;
  readonly resetTickCadence: boolean;
  readonly updateSource: boolean;
  readonly sourceUnitId: number;
  readonly sourceAbilityId: number;
  readonly conflictPriority: number;
}

export interface Buff {
  readonly ConfigId: number;
  readonly SourceUnitId: number;
  readonly SourceAbilityId: number;
  readonly ConflictPriority: number;
  Refresh(request: BuffRefreshRequest): void;
  Snapshot(): BuffTransferState;
  PublicState(unitId: number): BuffPublicState;
}

/**
 * Buff是Component拥有的子Entity。它可以拥有自己的Timer，但不能成为网络消息目标。
 * 具体添加、Tick、移除行为由BuffSystem热更；Model只冻结数据形状和生命周期边界。
 *
 * A Buff is a child Entity owned by a Component. It may own timers but cannot
 * be a network message target. BuffSystem owns add/tick/remove behavior in
 * Hotfix; Model freezes the data shape and lifecycle boundary only.
 */
@lifecycle({ awake: true, destroy: true })
export class Buff extends ChildEntity<[request: AwakeBuff]> {
  protected configId = 0;
  protected stacks = 1;
  protected appliedAtMs = 0;
  protected expireAtMs = 0;
  protected tickIntervalOverrideMs = 0;
  protected nextTickAtMs = 0;
  protected revision = 0;
  protected sourceUnitId = 0;
  protected sourceAbilityId = 0;
  protected conflictPriority = 0;
  protected damageAbsorberModifierId = 0;
  protected addAction: ActionDefinition | undefined;
  protected tickAction: ActionDefinition | undefined;
  protected removeAction: ActionDefinition | undefined;
  protected tickTimerId: TimerId | undefined;
  protected expireTimerId: TimerId | undefined;
  protected removeActionExecuted = false;
}
