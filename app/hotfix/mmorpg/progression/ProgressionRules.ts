export const STARTER_MAX_LEVEL = 60n;

/** 返回到达指定等级所需的累计经验；一级门槛为0，二级门槛为100。 / Returns cumulative XP required for a level; level one starts at zero and level two at 100. */
export function ExperienceRequiredForLevel(level: bigint): bigint {
  if (level <= 1n) return 0n;
  const completedLevels = level - 1n;
  return 50n * completedLevels * (completedLevels + 1n);
}

/** 从累计经验计算等级，并在Starter等级上限停止。 / Resolves a level from cumulative XP and clamps it to the Starter cap. */
export function LevelFromExperience(experience: bigint): bigint {
  if (experience < 0n) throw new Error(`experience must be non-negative: ${experience}`);
  let level = 1n;
  while (level < STARTER_MAX_LEVEL && experience >= ExperienceRequiredForLevel(level + 1n)) {
    level += 1n;
  }
  return level;
}
