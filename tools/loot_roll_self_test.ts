import assert from "node:assert/strict";
import { SelectIndependentLootRows } from "../app/hotfix/mmorpg/monster/LootRoll";

interface TestDrop {
  readonly id: number;
  readonly chancePermille: number;
}

const rows: readonly TestDrop[] = [
  { id: 1201, chancePermille: 800 },
  { id: 1001, chancePermille: 150 },
  { id: 1002, chancePermille: 50 },
];

const allRows = SelectIndependentLootRows(rows, () => 0);
assert.deepEqual(allRows.map((row) => row.id), [1201, 1001, 1002]);

const noRows = SelectIndependentLootRows(rows, () => 999);
assert.deepEqual(noRows, []);

const mixedRows = SelectIndependentLootRows(rows, (row) => {
  if (row.id === 1201) return 799;
  if (row.id === 1001) return 150;
  return 49;
});
assert.deepEqual(mixedRows.map((row) => row.id), [1201, 1002]);

console.log("independent loot roll self-test passed");
