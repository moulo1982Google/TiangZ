/**
 * 普通掉落行的独立判定工具。
 * `chancePermille` 是这一行自己的千分比概率；每一行都单独掷一次，
 * 因此同一具尸体可以同时得到多行，也可以一行都没有。
 *
 * Independent roll helper for regular loot rows. `chancePermille` belongs to
 * the row itself; every row is rolled separately, so one corpse may contain
 * several rows or no row at all.
 */
export interface IndependentLootRow {
  readonly chancePermille: number;
}

/**
 * 按行独立筛选掉落，不修改输入数组，也不负责生成数量或ItemId。
 * 传入的roll必须返回[0, 999]范围内的整数，便于服务端使用可重放的确定性随机。
 *
 * Selects rows independently without mutating the input or allocating item
 * identity. The roll callback must return an integer in [0, 999], allowing the
 * server to use deterministic, replayable randomness.
 */
export function SelectIndependentLootRows<T extends IndependentLootRow>(
  rows: readonly T[],
  roll: (row: T) => number,
): T[] {
  const selected: T[] = [];
  for (const row of rows) {
    if (row.chancePermille > roll(row)) selected.push(row);
  }
  return selected;
}
