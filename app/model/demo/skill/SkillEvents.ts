import { defineVetoEvent, SystemErrCode } from "../../../core/public";
import type { PlayerUnit } from "../map/PlayerUnit";
import type { Unit } from "../../../core/runtime/Unit";
import type { SkillDefinition } from "./SkillDefinition";

/** 施法提交前的同步只读上下文；监听器不得改冷却、Buff、Numeric或目标。 / Synchronous read-only context before cast commit; listeners must not mutate cooldowns, Buffs, Numerics, or targets. */
export interface BeforeCastSkillEvent {
  readonly caster: PlayerUnit;
  readonly target: Unit<any[]>;
  readonly definition: SkillDefinition;
}

export const SkillEvents = {
  /** 可扩展模块全部放行后，SkillMapComponent才提交GCD/CD和ActiveCast。 / SkillMapComponent commits GCD/CD and ActiveCast only after every extension allows the cast. */
  BeforeCast: defineVetoEvent<BeforeCastSkillEvent, number>(
    "Skill.BeforeCast",
    SystemErrCode.Success,
  ),
} as const;
