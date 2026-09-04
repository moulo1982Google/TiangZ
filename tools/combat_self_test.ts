import { runSelfTest } from "./self_test_entry";
import assert from "node:assert/strict";
import { Entity, Scene } from "../app/core/runtime/entities";
import { HotfixSystem } from "../app/core/hotReload/HotfixSystem";
import type { HotfixManifest } from "../app/core/hotReload/contracts";
import { NumericType } from "../app/model/mmorpg/numeric/NumericType";
import type { NumericComponent } from "../app/model/mmorpg/numeric/NumericComponent";
import { DamageSchool } from "../app/model/mmorpg/combat/CombatComponent";
import { CombatEvents } from "../app/model/mmorpg/combat/CombatEvents";
import { ResourceFlowDirection } from "../app/model/mmorpg/combat/CombatStateComponent";
import type { SkillDefinition } from "../app/model/mmorpg/skill/SkillDefinition";

/**
 * 这个测试只验证CombatComponent的领域契约，不启动网络和地图Runtime。
 * 它故意不提供BuffComponent，证明伤害结算不需要知道Buff的存在。
 *
 * This test verifies the CombatComponent domain contract without starting the
 * network or map runtime. It intentionally provides no BuffComponent, proving
 * that damage resolution does not need to know that Buffs exist.
 */

interface TestOwner {
  GetComponent<T>(ctor: new (...args: any[]) => T): T;
  TryGetComponent<T>(ctor: new (...args: any[]) => T): T | undefined;
}


export async function main(): Promise<void> {
  HotfixSystem.Begin(testHotfixManifest());
  const { CombatComponentSystem } = await import(
    "../app/hotfix/mmorpg/combat/CombatComponentSystem"
  );
  const { AdvanceResourceFlow } = await import(
    "../app/hotfix/mmorpg/combat/CombatStateComponentSystem"
  );
  const { CommitSkillResourceCosts, PlanSkillResourceCosts } = await import(
    "../app/hotfix/mmorpg/skill/SkillResourceCost"
  );
  HotfixSystem.Commit();

  class TestCombatComponent extends CombatComponentSystem {
    constructor(private readonly owner: TestOwner) {
      super();
    }

    override GetParent<T extends Entity>(): T {
      return this.owner as unknown as T;
    }

    override DomainScene<T extends Scene = Scene>(): T {
      return testScene as unknown as T;
    }
  }

  const resolvedDamageEvents: unknown[] = [];
  const preventableDamageAttempts: unknown[] = [];
  let preventionReason = 0;
  const testScene = {
    Events: {
      Check(descriptor: unknown, event: unknown): number {
        assert.equal(descriptor, CombatEvents.BeforeDamage);
        preventableDamageAttempts.push(event);
        return preventionReason;
      },
      Publish(descriptor: unknown, event: unknown): void {
        assert.equal(descriptor, CombatEvents.DamageResolved);
        resolvedDamageEvents.push(event);
      },
    },
  };

  const numeric = {
    [NumericType.CurrentHp]: 100n,
    [NumericType.MaxHp]: 100n,
  } as unknown as NumericComponent;
  const owner: TestOwner = {
    GetComponent<T>(): T {
      return numeric as unknown as T;
    },
    TryGetComponent<T>(): T | undefined {
      return undefined;
    },
  };
  const combat = new TestCombatComponent(owner);

  assert.equal(combat.AutoAttackRangeMeters(), 2);
  assert.equal(combat.SetAutoAttackRangeMeters(5), 5);
  assert.equal(combat.AutoAttackRangeMeters(), 5);
  assert.throws(() => combat.SetAutoAttackRangeMeters(0), /positive finite number/);
  assert.throws(() => combat.SetAutoAttackRangeMeters(Number.POSITIVE_INFINITY), /positive finite number/);

  const lowPriority = combat.RegisterDamageAbsorber(30n, 10);
  const highPriority = combat.RegisterDamageAbsorber(20n, 20);
  const first = combat.ApplyDamage({ amount: 45n, sourceUnitId: 7 });
  assert.deepEqual(first, {
    requestedDamage: 45n,
    absorbedDamage: 45n,
    finalDamage: 0n,
    remainingHp: 100n,
    killed: false,
    damageSchool: DamageSchool.Physical,
    preventedReason: 0,
    absorptions: [
      { modifierId: highPriority, absorbed: 20n, remaining: 0n },
      { modifierId: lowPriority, absorbed: 25n, remaining: 5n },
    ],
  });
  assert.equal(combat.GetDamageAbsorberRemaining(highPriority), 0n);
  assert.equal(combat.GetDamageAbsorberRemaining(lowPriority), 5n);
  assert.equal(resolvedDamageEvents.length, 1);

  assert.equal(combat.UpdateDamageAbsorber(highPriority, 10n), true);
  const second = combat.ApplyDamage({ amount: 20n });
  assert.equal(second.absorbedDamage, 15n);
  assert.equal(second.finalDamage, 5n);
  assert.equal(second.remainingHp, 95n);
  assert.equal(combat.GetDamageAbsorberRemaining(highPriority), 0n);
  assert.equal(combat.GetDamageAbsorberRemaining(lowPriority), 0n);
  assert.equal(resolvedDamageEvents.length, 2);

  assert.equal(combat.RemoveDamageAbsorber(lowPriority), true);
  assert.equal(combat.RemoveDamageAbsorber(lowPriority), false);
  const third = combat.ApplyDamage({ amount: 10n });
  assert.equal(third.finalDamage, 10n);
  assert.equal(third.remainingHp, 85n);
  assert.equal(resolvedDamageEvents.length, 3);

  const healing = combat.ApplyHealing(100n);
  assert.deepEqual(healing, {
    requestedHealing: 100n,
    restoredHealing: 15n,
    currentHp: 100n,
  });

  numeric[NumericType.IncomingDamageMultiplierBase] = 1_000n;
  numeric[NumericType.IncomingDamageMultiplier] = 500n;
  numeric[NumericType.PhysicalDamageMultiplierBase] = 1_000n;
  numeric[NumericType.PhysicalDamageMultiplier] = 900n;
  const mitigatedPhysical = combat.ApplyDamage({
    amount: 100n,
    damageSchool: DamageSchool.Physical,
  });
  assert.equal(mitigatedPhysical.finalDamage, 45n);
  assert.equal(mitigatedPhysical.absorbedDamage, 0n);
  assert.equal(mitigatedPhysical.remainingHp, 55n);
  combat.ApplyHealing(100n);
  const mitigatedFire = combat.ApplyDamage({ amount: 100n, damageSchool: DamageSchool.Fire });
  assert.equal(mitigatedFire.finalDamage, 50n);
  assert.equal(mitigatedFire.remainingHp, 50n);

  combat.ApplyHealing(100n);
  const publishedBeforePrevention = resolvedDamageEvents.length;
  preventionReason = 77;
  const prevented = combat.ApplyDamage({
    amount: 25n,
    sourceUnitId: 9,
    damageSchool: DamageSchool.Physical,
    canBePrevented: true,
  });
  assert.deepEqual(prevented, {
    requestedDamage: 25n,
    absorbedDamage: 0n,
    finalDamage: 0n,
    remainingHp: 100n,
    killed: false,
    absorptions: [],
    damageSchool: DamageSchool.Physical,
    preventedReason: 77,
  });
  assert.equal(preventableDamageAttempts.length, 1);
  assert.equal((preventableDamageAttempts[0] as { attemptSequence: number }).attemptSequence, 1);
  assert.equal(resolvedDamageEvents.length, publishedBeforePrevention);
  assert.equal(numeric[NumericType.CurrentHp], 100n);
  preventionReason = 0;
  const allowed = combat.ApplyDamage({ amount: 1n, canBePrevented: true });
  assert.equal(allowed.finalDamage, 1n);
  assert.equal(allowed.preventedReason, 0);
  assert.equal(
    (preventableDamageAttempts[1] as { attemptSequence: number }).attemptSequence,
    2,
  );
  assert.throws(() => combat.ApplyDamage({ amount: -1n }), /non-negative bigint/);
  assert.throws(() => combat.ApplyHealing(-1n), /non-negative bigint/);

  const resourceNumeric = {
    [NumericType.CurrentMp]: 100n,
    [NumericType.PrimaryResourceBase]: 60n,
    [NumericType.Experience]: 0n,
  } as unknown as NumericComponent;
  const resourceSkill = {
    id: 635,
    resourceCosts: [{
      currentNumericType: NumericType.CurrentMp,
      fixedAmount: 2n,
      basisNumericType: NumericType.PrimaryResourceBase,
      basisPermille: 290,
    }],
  } as SkillDefinition;
  const plannedCosts = PlanSkillResourceCosts(resourceNumeric, resourceSkill);
  assert.deepEqual(plannedCosts, [{
    currentNumericType: NumericType.CurrentMp,
    amount: 19n,
    available: 100n,
  }]);
  CommitSkillResourceCosts(resourceNumeric, plannedCosts);
  assert.equal(resourceNumeric[NumericType.CurrentMp], 81n);
  assert.throws(() => CommitSkillResourceCosts(resourceNumeric, [
    { currentNumericType: NumericType.CurrentMp, amount: 10n, available: 81n },
    { currentNumericType: NumericType.Experience, amount: 1n, available: 0n },
  ]), /changed before skill cost commit/);
  assert.equal(resourceNumeric[NumericType.CurrentMp], 81n, "resource debit was not atomic");

  const gainFlow = { direction: ResourceFlowDirection.Gain, fullScaleDurationMs: 10_000 };
  const firstFraction = AdvanceResourceFlow(0n, 100n, 50, 0n, gainFlow);
  assert.deepEqual(firstFraction, { value: 0n, remainder: 5_000n });
  assert.deepEqual(
    AdvanceResourceFlow(firstFraction.value, 100n, 50, firstFraction.remainder, gainFlow),
    { value: 1n, remainder: 0n },
  );
  assert.deepEqual(
    AdvanceResourceFlow(1_000n, 1_000n, 8_000, 0n, {
      direction: ResourceFlowDirection.Drain,
      fullScaleDurationMs: 80_000,
    }),
    { value: 900n, remainder: 0n },
  );
  assert.deepEqual(
    AdvanceResourceFlow(120n, 100n, 0, 1n, gainFlow),
    { value: 100n, remainder: 0n },
    "a reduced maximum did not clamp the current resource",
  );

  console.log("combat self-test passed");
}

function testHotfixManifest(): HotfixManifest {
  return {
    formatVersion: 1,
    bundleVersion: "combat-self-test",
    modelFingerprint: "combat-self-test",
    modelSourceHash: "combat-self-test",
    protocolFingerprint: "combat-self-test",
    stableCoreApiHash: "combat-self-test",
    nativeSchemaHash: "combat-self-test",
    hotfixHash: "combat-self-test",
    buildMode: "demo",
  };
}

runSelfTest(main);
