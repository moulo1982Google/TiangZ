import type { ActionDefinition } from "../action/ActionDefinition";

export interface SkillEffectDefinition {
  readonly target: number;
  readonly action: ActionDefinition;
  readonly buffOptions?: object;
}

/** 技能运行时定义使用数字枚举，具体游戏可以映射自己的配置枚举。 / Runtime skill definitions use numeric enums so each game can map its own config enums. */
export interface SkillDefinition {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly relation: number;
  readonly castTimeMs: number;
  readonly cooldownMs: number;
  readonly globalCooldownMs: number;
  readonly rangeMeters: number;
  readonly delivery: number;
  readonly projectileSpeedMetersPerSecond: number;
  readonly movementPolicy: number;
  readonly autoAttackPolicy: number;
  readonly revalidateOnComplete: boolean;
  readonly requiredAbsentBuffConfigId: number;
  readonly queueWindowMs: number;
  readonly channelTickMs: number;
  readonly channelTicks: number;
  readonly effects: readonly SkillEffectDefinition[];
}
