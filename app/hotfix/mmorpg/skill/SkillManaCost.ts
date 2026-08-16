/**
 * Starter技能耗蓝表。它暂时是Hotfix里的演示规则，等数值设计稳定后再下沉到SkillConfig，
 * 这样当前不会为了一个尚未确定的字段改动冷配置结构。
 *
 * Starter skill mana costs. This is intentionally a Hotfix rule until the
 * numbers settle; moving it into SkillConfig later will not change the cast API.
 */
const STARTER_SKILL_MANA_COSTS = new Map<number, bigint>([
  [3001, 10n], // 寒冰箭 / Frostbolt
  [3002, 12n], // 火焰冲击；25 / 2按整数向下取整 / Fire Blast; 25 / 2 is floored
  [3003, 7n], // 惩击；15 / 2按整数向下取整 / Smite; 15 / 2 is floored
  [3004, 15n], // 真言术·盾 / Power Word: Shield
  [3005, 10n], // 真言术·韧 / Power Word: Fortitude
  [3006, 7n], // 恢复；15 / 2按整数向下取整 / Recovery; 15 / 2 is floored
  [3007, 15n], // 精神鞭笞 / Mind Flay
]);

export function GetSkillManaCost(skillId: number): bigint {
  return STARTER_SKILL_MANA_COSTS.get(skillId) ?? 0n;
}
