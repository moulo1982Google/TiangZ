import { Component, component, lifecycle, transferable } from "../../../core/public";

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
  readonly interruptReason: string;
}

export interface SkillCastCommand {
  readonly skillId: number;
  readonly targetUnitId: number;
}

export interface SkillCooldownTransferState {
  readonly skillId: number;
  readonly cooldownEndAtMs: number;
}

/** 传送只保留已提交冷却；活动读条在离开源地图时终止。 / Transfer keeps committed cooldowns only; an active cast ends when leaving the source map. */
export interface SkillTransferState {
  readonly globalCooldownEndAtMs: number;
  readonly cooldowns: readonly SkillCooldownTransferState[];
}

export interface SkillComponent {
  Cast(command: SkillCastCommand): SkillCastState;
  InterruptByMovement(): boolean;
  IsCasting(): boolean;
  State(skillId?: number): SkillCastState;
  Accept(cast: ActiveSkillCast, cooldownMs: number, globalCooldownMs: number): SkillCastState;
  ReadyAt(skillId: number): number;
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
  protected globalCooldownEndAtMs = 0;
  protected readonly cooldownEndBySkillId = new Map<number, number>();
  protected lastInterruptReason = "";

}
