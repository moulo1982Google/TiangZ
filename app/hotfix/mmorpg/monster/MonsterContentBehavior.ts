import type { MonsterContentBehaviorAction } from "#tiangz/model";

/** 返回稳定的0..999判定值，不向内容执行引入可变随机状态。 / Returns a stable 0..999 roll without introducing mutable RNG state into content execution. */
export function RollMonsterBehaviorPermille(
  spawnId: number,
  ruleId: number,
  encounterSequence: number,
): number {
  return stableHash(spawnId, ruleId, encounterSequence, 0x51ed_270b) % 1_000;
}

/** 在声明的闭区间内为一次空闲序列选择稳定延迟。 / Selects a stable delay inside a declared closed interval for one idle-sequence execution. */
export function SelectMonsterBehaviorDelayMs(
  spawnId: number,
  sequenceId: number,
  executionSequence: number,
  minimumMs: number,
  maximumMs: number,
): number {
  if (minimumMs >= maximumMs) return minimumMs;
  const width = maximumMs - minimumMs + 1;
  return minimumMs + stableHash(
    spawnId,
    sequenceId,
    executionSequence,
    0x6d2b_79f5,
  ) % width;
}

/** 为一次已接受的规则执行确定性选择表现文本。 / Deterministically chooses presentation text for one accepted rule execution. */
export function SelectMonsterBehaviorText(
  action: MonsterContentBehaviorAction,
  spawnId: number,
  ruleId: number,
  encounterSequence: number,
  actionIndex: number,
): string | undefined {
  const choices = action.textChoices;
  if (!choices || choices.length === 0) return undefined;
  const index = stableHash(spawnId, ruleId, encounterSequence, actionIndex) % choices.length;
  return choices[index];
}

function stableHash(a: number, b: number, c: number, d: number): number {
  let value = 0x811c_9dc5;
  for (const part of [a, b, c, d]) {
    value ^= part >>> 0;
    value = Math.imul(value, 0x0100_0193);
    value ^= value >>> 16;
  }
  return value >>> 0;
}
