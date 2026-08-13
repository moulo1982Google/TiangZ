import type { ActionDefinition } from "../action/ActionType";
import type { BuffAddOptions } from "../buff/BuffComponent";
import {
  SkillAutoAttackPolicy,
  SkillDelivery,
  SkillEffectTarget,
  SkillMovementPolicy,
  SkillTargetRelation,
} from "../../../generated/model/config";

export {
  SkillAutoAttackPolicy,
  SkillDelivery,
  SkillEffectTarget,
  SkillMovementPolicy,
  SkillTargetRelation,
};
export type SkillTargetRelationValue = SkillTargetRelation;
export type SkillDeliveryValue = SkillDelivery;
export type SkillEffectTargetValue = SkillEffectTarget;
export type SkillMovementPolicyValue = SkillMovementPolicy;
export type SkillAutoAttackPolicyValue = SkillAutoAttackPolicy;

/** 技能的一条有序效果；Buff覆盖参数仍然是纯数据，允许Hotfix替换。 / One ordered skill effect; Buff overrides remain pure data and hot-reloadable. */
export interface SkillEffectDefinition {
  readonly target: SkillEffectTargetValue;
  readonly action: ActionDefinition;
  readonly buffOptions?: BuffAddOptions;
}

/** 将Luban技能与效果表组合后的稳定运行时形状；只在当前Cast内冻结，不能当作Unit长期状态。 / Stable runtime shape composed from Luban skill/effect tables; freeze it only for the current Cast, never as long-lived Unit state. */
export interface SkillDefinition {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly relation: SkillTargetRelationValue;
  readonly castTimeMs: number;
  readonly cooldownMs: number;
  readonly globalCooldownMs: number;
  readonly rangeMeters: number;
  readonly delivery: SkillDeliveryValue;
  readonly projectileSpeedMetersPerSecond: number;
  readonly movementPolicy: SkillMovementPolicyValue;
  readonly autoAttackPolicy: SkillAutoAttackPolicyValue;
  readonly revalidateOnComplete: boolean;
  readonly requiredAbsentBuffConfigId: number;
  /** 当前读条完成前允许缓存下一个技能的时间；0表示不允许队列。 / Queue window before the current cast finishes; 0 disables queuing. */
  readonly queueWindowMs: number;
  /** 引导每跳间隔；0表示普通技能。 / Channel tick interval; 0 means a regular one-shot skill. */
  readonly channelTickMs: number;
  /** 引导总跳数；0表示普通技能。受到攻击时只缩短结束时间，不补发或重置已完成的Tick。 / Total channel ticks; 0 means a regular one-shot skill. Hits shorten the deadline without replaying or resetting completed ticks. */
  readonly channelTicks: number;
  readonly effects: readonly SkillEffectDefinition[];
}
