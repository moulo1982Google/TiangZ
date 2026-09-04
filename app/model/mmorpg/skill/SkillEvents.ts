import {
  defineSyncEvent,
  defineVetoEvent,
  SystemErrCode,
  type Unit,
} from "../../../core/public";
import type { DamageSchoolValue } from "../combat/CombatComponent";
import type { SkillDefinition } from "./SkillDefinition";
import type { SkillCastState } from "./SkillComponent";

/** 施法提交前的同步只读上下文；监听器不得改冷却、Buff、Numeric或目标。 / Synchronous read-only context before cast commit; listeners must not mutate cooldowns, Buffs, Numerics, or targets. */
export interface BeforeCastSkillEvent {
  readonly caster: Unit<any[]>;
  readonly target: Unit<any[]>;
  readonly definition: SkillDefinition;
}

/** 技能已提交资源、冷却和施法状态后的同步事实。 / Synchronous fact emitted after resources, cooldowns, and cast state are committed. */
export interface SkillCastAcceptedEvent {
  readonly caster: Unit<any[]>;
  readonly target: Unit<any[]>;
  readonly definition: SkillDefinition;
  readonly state: SkillCastState;
}

/**
 * 一次技能效果已经在权威运行时同步结算的事实；扩展只能追加后续领域效果，不能改写既有伤害或冷却。
 * A synchronous fact emitted after one skill impact resolves authoritatively;
 * extensions may append domain effects but cannot rewrite committed damage or cooldowns.
 */
export interface SkillEffectsResolvedEvent {
  readonly caster: Unit<any[]>;
  readonly target: Unit<any[]>;
  readonly definition: SkillDefinition;
  readonly castId: bigint;
  readonly damage: bigint;
  readonly damageSchool: DamageSchoolValue;
  readonly killed: boolean;
}

export const SkillEvents = {
  /** 可扩展模块全部放行后，SkillMapComponent才提交GCD/CD和ActiveCast。 / SkillMapComponent commits GCD/CD and ActiveCast only after every extension allows the cast. */
  BeforeCast: defineVetoEvent<BeforeCastSkillEvent, number>(
    "Skill.BeforeCast",
    SystemErrCode.Success,
  ),
  /** 只报告已接受的施法；外置表现层不得回滚权威状态。 / Reports accepted casts only; presentation adapters must not roll back authority. */
  CastAccepted: defineSyncEvent<SkillCastAcceptedEvent>("Skill.CastAccepted"),
  /** 基础效果提交后发布一次；瞬发、弹道命中和每个引导Tick分别形成独立事实。 / Published once after base effects commit; instant impacts, projectiles, and channel ticks are distinct facts. */
  EffectsResolved: defineSyncEvent<SkillEffectsResolvedEvent>("Skill.EffectsResolved"),
} as const;
