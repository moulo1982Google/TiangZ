import { expect, test, vi } from "vitest";

vi.mock("#tiangz/model", async (original) => ({
  ...await original<object>(),
  systemFor: () => () => undefined,
}));

import { SkillMapComponentSystem } from "../../app/hotfix/mmorpg/skill/SkillMapComponentSystem";
import { SkillComponentSystem } from "../../app/hotfix/mmorpg/skill/SkillComponentSystem";

test("cancellation fences stale casts and publishes the matching interruption only once", () => {
  const active = { skillId: 17, castId: 102n };
  const cooldowns = new Map([[17, 9000]]);
  const skill = {
    activeCast: active as typeof active | null,
    queuedCast: { skillId: 18 } as { skillId: number } | null,
    lastInterruptReason: "",
    globalCooldownEndAtMs: 5000,
    cooldownEndBySkillId: cooldowns,
    ActiveCast() { return this.activeCast; },
    Interrupt: SkillComponentSystem.prototype.Interrupt,
    State(skillId: number) { return { skillId, phase: 0, interruptReason: this.lastInterruptReason }; },
  };
  const caster = { UnitId: 7, GetComponent: () => skill };
  const publishCastState = vi.fn();
  const map = {
    requireCaster: vi.fn(),
    activeCasterUnitIds: new Set([7]),
    projectiles: new Map([[100n, { target: 9 }]]),
    publishCastState,
  };
  const cancel = (skillId: number, castId: bigint) => SkillMapComponentSystem.prototype.Cancel.call(
    map as unknown as SkillMapComponentSystem, caster as never, skillId, castId,
  );
  expect(cancel(17, 101n)).toBe(false);
  expect(cancel(18, 102n)).toBe(false);
  expect(cancel(17, 0n)).toBe(false);
  expect(skill.activeCast).toBe(active);
  expect(skill.queuedCast).toEqual({ skillId: 18 });
  expect(map.activeCasterUnitIds.has(7)).toBe(true);
  expect(publishCastState).not.toHaveBeenCalled();

  expect(cancel(17, 102n)).toBe(true);
  expect(skill.activeCast).toBeNull();
  expect(skill.queuedCast).toBeNull();
  expect(map.activeCasterUnitIds.has(7)).toBe(false);
  expect(publishCastState).toHaveBeenCalledExactlyOnceWith(caster, {
    skillId: 17, phase: 0, interruptReason: "cancelled",
  });
  expect(cancel(17, 102n)).toBe(false);
  expect(publishCastState).toHaveBeenCalledTimes(1);
  expect(skill.globalCooldownEndAtMs).toBe(5000);
  expect(cooldowns.get(17)).toBe(9000);
  expect(map.projectiles.get(100n)).toEqual({ target: 9 });
});
