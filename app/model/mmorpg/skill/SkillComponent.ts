import { Component, component, lifecycle, transferable } from "../../../core/public";
import type { SkillDefinition } from "./SkillDefinition";

export const SkillCastPhase = { Idle: 0, Casting: 1 } as const;
export type SkillCastPhaseValue = (typeof SkillCastPhase)[keyof typeof SkillCastPhase];

export interface ActiveSkillCast {
  readonly castId: bigint;
  readonly skillId: number;
  readonly targetUnitId: number;
  readonly startedAtMs: number;
  readonly finishAtMs: number;
  readonly nextTickAtMs: number;
  readonly channelTicksCompleted: number;
  readonly definition: SkillDefinition;
}

export interface SkillCastState {
  readonly phase: SkillCastPhaseValue;
  readonly castId: bigint;
  readonly skillId: number;
  readonly targetUnitId: number;
  readonly startedAtMs: number;
  readonly finishAtMs: number;
  readonly globalCooldownEndAtMs: number;
  readonly skillCooldownEndAtMs: number;
  readonly channelTickIndex: number;
  readonly channelTickCount: number;
  readonly queuedSkillId: number;
  readonly queuedTargetUnitId: number;
  readonly queueDeadlineAtMs: number;
  readonly interruptReason: string;
}

export interface SkillCastCommand { readonly skillId: number; readonly targetUnitId: number; }
export interface QueuedSkillCast { readonly command: SkillCastCommand; readonly deadlineAtMs: number; }
export interface SkillCooldownTransferState { readonly skillId: number; readonly cooldownEndAtMs: number; }
export interface ItemCooldownTransferState { readonly itemConfigId: number; readonly cooldownEndAtMs: number; }
export interface ItemCooldownCommitResult { readonly accepted: boolean; readonly readyAtMs: number; readonly globalCooldownEndAtMs: number; readonly itemCooldownEndAtMs: number; }
export interface ItemCooldownPlan {
  readonly itemConfigId: number;
  readonly baseState: SkillTransferState;
  readonly nextState: SkillTransferState;
  readonly result: ItemCooldownCommitResult;
}
export interface SkillTransferState {
  readonly globalCooldownEndAtMs: number;
  readonly cooldowns: readonly SkillCooldownTransferState[];
  readonly itemCooldowns: readonly ItemCooldownTransferState[];
}

export interface SkillComponent {
  Cast(command: SkillCastCommand): SkillCastState;
  InterruptByMovement(): boolean;
  IsCasting(): boolean;
  State(skillId?: number): SkillCastState;
  Accept(cast: ActiveSkillCast, cooldownMs: number, globalCooldownMs: number): SkillCastState;
  Queue(command: SkillCastCommand, deadlineAtMs: number): SkillCastState;
  TakeQueued(): SkillCastCommand | undefined;
  ClearQueued(): SkillCastState;
  UpdateChannel(castId: bigint, nextTickAtMs: number, channelTicksCompleted: number): SkillCastState;
  ExtendActiveCast(castId: bigint, extensionMs: number): SkillCastState | undefined;
  ReduceActiveCast(castId: bigint, reductionMs: number, nowMs: number): SkillCastState | undefined;
  ReadyAt(skillId: number): number;
  ItemReadyAt(itemConfigId: number): number;
  TryCommitItemCooldown(itemConfigId: number, cooldownMs: number, globalCooldownMs: number): ItemCooldownCommitResult;
  PlanItemCooldown(itemConfigId: number, cooldownMs: number, globalCooldownMs: number): ItemCooldownPlan;
  CommitItemCooldownPlan(plan: ItemCooldownPlan): ItemCooldownCommitResult;
  ApplyCommittedItemCooldown(plan: ItemCooldownPlan): ItemCooldownCommitResult;
  Complete(castId: bigint): SkillCastState;
  Interrupt(reason: string): SkillCastState | undefined;
  ActiveCast(): ActiveSkillCast | undefined;
  CaptureTransfer(): SkillTransferState;
  RestoreTransfer(state: SkillTransferState): void;
}

/** Unit级施法状态；目标选择、距离和效果投影由MMORPG技能适配层完成。
 * Unit cast state; target selection, range, and effect projection live in the
 * MMORPG skill adapter.
 */
@component()
@transferable()
@lifecycle({ destroy: true })
export class SkillComponent extends Component {
  protected activeCast: ActiveSkillCast | null = null;
  protected queuedCast: QueuedSkillCast | null = null;
  protected globalCooldownEndAtMs = 0;
  protected readonly cooldownEndBySkillId = new Map<number, number>();
  protected readonly cooldownEndByItemConfigId = new Map<number, number>();
  protected lastInterruptReason = "";
}
