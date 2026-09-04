/** 普通掉落行的独立判定输入。 / Independent probability input for a regular loot row. */
export interface IndependentLootRow {
  readonly chancePermille: number;
}

/** 带可选互斥组的中立掉落行；零组保持独立判定。 / Neutral loot row with an optional mutually-exclusive group; group zero remains independent. */
export interface GroupedLootRow extends IndependentLootRow {
  readonly id: number;
  readonly groupId?: number;
  /** 可选组级概率门；零值或省略表示总是进入组内选择。 / Optional group-level gate; zero/omitted always proceeds to member selection. */
  readonly groupGatePermille?: number;
}

/** 可在命中后执行一个子掉落表的中立行。 / Neutral row that may execute one nested loot table after selection. */
export interface NestedLootRow extends GroupedLootRow {
  readonly nestedDropTableId?: number;
}

export type LootRollChannel =
  | "independent"
  | "group-gate"
  | "group-selection"
  | "group-equal-selection";

/** 按行独立筛选掉落，不修改输入。 / Selects rows independently without mutating the input. */
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

/** 独立行各自判定；互斥组可先经过共享门槛再最多选择一行，零概率组员作为等概率余项。 / Rolls independent rows separately; a group may pass one shared gate before selecting at most one member, with zero-chance members as equal fallback entries. */
export function SelectGroupedLootRows<T extends GroupedLootRow>(
  rows: readonly T[],
  roll: (row: T, channel: LootRollChannel) => number,
): T[] {
  const selected: T[] = [];
  const groups = new Map<number, T[]>();
  for (const row of rows) {
    const groupId = row.groupId ?? 0;
    if (groupId <= 0) {
      if ((row.groupGatePermille ?? 0) !== 0) {
        throw new Error(`independent loot row ${row.id} cannot declare a group gate`);
      }
      if (row.chancePermille > roll(row, "independent")) selected.push(row);
      continue;
    }
    const group = groups.get(groupId) ?? [];
    group.push(row);
    groups.set(groupId, group);
  }

  for (const groupId of [...groups.keys()].sort((left, right) => left - right)) {
    const candidates = groups.get(groupId)!;
    const groupGates = new Set(candidates.map((row) => normalizeGroupGate(row)));
    if (groupGates.size !== 1) {
      throw new Error(`loot rows in group ${groupId} must share one group gate`);
    }
    const groupGatePermille = [...groupGates][0];
    if (groupGatePermille < 1_000
      && groupGatePermille <= normalizeLootRoll(roll(candidates[0], "group-gate"))) {
      continue;
    }
    const explicit = candidates.filter((row) => row.chancePermille > 0);
    const equal = candidates.filter((row) => row.chancePermille === 0);
    const explicitTotal = explicit.reduce((total, row) => total + row.chancePermille, 0);
    if (explicitTotal > 1_000) {
      throw new Error(`loot rows in group ${groupId} exceed 1000 permille`);
    }
    if (equal.length > 0 && explicitTotal >= 1_000) {
      throw new Error(`loot rows in group ${groupId} leave no probability for equal candidates`);
    }
    if (explicit.length > 0) {
      const groupRoll = normalizeLootRoll(roll(candidates[0], "group-selection"));
      if (groupRoll < explicitTotal) {
        let cursor = 0;
        for (const row of explicit) {
          cursor += row.chancePermille;
          if (groupRoll < cursor) {
            selected.push(row);
            break;
          }
        }
        continue;
      }
      // A missed explicit range falls through to a separate equal-candidate
      // draw. Reusing groupRoll here would bias or starve early candidates.
    }
    if (equal.length > 0) {
      const equalRoll = normalizeLootRoll(roll(candidates[0], "group-equal-selection"));
      const equalIndex = Math.min(
        equal.length - 1,
        Math.floor((equalRoll * equal.length) / 1_000),
      );
      selected.push(equal[equalIndex]);
    }
  }
  return selected;
}

/** 递归选择掉落内容图并只返回最终奖励行。 / Recursively selects a loot content graph and returns only terminal reward rows. */
export function ResolveLootTableRows<T extends NestedLootRow>(
  rootRows: readonly T[],
  getRows: (dropTableId: number) => readonly T[],
  roll: (row: T, channel: LootRollChannel) => number,
  maxDepth = 16,
): T[] {
  if (!Number.isSafeInteger(maxDepth) || maxDepth <= 0) {
    throw new Error(`loot table maximum depth must be a positive integer: ${maxDepth}`);
  }
  const resolved: T[] = [];
  const visit = (rows: readonly T[], tablePath: readonly number[]): void => {
    if (tablePath.length > maxDepth) {
      throw new Error(`loot table nesting exceeds maximum depth ${maxDepth}`);
    }
    for (const row of SelectGroupedLootRows(rows, roll)) {
      const nestedDropTableId = row.nestedDropTableId ?? 0;
      if (nestedDropTableId <= 0) {
        resolved.push(row);
        continue;
      }
      if (tablePath.includes(nestedDropTableId)) {
        throw new Error(`loot table nesting contains a cycle at table ${nestedDropTableId}`);
      }
      const nestedRows = getRows(nestedDropTableId);
      if (nestedRows.length === 0) {
        throw new Error(`nested loot table ${nestedDropTableId} has no rows`);
      }
      visit(nestedRows, [...tablePath, nestedDropTableId]);
    }
  };
  visit(rootRows, []);
  return resolved;
}

function normalizeGroupGate(row: GroupedLootRow): number {
  const gate = row.groupGatePermille ?? 0;
  if (!Number.isSafeInteger(gate) || gate < 0 || gate > 1_000) {
    throw new Error(`loot row ${row.id} group gate must be an integer in [0, 1000]: ${gate}`);
  }
  return gate === 0 ? 1_000 : gate;
}

function normalizeLootRoll(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 1_000) {
    throw new Error(`loot roll must be an integer in [0, 999]: ${value}`);
  }
  return value;
}
