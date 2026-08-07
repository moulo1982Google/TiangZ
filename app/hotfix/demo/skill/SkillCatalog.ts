import {
  ActionType,
  DamageSchool,
  SkillDelivery,
  SkillEffectTarget,
  SkillTargetRelation,
  type SkillDefinition,
} from "#tiangz/model";

const skills = new Map<number, SkillDefinition>([
  [3001, {
    id: 3001,
    name: "寒冰箭",
    description: "读条1.5秒，15米弹道法术，造成50点冰霜伤害并刷新5秒冰冷。",
    relation: SkillTargetRelation.Enemy,
    castTimeMs: 1_500,
    cooldownMs: 0,
    globalCooldownMs: 1_000,
    rangeMeters: 15,
    delivery: SkillDelivery.Projectile,
    projectileSpeedMetersPerSecond: 20,
    requiredAbsentBuffConfigId: 0,
    effects: [
      { target: SkillEffectTarget.PrimaryTarget, action: { type: ActionType.DealDamage, parameters: [50n, BigInt(DamageSchool.Frost)] } },
      { target: SkillEffectTarget.PrimaryTarget, action: { type: ActionType.AddBuff, parameters: [4001n] } },
    ],
  }],
  [3002, {
    id: 3002,
    name: "火焰冲击",
    description: "瞬发，5米，12秒冷却；造成100点火焰伤害，并按施法者刷新6秒灼烧。",
    relation: SkillTargetRelation.Enemy,
    castTimeMs: 0,
    cooldownMs: 12_000,
    globalCooldownMs: 1_000,
    rangeMeters: 5,
    delivery: SkillDelivery.Direct,
    projectileSpeedMetersPerSecond: 0,
    requiredAbsentBuffConfigId: 0,
    effects: [
      { target: SkillEffectTarget.PrimaryTarget, action: { type: ActionType.DealDamage, parameters: [100n, BigInt(DamageSchool.Fire)] } },
      {
        target: SkillEffectTarget.PrimaryTarget,
        action: { type: ActionType.AddBuff, parameters: [4002n] },
        buffOptions: {
          tickAction: { type: ActionType.DealDamage, parameters: [5n, BigInt(DamageSchool.Fire)] },
        },
      },
    ],
  }],
  [3003, {
    id: 3003,
    name: "惩击",
    description: "读条1.5秒，15米直接命中，造成60点神圣伤害。",
    relation: SkillTargetRelation.Enemy,
    castTimeMs: 1_500,
    cooldownMs: 0,
    globalCooldownMs: 1_000,
    rangeMeters: 15,
    delivery: SkillDelivery.Direct,
    projectileSpeedMetersPerSecond: 0,
    requiredAbsentBuffConfigId: 0,
    effects: [
      { target: SkillEffectTarget.PrimaryTarget, action: { type: ActionType.DealDamage, parameters: [60n, BigInt(DamageSchool.Holy)] } },
    ],
  }],
  [3004, {
    id: 3004,
    name: "真言术·盾",
    description: "瞬发，8秒冷却；吸收200点伤害并施加15秒虚弱灵魂。",
    relation: SkillTargetRelation.Friendly,
    castTimeMs: 0,
    cooldownMs: 8_000,
    globalCooldownMs: 1_000,
    rangeMeters: 15,
    delivery: SkillDelivery.Direct,
    projectileSpeedMetersPerSecond: 0,
    requiredAbsentBuffConfigId: 4004,
    effects: [
      {
        target: SkillEffectTarget.PrimaryTarget,
        action: { type: ActionType.AddBuff, parameters: [4003n] },
        buffOptions: { addAction: { type: ActionType.RegisterDamageAbsorber, parameters: [200n] } },
      },
      { target: SkillEffectTarget.PrimaryTarget, action: { type: ActionType.AddBuff, parameters: [4004n] } },
    ],
  }],
  [3005, {
    id: 3005,
    name: "真言术·韧",
    description: "瞬发，持续30分钟，使MaxHp增加500；高等级覆盖低等级。",
    relation: SkillTargetRelation.Friendly,
    castTimeMs: 0,
    cooldownMs: 0,
    globalCooldownMs: 1_000,
    rangeMeters: 15,
    delivery: SkillDelivery.Direct,
    projectileSpeedMetersPerSecond: 0,
    requiredAbsentBuffConfigId: 0,
    effects: [
      { target: SkillEffectTarget.PrimaryTarget, action: { type: ActionType.AddBuff, parameters: [4005n] } },
    ],
  }],
]);

/** Demo数值目录；读取方只保留当前调用栈内引用，热更后重新解析。 / Demo value catalog; callers retain definitions for the current stack only and resolve again after hot reload. */
export function GetSkillDefinition(skillId: number): SkillDefinition {
  const definition = skills.get(skillId);
  if (!definition) throw new Error(`skill config not found: ${skillId}`);
  return definition;
}
