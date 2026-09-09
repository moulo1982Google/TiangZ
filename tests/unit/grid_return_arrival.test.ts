import { expect, test, vi } from "vitest";
vi.mock("#tiangz/model", async original => ({ ...await original<object>(), systemFor: () => () => undefined }));
import { PositionComponent, SpatialMode } from "../../app/model/public";
import { MonsterComponentSystem } from "../../app/hotfix/mmorpg/monster/MonsterComponentSystem";

function returnTick(spatialMode: number, x = 0, z = 0) {
  const point = { x: 0.49, y: 3, z: 0.49 };
  const state = { nextThinkAtMs: 0, returningToSpawn: true, combatReturnPoint: point };
  const monster = { UnitId: 7, TryGetComponent: () => undefined,
    GetComponent: (type: unknown) => type === PositionComponent ? { x, y: 3, z } : { Point: point } };
  const finish = vi.fn(), move = vi.fn();
  const system = { runtime: new Map([[7, state]]), map: { SpatialProfile: { spatialMode, cellSizeMeters: 1 } },
    DomainScene: () => ({ Events: { Check: () => 0 } }), FinishMonsterReturn: finish,
    SetMonsterMoveSpeed: vi.fn(), MoveMonsterToward: move };
  const methods = MonsterComponentSystem.prototype as unknown as {
    TickMonster(monster: unknown, config: unknown, spawn: unknown, now: number): void;
  };
  methods.TickMonster.call(system, monster, { moveSpeed: 2 }, {}, 1000);
  return { finish, move };
}

test("grid guardian finishes returning at the actual rounded navigation destination", () => {
  const { finish, move } = returnTick(SpatialMode.Grid2D);
  expect(finish).toHaveBeenCalledOnce();
  expect(move).not.toHaveBeenCalled();
});

test("continuous navigation and distant grid positions keep returning", () => {
  expect(returnTick(SpatialMode.NavMesh3D).finish).not.toHaveBeenCalled();
  expect(returnTick(SpatialMode.Grid2D, 2, 2).finish).not.toHaveBeenCalled();
});
