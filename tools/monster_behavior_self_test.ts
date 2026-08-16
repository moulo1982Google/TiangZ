import {
  EvaluateMonsterBehavior,
  type MonsterBehaviorAction,
} from "../app/hotfix/mmorpg/monster/MonsterBehaviorTree";
import { HotfixSystem } from "../app/core/hotReload/HotfixSystem";
import type { HotfixManifest } from "../app/core/hotReload/contracts";
import {
  CombatStateComponent,
  NativeUnitRef,
  type MonsterRuntimeState,
} from "../app/model/public";
import { InitializeGameSingletons } from "../app/core/runtime/Game";
import { M2C_AttackMonsterCodec } from "../app/generated/model/server/demo/protocol/messages";

assertAction("idle without target", "idle", EvaluateMonsterBehavior({
  mayAggro: true,
  hasTarget: false,
  inAttackRange: false,
  canAttack: true,
}));
assertAction("passive monster stays idle", "idle", EvaluateMonsterBehavior({
  mayAggro: false,
  hasTarget: false,
  inAttackRange: false,
  canAttack: true,
}));
assertAction("target outside range chases", "chase", EvaluateMonsterBehavior({
  mayAggro: true,
  hasTarget: true,
  inAttackRange: false,
  canAttack: true,
}));
assertAction("target in range attacks", "attack", EvaluateMonsterBehavior({
  mayAggro: true,
  hasTarget: true,
  inAttackRange: true,
  canAttack: true,
}));
assertAction("attack cooldown holds position", "hold", EvaluateMonsterBehavior({
  mayAggro: true,
  hasTarget: true,
  inAttackRange: true,
  canAttack: false,
}));

void main();

function assertAction(name: string, expected: MonsterBehaviorAction, actual: MonsterBehaviorAction): void {
  if (actual !== expected) throw new Error(`${name}: expected ${expected}, got ${actual}`);
}

interface FakePositionUnit {
  readonly UnitId: number;
  GetComponent(componentType: unknown):
    | { alive: number }
    | { x: number; z: number }
    | FakeCombatState;
}

interface FakeCombatState {
  AddMonster(monsterUnitId: number, nowMs: number): void;
}

async function main(): Promise<void> {
  await verifyThreatRatioAndLongRangeSelection();
  verifyAttackDamageCodecPreservesUint64();
  console.log("[monster-behavior] self-test passed");
}

/** 验证攻击响应不会把64位伤害降级成JS number。 / Verifies attack responses keep uint64 damage as bigint. */
function verifyAttackDamageCodecPreservesUint64(): void {
  const damage = 9_007_199_254_740_993n;
  const remainingHp = 9_007_199_254_740_992n;
  const decoded = M2C_AttackMonsterCodec.decode(M2C_AttackMonsterCodec.encode({
    monsterId: 1001,
    damage,
    remainingHp,
    killed: false,
  }));
  if (decoded.damage !== damage || decoded.remainingHp !== remainingHp) {
    throw new Error("uint64 attack damage lost bigint precision during codec roundtrip");
  }
}

/** 验证伤害仇恨1:1，并防止主动索敌距离再次错误过滤远程攻击产生的仇恨。 / Verifies 1:1 damage threat and keeps active-acquisition range from filtering ranged-hit threat. */
async function verifyThreatRatioAndLongRangeSelection(): Promise<void> {
  InitializeGameSingletons();
  HotfixSystem.Begin(testHotfixManifest());
  const { MonsterComponentSystem } = await import(
    "../app/hotfix/mmorpg/monster/MonsterComponentSystem"
  );
  const monster = fakePositionUnit(2_147_483_648, 0, 0);
  const player = fakePositionUnit(1_001, 30, 0);
  const state: MonsterRuntimeState = {
    targetUnitId: 0,
    threatByUnitId: new Map(),
    nextThinkAtMs: 0,
    nextAttackAtMs: 0,
    navigationSequence: 0,
  };
  const methods = MonsterComponentSystem.prototype as unknown as {
    AddThreat(monsterUnit: FakePositionUnit, source: FakePositionUnit, amount: bigint): void;
    FindHighestThreatPlayer(monsterUnit: FakePositionUnit, runtime: MonsterRuntimeState): FakePositionUnit | undefined;
    MarkCombatThreat(
      monsterUnit: FakePositionUnit,
      source: FakePositionUnit,
      runtime: MonsterRuntimeState,
      amount: bigint,
      nowMs: number,
    ): void;
  };
  const fakeSystem = {
    runtime: new Map([[monster.UnitId, state]]),
    units: {
      Get(unitId: number): FakePositionUnit | undefined {
        return unitId === player.UnitId ? player : undefined;
      },
    },
    RequireMapUnit(): void {},
    MarkCombatThreat: methods.MarkCombatThreat,
  };

  methods.AddThreat.call(fakeSystem, monster, player, 50n);
  methods.AddThreat.call(fakeSystem, monster, player, 5n);
  methods.AddThreat.call(fakeSystem, monster, player, 0n);
  if (state.threatByUnitId.get(player.UnitId) !== 55n) {
    throw new Error(`resolved damage must create 1:1 threat: ${state.threatByUnitId.get(player.UnitId)}`);
  }
  if (methods.FindHighestThreatPlayer.call(fakeSystem, monster, state) !== player) {
    throw new Error("a living 30m threat target must be selected for chase");
  }
  HotfixSystem.Abort("monster behavior self-test complete");
}

function fakePositionUnit(unitId: number, x: number, z: number): FakePositionUnit {
  const combatState: FakeCombatState = {
    AddMonster(): void {},
  };
  return {
    UnitId: unitId,
    GetComponent(componentType: unknown): { alive: number } | { x: number; z: number } | FakeCombatState {
      if (componentType === NativeUnitRef) return { alive: 1 };
      if (componentType === CombatStateComponent) return combatState;
      return { x, z };
    },
  };
}

function testHotfixManifest(): HotfixManifest {
  return {
    formatVersion: 1,
    bundleVersion: "monster-behavior-self-test",
    modelFingerprint: "monster-behavior-self-test",
    modelSourceHash: "monster-behavior-self-test",
    protocolFingerprint: "monster-behavior-self-test",
    stableCoreApiHash: "monster-behavior-self-test",
    nativeSchemaHash: "monster-behavior-self-test",
    hotfixHash: "monster-behavior-self-test",
    buildMode: "demo",
  };
}
