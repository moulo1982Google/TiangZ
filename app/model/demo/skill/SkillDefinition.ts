import type { ActionDefinition } from "../action/ActionType";
import type { BuffAddOptions } from "../buff/BuffComponent";

export const SkillTargetRelation = { Enemy: 1, Friendly: 2 } as const;
export type SkillTargetRelationValue = (typeof SkillTargetRelation)[keyof typeof SkillTargetRelation];

export const SkillDelivery = { Direct: 1, Projectile: 2 } as const;
export type SkillDeliveryValue = (typeof SkillDelivery)[keyof typeof SkillDelivery];

export const SkillEffectTarget = { Caster: 1, PrimaryTarget: 2 } as const;
export type SkillEffectTargetValue = (typeof SkillEffectTarget)[keyof typeof SkillEffectTarget];

/** 技能的一条有序效果；Buff覆盖参数仍然是纯数据，允许Hotfix替换。 / One ordered skill effect; Buff overrides remain pure data and hot-reloadable. */
export interface SkillEffectDefinition {
  readonly target: SkillEffectTargetValue;
  readonly action: ActionDefinition;
  readonly buffOptions?: BuffAddOptions;
}

/** 第一阶段的稳定技能描述形状；数值来源以后可直接换成Luban生成表。 / Stable phase-one skill shape whose values can later be supplied directly by Luban. */
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
  readonly requiredAbsentBuffConfigId: number;
  readonly effects: readonly SkillEffectDefinition[];
}
