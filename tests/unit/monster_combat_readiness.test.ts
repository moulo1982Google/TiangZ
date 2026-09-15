import { expect, test, vi } from "vitest";
vi.mock("#tiangz/model", async original => ({ ...await original<object>(),
  systemFor: () => () => undefined,
  TimeSystem: { Instance: { ServerNow: 1000 } },
  PlayerUnit: class { UnitId = 7; IsDisposed = false; alive = 1; GetComponent() { return this; } },
}));
import { PlayerUnit } from "#tiangz/model";
import { MonsterComponentSystem } from "../../app/hotfix/mmorpg/monster/MonsterComponentSystem";

function fixture() {
  const target = new (PlayerUnit as any)();
  const monster: any = { UnitId: 9, IsDisposed: false, alive: 1, GetComponent() { return this; } };
  const state = { targetUnitId: 7, nextAttackAtMs: 1350, returningToSpawn: false };
  const context: any = { RequireMapUnit: vi.fn(), runtime: new Map([[9, state]]), units: { Get: () => target } };
  const read = () => MonsterComponentSystem.prototype.CombatReadiness.call(context, monster);
  return { target, monster, state, context, read };
}

test("combat readiness is a detached, frozen view and does not advance attack state", () => {
  const f = fixture();
  const first = f.read();
  expect(first).toEqual({ targetUnitId: 7, attackRemainingMs: 350 });
  expect(Object.isFrozen(first)).toBe(true);
  expect(f.state.nextAttackAtMs).toBe(1350);
  f.state.nextAttackAtMs = 800;
  expect(f.read().attackRemainingMs).toBe(0);
  expect(first.attackRemainingMs).toBe(350);
});

test("death, invalid targets, return and removed runtime clear combat readiness", () => {
  for (const invalidate of [
    (f: ReturnType<typeof fixture>) => { f.monster.alive = 0; },
    (f: ReturnType<typeof fixture>) => { f.target.alive = 0; },
    (f: ReturnType<typeof fixture>) => { f.target.IsDisposed = true; },
    (f: ReturnType<typeof fixture>) => { f.context.units.Get = () => undefined; },
    (f: ReturnType<typeof fixture>) => { f.state.returningToSpawn = true; },
    (f: ReturnType<typeof fixture>) => { f.context.runtime.clear(); },
  ]) {
    const f = fixture(); invalidate(f);
    expect(f.read()).toEqual({ targetUnitId: 0, attackRemainingMs: 0 });
  }
});

test("readiness retains the owning-map boundary", () => {
  const f = fixture();
  f.context.RequireMapUnit = () => { throw new Error("another map"); };
  expect(f.read).toThrow("another map");
});
