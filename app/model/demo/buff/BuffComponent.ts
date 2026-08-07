import { Component, component, lifecycle, transferable } from "../../../core/public";
import type { ActionDefinition } from "../action/ActionType";

/**
 * 运行时覆盖Buff配置的可选参数。没有覆盖时，BuffSystem读取BuffConfig。
 * 这是业务扩展点，不允许把不可序列化的闭包塞进来。
 *
 * Optional runtime overrides for BuffConfig. BuffSystem reads the table when
 * a field is absent. This is a business extension point; non-serializable
 * closures must never be placed here.
 */
export interface BuffAddOptions {
  readonly durationMs?: number;
  readonly tickIntervalMs?: number;
  readonly stacks?: number;
  readonly addAction?: ActionDefinition;
  readonly tickAction?: ActionDefinition;
  readonly removeAction?: ActionDefinition;
  /** Buff来源Unit；Source作用域与持续伤害归属都使用它。 / Source Unit used by source-scoped conflicts and periodic damage attribution. */
  readonly sourceUnitId?: number;
  /** 产生Buff的技能；只保存稳定配置ID，不保存Cast对象。 / Stable skill config id that produced the Buff; never stores a Cast object. */
  readonly sourceAbilityId?: number;
  /** 覆盖配置中的冲突强度，供技能等级、天赋和运行时参数使用。 / Overrides configured conflict strength for ranks, talents, and runtime parameters. */
  readonly conflictPriority?: number;
}

export const BuffApplyStatus = {
  Applied: "applied",
  Refreshed: "refreshed",
  Replaced: "replaced",
  Rejected: "rejected",
} as const;

export type BuffApplyStatusValue = (typeof BuffApplyStatus)[keyof typeof BuffApplyStatus];

/** 同步Buff冲突决策的结果；调用者可在同一业务栈中决定回滚或返回错误。 / Result of synchronous Buff conflict resolution for immediate rollback or error handling. */
export interface BuffApplyResult {
  readonly status: BuffApplyStatusValue;
  readonly buff?: import("./Buff").Buff;
  readonly replacedBuffInstanceId?: bigint;
  readonly reason?: "conflict-rejected" | "lower-priority";
}

export interface BuffComponent {
  ApplyBuff(configId: number, options?: BuffAddOptions): BuffApplyResult;
  AddBuff(configId: number, options?: BuffAddOptions): import("./Buff").Buff;
  HasBuffConfig(configId: number): boolean;
  GetBuffs(): readonly import("./Buff").Buff[];
}

/**
 * 一个Unit只拥有一个BuffComponent，多个Buff通过ChildEntity挂载。
 * BuffComponent负责集合、传输和公开快照；单个Buff的Timer由Buff自身拥有。
 *
 * One Unit owns one BuffComponent, while individual Buffs are ChildEntities.
 * BuffComponent owns collection, transfer, and public snapshots; each Buff
 * owns its own timer.
 */
@component()
@transferable()
@lifecycle({ awake: true, destroy: true, deserialize: true })
export class BuffComponent extends Component {
}
