import { expect, test, vi } from "vitest";
import { NumericType } from "../../app/model/mmorpg/numeric/NumericType";
import type { DamageCalculator } from "../../app/model/mmorpg/combat/CombatComponent";
import { CombatEvents } from "../../app/model/mmorpg/combat/CombatEvents";
import type { Component } from "../../app/core/public";
vi.mock("#tiangz/model", async original => ({ ...await original<object>(), systemFor: () => () => undefined }));
import { CombatComponentSystem } from "../../app/hotfix/mmorpg/combat/CombatComponentSystem";

function fixture() {
  const hp = { [NumericType.CurrentHp]: 100n };
  const publish = vi.fn();
  const check = vi.fn().mockReturnValue(0);
  const owner = { GetComponent: () => hp, TryGetComponent: () => undefined };
  const combat = new CombatComponentSystem();
  Object.defineProperties(combat, {
    Parent: { value: owner }, GetParent: { value: () => owner },
    DomainScene: { value: () => ({ Events: { Check: check, Publish: publish } }) },
  });
  const calculator = { Parent: owner, IsDisposed: false,
    CalculateDamage: vi.fn((request: { amount: bigint }) => ({ amount: request.amount / 2n, critical: false })),
  };
  return { hp, publish, check, combat, calculator,
    register: () => combat.RegisterDamageCalculator(calculator as unknown as Component & DamageCalculator) };
}

test("owned insulation calculation precedes absorbers and changes health once", () => {
  const f = fixture(); f.register();
  f.combat.RegisterDamageAbsorber(3n);
  const result = f.combat.ApplyDamage({ amount: 20n, periodic: true });
  expect(result.finalDamage).toBe(7n);
  expect(result.absorbedDamage).toBe(3n);
  expect(f.hp[NumericType.CurrentHp]).toBe(93n);
  expect(f.publish).toHaveBeenCalledTimes(1);
  expect(f.calculator.CalculateDamage.mock.calls[0][0]).toMatchObject({ periodic: true });
  expect(Object.isFrozen(f.calculator.CalculateDamage.mock.calls[0][0])).toBe(true);
});

test("veto and invalid calculations do not consume an absorber or health", () => {
  const f = fixture(); f.register();
  const absorber = f.combat.RegisterDamageAbsorber(5n);
  f.check.mockReturnValue(4);
  expect(f.combat.ApplyDamage({ amount: 20n, canBePrevented: true }).preventedReason).toBe(4);
  expect(f.calculator.CalculateDamage).not.toHaveBeenCalled();
  f.calculator.CalculateDamage.mockReturnValue({ amount: -1n, critical: false });
  expect(() => f.combat.ApplyDamage({ amount: 20n })).toThrow("invalid damage calculation");
  expect(f.combat.GetDamageAbsorberRemaining(absorber)).toBe(5n);
  expect(f.hp[NumericType.CurrentHp]).toBe(100n);
  expect(f.publish).toHaveBeenCalledTimes(1);
  expect(f.publish.mock.calls[0][0]).toBe(CombatEvents.DamagePrevented);
});

test("calculator replacement methods stay current and foreign/disposed components fail", () => {
  const f = fixture();
  expect(() => f.combat.RegisterDamageCalculator({ ...f.calculator, Parent: {} } as unknown as Component & DamageCalculator)).toThrow("owner");
  f.register();
  f.calculator.CalculateDamage = vi.fn(() => ({ amount: 30n, critical: true }));
  const result = f.combat.ApplyDamage({ amount: 20n });
  expect(result.critical).toBe(true);
  expect(f.hp[NumericType.CurrentHp]).toBe(70n);
  f.calculator.IsDisposed = true;
  expect(() => f.combat.ApplyDamage({ amount: 20n })).toThrow("no longer valid");
  expect(f.hp[NumericType.CurrentHp]).toBe(70n);
});

test("post-veto rewards can shorten only a current swing without enabling a new one", () => {
  const { combat } = fixture();
  expect(combat.ShortenAutoAttackSwing(100).enabled).toBe(false);
  combat.ToggleAutoAttack(2, true); combat.BeginAutoAttackSwing(10000);
  expect(combat.ShortenAutoAttackSwing(800).swingStartAtMs).toBe(9200);
  combat.ResetAutoAttackSwing();
  expect(combat.ShortenAutoAttackSwing(800).swingStartAtMs).toBe(0);
  expect(() => combat.ShortenAutoAttackSwing(-1)).toThrow();
});
