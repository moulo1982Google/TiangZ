import assert from "node:assert/strict";
import { Entity } from "../app/core/runtime/entities";
import { HotfixSystem } from "../app/core/hotReload/HotfixSystem";
import type { HotfixManifest } from "../app/core/hotReload/contracts";
import { NumericType } from "../app/model/mmorpg/numeric/NumericType";
import type { NumericComponent } from "../app/model/mmorpg/numeric/NumericComponent";
import { DamageSchool } from "../app/model/mmorpg/combat/CombatComponent";

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

void main();

async function main(): Promise<void> {
  HotfixSystem.Begin(testHotfixManifest());
  const { CombatComponentSystem } = await import(
    "../app/hotfix/mmorpg/combat/CombatComponentSystem"
  );
  HotfixSystem.Commit();

  class TestCombatComponent extends CombatComponentSystem {
    constructor(private readonly owner: TestOwner) {
      super();
    }

    override GetParent<T extends Entity>(): T {
      return this.owner as unknown as T;
    }
  }

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
    absorptions: [
      { modifierId: highPriority, absorbed: 20n, remaining: 0n },
      { modifierId: lowPriority, absorbed: 25n, remaining: 5n },
    ],
  });
  assert.equal(combat.GetDamageAbsorberRemaining(highPriority), 0n);
  assert.equal(combat.GetDamageAbsorberRemaining(lowPriority), 5n);

  assert.equal(combat.UpdateDamageAbsorber(highPriority, 10n), true);
  const second = combat.ApplyDamage({ amount: 20n });
  assert.equal(second.absorbedDamage, 15n);
  assert.equal(second.finalDamage, 5n);
  assert.equal(second.remainingHp, 95n);
  assert.equal(combat.GetDamageAbsorberRemaining(highPriority), 0n);
  assert.equal(combat.GetDamageAbsorberRemaining(lowPriority), 0n);

  assert.equal(combat.RemoveDamageAbsorber(lowPriority), true);
  assert.equal(combat.RemoveDamageAbsorber(lowPriority), false);
  const third = combat.ApplyDamage({ amount: 10n });
  assert.equal(third.finalDamage, 10n);
  assert.equal(third.remainingHp, 85n);

  const healing = combat.ApplyHealing(100n);
  assert.deepEqual(healing, {
    requestedHealing: 100n,
    restoredHealing: 15n,
    currentHp: 100n,
  });
  assert.throws(() => combat.ApplyDamage({ amount: -1n }), /non-negative bigint/);
  assert.throws(() => combat.ApplyHealing(-1n), /non-negative bigint/);

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
