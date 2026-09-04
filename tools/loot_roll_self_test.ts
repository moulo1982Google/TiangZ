import { runSelfTest } from "./self_test_entry";
import assert from "node:assert/strict";
import {
  ResolveLootTableRows,
  SelectGroupedLootRows,
  SelectIndependentLootRows,
} from "../app/hotfix/mmorpg/loot/LootRoll";

export function main(): void {
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

  const groupedRows = SelectGroupedLootRows([
    { id: 2001, groupId: 7, chancePermille: 600 },
    { id: 2002, groupId: 7, chancePermille: 400 },
    { id: 2101, groupId: 8, chancePermille: 0 },
    { id: 2102, groupId: 8, chancePermille: 0 },
    { id: 2201, chancePermille: 1_000 },
  ], (row) => {
    if (row.id === 2001) return 100;
    if (row.id === 2101) return 750;
    if (row.id === 2201) return 0;
    return 999;
  });
  assert.deepEqual(groupedRows.map((row) => row.id), [2201, 2001, 2102]);

  const groupedMiss = SelectGroupedLootRows([
    { id: 2301, groupId: 9, chancePermille: 250 },
  ], () => 999);
  assert.deepEqual(groupedMiss, []);

  const gatedEqual = SelectGroupedLootRows([
    { id: 2401, groupId: 10, groupGatePermille: 300, chancePermille: 0 },
    { id: 2402, groupId: 10, groupGatePermille: 300, chancePermille: 0 },
  ], (_row, channel) => channel === "group-gate" ? 299 : 750);
  assert.deepEqual(gatedEqual.map((row) => row.id), [2402]);

  const gatedEqualMiss = SelectGroupedLootRows([
    { id: 2501, groupId: 11, groupGatePermille: 300, chancePermille: 0 },
    { id: 2502, groupId: 11, groupGatePermille: 300, chancePermille: 0 },
  ], (_row, channel) => channel === "group-gate" ? 300 : 0);
  assert.deepEqual(gatedEqualMiss, []);

  const mixedExplicitHit = SelectGroupedLootRows([
    { id: 2551, groupId: 12, chancePermille: 600 },
    { id: 2552, groupId: 12, chancePermille: 0 },
    { id: 2553, groupId: 12, chancePermille: 0 },
  ], (_row, channel) => channel === "group-selection" ? 599 : 999);
  assert.deepEqual(mixedExplicitHit.map((row) => row.id), [2551]);

  const mixedEqualFallback = SelectGroupedLootRows([
    { id: 2561, groupId: 13, chancePermille: 600 },
    { id: 2562, groupId: 13, chancePermille: 0 },
    { id: 2563, groupId: 13, chancePermille: 0 },
  ], (_row, channel) => {
    if (channel === "group-selection") return 600;
    if (channel === "group-equal-selection") return 0;
    return 999;
  });
  assert.deepEqual(mixedEqualFallback.map((row) => row.id), [2562]);

  assert.throws(
    () => SelectGroupedLootRows([
      { id: 2571, groupId: 14, chancePermille: 700 },
      { id: 2572, groupId: 14, chancePermille: 400 },
    ], () => 0),
    /exceed 1000 permille/,
  );

  assert.throws(
    () => SelectGroupedLootRows([
      { id: 2581, groupId: 15, chancePermille: 1_000 },
      { id: 2582, groupId: 15, chancePermille: 0 },
    ], () => 0),
    /leave no probability for equal candidates/,
  );

  assert.throws(
    () => SelectGroupedLootRows([
      { id: 2601, groupId: 12, groupGatePermille: 300, chancePermille: 0 },
      { id: 2602, groupId: 12, groupGatePermille: 400, chancePermille: 0 },
    ], () => 0),
    /must share one group gate/,
  );

  assert.throws(
    () => SelectGroupedLootRows([
      { id: 2701, groupGatePermille: 300, chancePermille: 100 },
    ], () => 0),
    /cannot declare a group gate/,
  );

  const nestedTables = new Map<number, readonly {
    readonly id: number;
    readonly groupId?: number;
    readonly nestedDropTableId?: number;
    readonly chancePermille: number;
  }[]>([
    [71, [
      { id: 2801, chancePermille: 1_000 },
      { id: 2802, groupId: 1, nestedDropTableId: 72, chancePermille: 0 },
      { id: 2803, groupId: 1, chancePermille: 0 },
    ]],
    [72, [
      { id: 2901, groupId: 2, chancePermille: 0 },
      { id: 2902, groupId: 2, chancePermille: 0 },
    ]],
  ]);
  const nested = ResolveLootTableRows(
    nestedTables.get(71)!,
    (tableId) => nestedTables.get(tableId) ?? [],
    (row, channel) => {
      if (channel === "independent") return 0;
      if (row.id === 2802) return 100;
      if (row.id === 2901) return 750;
      return 0;
    },
  );
  assert.deepEqual(nested.map((row) => row.id), [2801, 2902]);

  assert.throws(
    () => ResolveLootTableRows(
      [{ id: 3001, nestedDropTableId: 73, chancePermille: 1_000 }],
      () => [{ id: 3002, nestedDropTableId: 73, chancePermille: 1_000 }],
      () => 0,
    ),
    /cycle/,
  );

  console.log("independent and grouped loot roll self-test passed");
}

runSelfTest(main);
