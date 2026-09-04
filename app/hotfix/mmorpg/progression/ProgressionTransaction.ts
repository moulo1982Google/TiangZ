import {
  NumericComponent,
  NumericType,
  PlayerContentProfileComponent,
  type PlayerUnit,
  type ProgressionRewardResult,
} from "#tiangz/model";
import { LevelFromExperience } from "./ProgressionRules";

export interface ProgressionRewardPlan extends ProgressionRewardResult {
  readonly numerics: readonly { readonly numericType: number; readonly value: bigint }[];
}

/** 在不修改玩家的情况下规划累计经验更新。 / Plans a cumulative experience update without mutating the player. */
export function PlanExperienceReward(player: PlayerUnit, amount: bigint): ProgressionRewardPlan {
  if (amount < 0n) throw new Error(`experience reward must be non-negative: ${amount}`);
  const numeric = player.GetComponent(NumericComponent);
  const currentLevel = numeric[NumericType.Level];
  const experience = numeric[NumericType.Experience] + amount;
  const progressionLevels = player.DomainScene()
    .TryGetComponent(PlayerContentProfileComponent)
    ?.TryGet(player.PlayerConfigId)
    ?.progressionLevels;
  const level = LevelFromExperience(experience, progressionLevels);
  const values = new Map(
    numeric.Snapshot().map(({ numericType, value }) => [numericType, value] as const),
  );
  for (const entry of progressionLevels?.[Number(level) - 1]?.numerics ?? []) {
    values.set(entry.numericType, BigInt(entry.value));
  }
  values.set(NumericType.Level, level);
  values.set(NumericType.Experience, experience);
  const numerics = [...values.entries()]
    .sort(([left], [right]) => left - right)
    .map(([numericType, value]) => ({ numericType, value }));
  return {
    level,
    experience,
    gainedExperience: amount,
    leveledUp: level > currentLevel,
    numerics,
  };
}

/** 协调已提交的经验回执，不让较新的在线状态倒退。 / Reconciles a committed experience receipt without moving newer online state backwards. */
export function ApplyCommittedExperienceReward(
  player: PlayerUnit,
  result: ProgressionRewardResult,
): void {
  validateProgressionReward(result);
  const numeric = player.GetComponent(NumericComponent);
  const currentExperience = numeric[NumericType.Experience];
  const currentLevel = numeric[NumericType.Level];
  if (currentExperience > result.experience) return;
  if (currentExperience === result.experience && currentLevel > result.level) return;
  const progressionLevel = player.DomainScene()
    .TryGetComponent(PlayerContentProfileComponent)
    ?.TryGet(player.PlayerConfigId)
    ?.progressionLevels?.[Number(result.level) - 1];
  for (const entry of progressionLevel?.numerics ?? []) {
    numeric[entry.numericType] = BigInt(entry.value);
  }
  numeric[NumericType.Experience] = result.experience;
  numeric[NumericType.Level] = result.level;
}

function validateProgressionReward(result: ProgressionRewardResult): void {
  if (
    result.level <= 0n ||
    result.experience < 0n ||
    result.gainedExperience < 0n ||
    result.gainedExperience > result.experience
  ) {
    throw new Error("invalid committed progression reward");
  }
}
