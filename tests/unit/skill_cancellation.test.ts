import { expect, test, vi } from "vitest";

vi.mock("#tiangz/model", async (original) => ({
  ...await original<object>(),
  systemFor: () => () => undefined,
}));

import { SkillMapComponentSystem } from "../../app/hotfix/mmorpg/skill/SkillMapComponentSystem";
import { ActionType, SkillEffectTarget } from "#tiangz/model";
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


test("projectile snapshots detach flight records and never expose effect definitions", () => {
  const flight = {castId:1n,skillId:17,sourceUnitId:7,targetUnitId:9,launchedAtMs:100,impactAtMs:900,definition:{effects:["private"]}};
  const map = {projectiles:new Map([[1n,flight]])};
  const snapshot = () => SkillMapComponentSystem.prototype.Projectiles.call(map as unknown as SkillMapComponentSystem);
  const first=snapshot();
  expect(first).toEqual([{castId:1n,skillId:17,sourceUnitId:7,targetUnitId:9,launchedAtMs:100,impactAtMs:900}]);
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first[0])).toBe(true);
  expect(first[0]).not.toBe(flight);
  expect(() => Object.assign(first[0],{impactAtMs:1})).toThrow();
  flight.impactAtMs=1200;
  expect(first[0].impactAtMs).toBe(900);
  expect(snapshot()[0].impactAtMs).toBe(1200);
  map.projectiles.clear();
  expect(snapshot()).toEqual([]);
  expect(first).toHaveLength(1);
});


test("impact veto prevents effects and emitted healing contains only effective restoration",()=>{
  const caster={UnitId:1},target={UnitId:2},publish=vi.fn(),execute=vi.fn(()=>({healing:{restoredHealing:7n,currentHp:100n}}));
  let veto=0;
  const context={DomainScene:()=>({Events:{Check:()=>veto,Publish:publish}}),executeEffect:execute,spawnPublish:vi.fn()};
  const definition={id:17,effects:[{target:SkillEffectTarget.PrimaryTarget,action:{type:ActionType.Heal,parameters:[90n]}}]};
  const run=()=> (SkillMapComponentSystem.prototype as any).resolveEffects.call(context,caster,target,definition,4n);
  veto=32003;expect(run).toThrow(/BeforeEffects/);expect(execute).not.toHaveBeenCalled();expect(publish).not.toHaveBeenCalled();
  veto=0;run();expect(publish.mock.calls[0]?.[1].healingByTarget).toEqual([{targetUnitId:2,amount:7n}]);
  execute.mockReturnValue({healing:{restoredHealing:0n,currentHp:100n}});run();expect(publish.mock.calls[1]?.[1].healingByTarget).toEqual([]);
});
