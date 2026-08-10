import { Component, component, lifecycle, transferable } from "../../../core/public";
import type { SkillDefinition } from "./SkillDefinition";

export const SkillCastPhase = {
  Idle: 0,
  Casting: 1,
} as const;

export type SkillCastPhaseValue = (typeof SkillCastPhase)[keyof typeof SkillCastPhase];

/** 正在施法的纯运行态；不保存目标Entity引用，目标可能在读条期间销毁。 / Pure active-cast state without a target Entity reference, because targets may disappear while casting. */
export interface ActiveSkillCast {
  readonly castId: bigint;
  readonly skillId: number;
  readonly targetUnitId: number;
  readonly startedAtMs: number;
  readonly finishAtMs: number;
  readonly nextTickAtMs: number;
  readonly channelTicksCompleted: number;
  /** 接受请求时冻结的纯数据规则；配置Reload只影响之后的新Cast。 / Pure rules frozen at acceptance; config reload affects only later Casts. */
  readonly definition: SkillDefinition;
}

/** 客户端只依赖服务器时间绘制读条，不在本地自行判定技能完成。 / Client-facing cast state rendered from server time without local completion authority. */
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

export interface SkillCastCommand {
  readonly skillId: number;
  readonly targetUnitId: number;
}

/** 已缓存但尚未提交冷却的下一个技能；真正Cast时重新做全部目标与Veto校验。 / A queued next skill without committed cooldown; the real Cast repeats all target and veto checks. */
export interface QueuedSkillCast {
  readonly command: SkillCastCommand;
  readonly deadlineAtMs: number;
}

export interface SkillCooldownTransferState {
  readonly skillId: number;
  readonly cooldownEndAtMs: number;
}

export interface ItemCooldownTransferState {
  readonly itemConfigId: number;
  readonly cooldownEndAtMs: number;
}

/** 道具冷却提交结果；Handler用accepted区分拒绝，不需要先检查再写入。 / Atomic item-cooldown commit result so handlers do not split readiness checks from mutation. */
export interface ItemCooldownCommitResult {
  readonly accepted: boolean;
  readonly readyAtMs: number;
  readonly globalCooldownEndAtMs: number;
  readonly itemCooldownEndAtMs: number;
}

/**
 * 道具自身CD与共享GCD的纯数据计划。baseState用于阻止陈旧事务覆盖后续冷却，nextState可进入玩家持久化快照。
 * Pure-value plan for item and shared cooldowns. baseState rejects stale
 * commits, while nextState can be persisted with the player transaction.
 */
export interface ItemCooldownPlan {
  readonly itemConfigId: number;
  readonly baseState: SkillTransferState;
  readonly nextState: SkillTransferState;
  readonly result: ItemCooldownCommitResult;
}

/** 传送只保留已提交冷却；活动读条在离开源地图时终止。 / Transfer keeps committed cooldowns only; an active cast ends when leaving the source map. */
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

/**
 * Unit级技能状态只保存当前读条和冷却截止时间；地图级SkillMapComponent统一以10Hz推进。
 * 组件不注册Update、不创建每次施法Timer，也不保存Hotfix函数闭包。
 *
 * Unit-local skill state stores only the active cast and cooldown deadlines.
 * One map-level SkillMapComponent advances all casts at 10 Hz. This component
 * registers no Update, creates no per-cast Timer, and stores no Hotfix closure.
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
