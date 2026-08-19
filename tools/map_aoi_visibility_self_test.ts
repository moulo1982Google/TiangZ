import assert from "node:assert/strict";
import {
  coalesceAoiVisibilityChanges,
} from "../app/model/mmorpg/map/AoiVisibility";
import { NumericType } from "../app/model/mmorpg/numeric/NumericType";
import {
  AoiVisibleNumericValues,
} from "../app/model/mmorpg/numeric/NumericReplication";

function main(): void {
  const unique = [
    { observerId: 1, subjectId: 10, visible: true },
    { observerId: 2, subjectId: 10, visible: false },
  ] as const;
  assert.equal(coalesceAoiVisibilityChanges(unique), unique);

  const enterThenLeave = coalesceAoiVisibilityChanges([
    { observerId: 1, subjectId: 10, visible: true },
    { observerId: 1, subjectId: 11, visible: true },
    { observerId: 1, subjectId: 10, visible: false },
  ]);
  assert.deepEqual(enterThenLeave, [
    { observerId: 1, subjectId: 10, visible: false },
    { observerId: 1, subjectId: 11, visible: true },
  ]);

  const leaveThenEnter = coalesceAoiVisibilityChanges([
    { observerId: 3, subjectId: 20, visible: false },
    { observerId: 3, subjectId: 20, visible: true },
  ]);
  assert.deepEqual(leaveThenEnter, [
    { observerId: 3, subjectId: 20, visible: true },
  ]);
  assert.deepEqual(AoiVisibleNumericValues([
    { numericType: NumericType.CurrentHp, value: 100n },
    { numericType: NumericType.CurrentMp, value: 80n },
    { numericType: NumericType.Level, value: 3n },
    { numericType: NumericType.Experience, value: 120n },
    { numericType: NumericType.MaxHp, value: 500n },
    { numericType: NumericType.Attack, value: 25n },
  ]), [
    { numericType: NumericType.CurrentHp, value: 100n },
    { numericType: NumericType.Level, value: 3n },
    { numericType: NumericType.MaxHp, value: 500n },
  ]);
  console.log("AOI visibility and Numeric projection self-test passed");
}

main();
