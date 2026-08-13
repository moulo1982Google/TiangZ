import { ChildEntity, lifecycle, type TimerId } from "../../../core/public";
import type { ActionDefinition } from "../action/ActionDefinition";

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

export interface BuffPublicState {
  readonly unitId: number;
  readonly buffInstanceId: bigint;
  readonly buffConfigId: number;
  readonly stacks: number;
  readonly expireTimeMs: bigint;
  readonly revision: number;
}

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
 * Buff是通用的可拥有子Entity；具体配置、AOI和Combat适配留给领域层。
 * Buff is a reusable owned child Entity; configuration, AOI, and Combat
 * integration remain in the domain adapter.
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
