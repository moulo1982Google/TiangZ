export const STARTER_MAX_LEVEL = 60n;

export interface ExperienceCurveLevel {
  readonly level: number;
  readonly experienceToNextLevel: number;
}

/** 返回到达指定等级所需的累计经验；一级门槛为0，二级门槛为100。 / Returns cumulative XP required for a level; level one starts at zero and level two at 100. */
export function ExperienceRequiredForLevel(level: bigint): bigint {
  if (level <= 1n) return 0n;
  const completedLevels = level - 1n;
  return 50n * completedLevels * (completedLevels + 1n);
}

/** 从累计经验计算等级，并在Starter等级上限停止。 / Resolves a level from cumulative XP and clamps it to the Starter cap. */
export function LevelFromExperience(
  experience: bigint,
  curve?: readonly ExperienceCurveLevel[],
): bigint {
  if (experience < 0n) throw new Error(`experience must be non-negative: ${experience}`);
  if (curve && curve.length > 0) return levelFromExternalCurve(experience, curve);
  let level = 1n;
  while (level < STARTER_MAX_LEVEL && experience >= ExperienceRequiredForLevel(level + 1n)) {
    level += 1n;
  }
  return level;
}

function levelFromExternalCurve(
  experience: bigint,
  curve: readonly ExperienceCurveLevel[],
): bigint {
  let requiredExperience = 0n;
  for (let index = 0; index < curve.length; index += 1) {
    const entry = curve[index];
    if (
      entry.level !== index + 1 ||
      !Number.isSafeInteger(entry.experienceToNextLevel) ||
      entry.experienceToNextLevel < 0
    ) {
      throw new Error("experience curve must be contiguous and non-negative");
    }
    const isFinalLevel = index === curve.length - 1;
    if (isFinalLevel) {
      if (entry.experienceToNextLevel !== 0) {
        throw new Error("experience curve final level must have zero next-level experience");
      }
      return BigInt(entry.level);
    }
    if (entry.experienceToNextLevel === 0) {
      throw new Error(`experience curve level ${entry.level} must require experience`);
    }
    requiredExperience += BigInt(entry.experienceToNextLevel);
    if (experience < requiredExperience) return BigInt(entry.level);
  }
  throw new Error("experience curve must not be empty");
}
