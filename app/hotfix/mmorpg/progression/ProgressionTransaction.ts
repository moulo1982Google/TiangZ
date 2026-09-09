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
  // 等级档位只在升级时应用；同级奖励必须保留已经消耗的在线资源。
  // Apply the level profile only on advancement; same-level rewards preserve spent resources.
  if (level > currentLevel) {
    for (const entry of progressionLevels?.[Number(level) - 1]?.numerics ?? []) {
      values.set(entry.numericType, BigInt(entry.value));
    }
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
  // 回执重放不能重复应用升级数值，否则会覆盖提交后的资源消耗。
  // Receipt replay must not reapply level values over resource use after the original commit.
  if (result.level > currentLevel) {
    for (const entry of progressionLevel?.numerics ?? []) {
      numeric[entry.numericType] = BigInt(entry.value);
    }
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
