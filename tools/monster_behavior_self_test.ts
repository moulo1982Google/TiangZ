import {
  EvaluateMonsterBehavior,
  type MonsterBehaviorAction,
} from "../app/hotfix/mmorpg/monster/MonsterBehaviorTree";
import {
  MonsterWanderPauseMs,
  SelectMonsterInitialWanderDelayMs,
  SelectMonsterWanderPauseMs,
  SelectMonsterWanderPoint,
  ShouldPauseMonsterWander,
} from "../app/hotfix/mmorpg/monster/MonsterAmbientMovement";
import { SelectContentSpawnLevel } from "../app/hotfix/mmorpg/spawn/ContentSpawnLevel";
import {
  RollMonsterBehaviorPermille,
  SelectMonsterBehaviorDelayMs,
  SelectMonsterBehaviorText,
} from "../app/hotfix/mmorpg/monster/MonsterContentBehavior";
import { HotfixSystem } from "../app/core/hotReload/HotfixSystem";
import type { HotfixManifest } from "../app/core/hotReload/contracts";
import {
  CombatStateComponent,
  CombatComponent,
  BuffComponent,
  AutoAttackPhase,
  MapRuntimeProfileComponent,
  MonsterContentBehaviorActionType,
  MonsterContentBehaviorTarget,
  MonsterContentBehaviorTrigger,
  MonsterContentIdleActionTarget,
  MonsterContentIdleActionType,
  MonsterContentWaypointActionType,
  MonsterContentProfileComponent,
  MonsterEvents,
  UnitPresentationType,
  MonsterSpawnProfileComponent,
  NativeData,
  NativeUnitRef,
  NumericComponent,
  NumericRegenerationComponent,
  NumericType,
  SpatialMode,
  SkillComponent,
  type MonsterRuntimeState,
  type MonsterContentIdleAction,
  type MonsterContentSpawn,
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
  readonly PlayerConfigId: number;
  GetComponent(componentType: unknown):
    | { alive: number; Handle: number }
    | { x: number; z: number }
    | FakeCombatState;
  TryGetComponent(componentType: unknown): undefined;
}

interface FakeCombatState {
  AddMonster(monsterUnitId: number, nowMs: number): void;
}

async function main(): Promise<void> {
  verifyExternalMapAndSpawnProfiles();
  verifyAmbientMovementContentAndPlanning();
  verifyContentBehaviorRules();
  await verifyThreatRatioAndLongRangeSelection();
  verifyAttackDamageCodecPreservesUint64();
  console.log("[monster-behavior] self-test passed");
}

async function verifyAuraStateBehaviorRuntime(): Promise<void> {
  const { MonsterComponentSystem } = await import(
    "../app/hotfix/mmorpg/monster/MonsterComponentSystem"
  );
  let present = false;
  let actionTargetBuffPresent = false;
  let evadeCount = 0;
  const published: Array<{ action: { abilityId?: number }; target?: { UnitId: number } }> = [];
  const monster = {
    UnitId: 9_001,
    AreaId: 9_002,
    GetComponent(componentType: unknown): unknown {
      if (componentType === BuffComponent) return { HasBuffConfig: () => present };
      if (componentType === NumericComponent) return {
        [NumericType.CurrentHp]: 40n,
        [NumericType.MaxHp]: 100n,
      };
      throw new Error("unexpected component in aura behavior fixture");
    },
  };
  const state: MonsterRuntimeState = {
    targetUnitId: 0,
    threatByUnitId: new Map(),
    lootOwnerAccount: null,
    nextThinkAtMs: 0,
    nextAttackAtMs: 0,
    navigationSequence: 0,
    behaviorEncounterSequence: 0,
    triggeredBehaviorRuleIds: new Set(),
    behaviorBuffStates: new Map(),
    behaviorRuleNextAtMs: new Map(),
    behaviorRuleExecutionSequences: new Map(),
    idleSequenceStates: new Map(),
    ambientWaypointIndex: 0,
    ambientWaypointActiveIndex: -1,
    ambientWaypointArrivedAtMs: 0,
    ambientWaypointActionIndex: 0,
    ambientWaypointArrivalSequence: 0,
    ambientWaypointWanderRadius: 0,
    ambientWaypointWanderPauseUntilMs: 0,
    ambientPauseUntilMs: 0,
    ambientWanderSequence: 0,
    ambientWanderLegsSincePause: 0,
    ambientTarget: null,
    combatReturnPoint: null,
    returningToSpawn: false,
  };
  const slots = new Map([[monster.AreaId, {
    config: { id: 9_003 },
    definition: {
      behaviorRules: [{
        id: 1,
        trigger: MonsterContentBehaviorTrigger.AuraState,
        chancePermille: 1_000,
        requiredBuffDefinitionId: 9_004,
        requiredBuffPresent: true,
        repeatDelayMinMs: 10_000,
        repeatDelayMaxMs: 10_000,
        actions: [{
          type: MonsterContentBehaviorActionType.ExecuteAbility,
          target: MonsterContentBehaviorTarget.Self,
          abilityId: 9_005,
        }],
      }, {
        id: 2,
        trigger: MonsterContentBehaviorTrigger.AuraState,
        chancePermille: 1_000,
        requiredBuffDefinitionId: 9_004,
        requiredBuffPresent: false,
        repeatDelayMinMs: 10_000,
        repeatDelayMaxMs: 10_000,
        actions: [{
          type: MonsterContentBehaviorActionType.Evade,
          target: MonsterContentBehaviorTarget.Self,
        }],
      }, {
        id: 3,
        trigger: MonsterContentBehaviorTrigger.Death,
        chancePermille: 1_000,
        actions: [{
          type: MonsterContentBehaviorActionType.ExecuteAbility,
          target: MonsterContentBehaviorTarget.CombatTarget,
          abilityId: 9_006,
        }],
      }, {
        id: 4,
        trigger: MonsterContentBehaviorTrigger.HealthRange,
        chancePermille: 1_000,
        minHealthPermille: 0,
        maxHealthPermille: 500,
        repeatDelayMinMs: 1_000,
        repeatDelayMaxMs: 1_000,
        actions: [{
          type: MonsterContentBehaviorActionType.ExecuteAbility,
          target: MonsterContentBehaviorTarget.CombatTarget,
          abilityId: 9_008,
          requiredAbsentBuffDefinitionId: 9_009,
        }],
      }, {
        id: 5,
        trigger: MonsterContentBehaviorTrigger.CombatInterval,
        chancePermille: 1_000,
        initialDelayMinMs: 1_000,
        initialDelayMaxMs: 1_000,
        repeatDelayMinMs: 2_000,
        repeatDelayMaxMs: 2_000,
        actions: [{
          type: MonsterContentBehaviorActionType.ExecuteAbility,
          target: MonsterContentBehaviorTarget.CombatTarget,
          abilityId: 9_010,
        }],
      }, {
        id: 6,
        trigger: MonsterContentBehaviorTrigger.Spawned,
        chancePermille: 1_000,
        actions: [{
          type: MonsterContentBehaviorActionType.ExecuteAbility,
          target: MonsterContentBehaviorTarget.Self,
          abilityId: 9_011,
        }],
      }, {
        id: 7,
        trigger: MonsterContentBehaviorTrigger.ExternalSignal,
        chancePermille: 1_000,
        requiredSignalId: 78,
        repeatDelayMinMs: 1_000,
        repeatDelayMaxMs: 1_000,
        actions: [{
          type: MonsterContentBehaviorActionType.ExecuteAbility,
          target: MonsterContentBehaviorTarget.Self,
          abilityId: 9_012,
        }],
      }],
    },
  }]]);
  const system = {
    slots,
    BeginMonsterEvade(): void { evadeCount += 1; },
    DomainScene: () => ({
      Events: {
        Publish(_descriptor: unknown, event: { action: { abilityId?: number } }): void {
          published.push(event);
        },
      },
    }),
  };
  const trigger = MonsterComponentSystem.prototype as unknown as {
    TriggerMonsterBehavior(
      monster: unknown,
      target: unknown,
      state: MonsterRuntimeState,
      trigger: number,
      nowMs: number,
      signalId?: number,
    ): boolean;
  };
  const first = trigger.TriggerMonsterBehavior.call(
    system,
    monster,
    undefined,
    state,
    MonsterContentBehaviorTrigger.AuraState,
    1_000,
  );
  if (!first || evadeCount !== 1 || state.behaviorBuffStates.get(9_004) !== false) {
    throw new Error("initial AuraState observation must dispatch the matching Evade rule once");
  }
  trigger.TriggerMonsterBehavior.call(
    system,
    monster,
    undefined,
    state,
    MonsterContentBehaviorTrigger.AuraState,
    1_250,
  );
  if (evadeCount !== 1 || published.length !== 0) {
    throw new Error("an unchanged AuraState must respect its declared repeat delay");
  }
  present = true;
  const changed = trigger.TriggerMonsterBehavior.call(
    system,
    monster,
    undefined,
    state,
    MonsterContentBehaviorTrigger.AuraState,
    1_500,
  );
  if (changed || published.length !== 1 || published[0]?.action.abilityId !== 9_005) {
    throw new Error("AuraState transition must publish one opaque ability request");
  }
  trigger.TriggerMonsterBehavior.call(
    system,
    monster,
    undefined,
    state,
    MonsterContentBehaviorTrigger.AuraState,
    1_750,
  );
  if (published.length !== 1) throw new Error("present AuraState must respect its declared repeat delay");
  trigger.TriggerMonsterBehavior.call(
    system,
    monster,
    undefined,
    state,
    MonsterContentBehaviorTrigger.AuraState,
    11_500,
  );
  if (published.length !== 2) throw new Error("matched AuraState must repeat after its declared delay");
  trigger.TriggerMonsterBehavior.call(
    system,
    monster,
    undefined,
    state,
    MonsterContentBehaviorTrigger.AuraState,
    11_600,
  );
  if (published.length !== 2) throw new Error("AuraState repeat delay must suppress early polling");
  present = false;
  trigger.TriggerMonsterBehavior.call(
    system,
    monster,
    undefined,
    state,
    MonsterContentBehaviorTrigger.AuraState,
    12_000,
  );
  if (evadeCount !== 2) throw new Error("absent AuraState must repeat on its own source timer");
  const deathTarget = { UnitId: 9_007 };
  trigger.TriggerMonsterBehavior.call(
    system,
    monster,
    deathTarget,
    state,
    MonsterContentBehaviorTrigger.Death,
    13_000,
  );
  if (published.length !== 3
    || published[2]?.action.abilityId !== 9_006
    || published[2]?.target?.UnitId !== deathTarget.UnitId) {
    throw new Error("Death behavior must dispatch its opaque ability request to the invoker");
  }
  const healthTarget = {
    UnitId: 9_009,
    TryGetComponent(componentType: unknown): unknown {
      if (componentType === BuffComponent) {
        return { HasBuffConfig: () => actionTargetBuffPresent };
      }
      return undefined;
    },
  };
  trigger.TriggerMonsterBehavior.call(
    system,
    monster,
    healthTarget,
    state,
    MonsterContentBehaviorTrigger.HealthRange,
    20_000,
  );
  trigger.TriggerMonsterBehavior.call(
    system,
    monster,
    healthTarget,
    state,
    MonsterContentBehaviorTrigger.HealthRange,
    20_500,
  );
  if (published.length !== 4 || published[3]?.action.abilityId !== 9_008) {
    throw new Error("repeatable HealthRange must suppress evaluation before its next deadline");
  }
  trigger.TriggerMonsterBehavior.call(
    system,
    monster,
    healthTarget,
    state,
    MonsterContentBehaviorTrigger.HealthRange,
    21_000,
  );
  if (published.length !== 5 || published[4]?.target?.UnitId !== healthTarget.UnitId) {
    throw new Error("repeatable HealthRange must run again at its declared deadline");
  }
  actionTargetBuffPresent = true;
  trigger.TriggerMonsterBehavior.call(
    system,
    monster,
    healthTarget,
    state,
    MonsterContentBehaviorTrigger.HealthRange,
    22_000,
  );
  if (published.length !== 5) {
    throw new Error("behavior action must be skipped while its target already has the required-absent Buff");
  }
  actionTargetBuffPresent = false;
  trigger.TriggerMonsterBehavior.call(
    system,
    monster,
    healthTarget,
    state,
    MonsterContentBehaviorTrigger.CombatInterval,
    30_000,
  );
  trigger.TriggerMonsterBehavior.call(
    system,
    monster,
    healthTarget,
    state,
    MonsterContentBehaviorTrigger.CombatInterval,
    30_500,
  );
  if (published.length !== 5) {
    throw new Error("CombatInterval must wait for its initial delay");
  }
  trigger.TriggerMonsterBehavior.call(
    system,
    monster,
    healthTarget,
    state,
    MonsterContentBehaviorTrigger.CombatInterval,
    31_000,
  );
  if (published.length !== 6 || published[5]?.action.abilityId !== 9_010) {
    throw new Error("CombatInterval must run at its initial deadline");
  }
  trigger.TriggerMonsterBehavior.call(
    system,
    monster,
    healthTarget,
    state,
    MonsterContentBehaviorTrigger.CombatInterval,
    32_999,
  );
  trigger.TriggerMonsterBehavior.call(
    system,
    monster,
    healthTarget,
    state,
    MonsterContentBehaviorTrigger.CombatInterval,
    33_000,
  );
  if (published.length !== 7 || published[6]?.target?.UnitId !== healthTarget.UnitId) {
    throw new Error("CombatInterval must repeat on its declared cadence");
  }
  trigger.TriggerMonsterBehavior.call(
    system,
    monster,
    undefined,
    state,
    MonsterContentBehaviorTrigger.Spawned,
    34_000,
  );
  if (published.length !== 8
    || published[7]?.action.abilityId !== 9_011
    || published[7]?.target !== undefined) {
    throw new Error("Spawned behavior must dispatch one self-owned request without a combat target");
  }
  trigger.TriggerMonsterBehavior.call(
    system,
    monster,
    healthTarget,
    state,
    MonsterContentBehaviorTrigger.ExternalSignal,
    35_000,
    77,
  );
  trigger.TriggerMonsterBehavior.call(
    system,
    monster,
    healthTarget,
    state,
    MonsterContentBehaviorTrigger.ExternalSignal,
    35_000,
    78,
  );
  trigger.TriggerMonsterBehavior.call(
    system,
    monster,
    healthTarget,
    state,
    MonsterContentBehaviorTrigger.ExternalSignal,
    35_999,
    78,
  );
  if (published.length !== 9 || published[8]?.action.abilityId !== 9_012) {
    throw new Error("ExternalSignal must match its opaque id and enforce its declared cooldown");
  }
  trigger.TriggerMonsterBehavior.call(
    system,
    monster,
    healthTarget,
    state,
    MonsterContentBehaviorTrigger.ExternalSignal,
    36_000,
    78,
  );
  if (published.length !== 10) {
    throw new Error("ExternalSignal must become eligible again at its declared deadline");
  }
}

function verifyAmbientMovementContentAndPlanning(): void {
  const origin = { x: 5, y: 2, z: -8 };
  const first = SelectMonsterWanderPoint(origin, 10, 9001, 1);
  const repeated = SelectMonsterWanderPoint(origin, 10, 9001, 1);
  const next = SelectMonsterWanderPoint(origin, 10, 9001, 2);
  if (JSON.stringify(first) !== JSON.stringify(repeated)) {
    throw new Error("wander selection must be deterministic for one spawn sequence");
  }
  const firstDistance = Math.hypot(first.x - origin.x, first.z - origin.z);
  if (firstDistance < 3.5 || firstDistance > 10 || JSON.stringify(first) === JSON.stringify(next)) {
    throw new Error("wander selection must remain inside the configured disc and advance");
  }
  const pauseMs = MonsterWanderPauseMs(9001, 1);
  if (pauseMs < 4_000 || pauseMs > 10_000) {
    throw new Error(`wander pause outside supported range: ${pauseMs}`);
  }
  const initialDelayMs = SelectMonsterInitialWanderDelayMs(9001, 1, 5_000);
  const scheduledPauseMs = SelectMonsterWanderPauseMs(9001, 3, 4_000, 8_000);
  if (initialDelayMs < 1 || initialDelayMs > 5_000) {
    throw new Error(`initial wander delay outside configured range: ${initialDelayMs}`);
  }
  if (scheduledPauseMs < 4_000 || scheduledPauseMs > 8_000) {
    throw new Error(`scheduled wander pause outside configured range: ${scheduledPauseMs}`);
  }
  if (!ShouldPauseMonsterWander(9001, 4, 4, 350, 250)) {
    throw new Error("the fourth consecutive wander leg must force a pause");
  }
  const selectedLevels = Array.from(
    { length: 32 },
    (_, generation) => SelectContentSpawnLevel(3, 5, 9001, generation),
  );
  if (selectedLevels.some((level) => level < 3 || level > 5)
    || new Set(selectedLevels).size !== 3
    || SelectContentSpawnLevel(3, 5, 9001, 4) !== SelectContentSpawnLevel(3, 5, 9001, 4)
    || SelectContentSpawnLevel(7, 7, 9001, 0) !== 7) {
    throw new Error("spawn level selection must be deterministic and cover the configured range");
  }

  const content = new MonsterContentProfileComponent({});
  content.Register("org.example.ambient", {
    definitions: [{
      id: 501,
      name: "Patrol Fixture",
      modelId: "1",
      minimumLevel: 3,
      maximumLevel: 5,
      combatStatsByLevel: [
        { level: 3, maxHp: 10, maxMp: 10, attackDamage: 1 },
        { level: 4, maxHp: 12, maxMp: 11, attackDamage: 2 },
        { level: 5, maxHp: 14, maxMp: 12, attackDamage: 3 },
      ],
      maxHp: 10,
      maxMp: 10,
      resourceRegenAmount: 3,
      resourceRegenIntervalMs: 2_000,
      resourceRegenDelayAfterSpendMs: 5_000,
      attackDamage: 1,
      moveSpeed: 7,
      attackRange: 2,
      attackIntervalMs: 2_000,
      attackMode: 0,
      skillId: 0,
      dropTableId: 0,
    }],
    spawns: [{
      id: 601,
      monsterDefinitionId: 501,
      spawnX: 0,
      spawnY: 1,
      spawnZ: 0,
      spawnYaw: 0,
      initialSpawn: true,
      respawnSeconds: 30,
      wanderRadius: 8,
      wanderMoveSpeed: 2.5,
      wanderSchedule: {
        initialDelayMinMs: 1,
        initialDelayMaxMs: 5_000,
        pauseMinMs: 4_000,
        pauseMaxMs: 8_000,
        firstLegPauseChancePermille: 350,
        additionalLegPauseChancePermille: 250,
      },
      waypoints: [{
        x: 3,
        y: 1,
        z: 4,
        yaw: 1.5,
        delayMs: 750,
        moveSpeed: 2.5,
        actions: [{
          id: 91,
          type: MonsterContentWaypointActionType.SetEmoteState,
          delayMs: 250,
          chancePermille: 1_000,
          presentationId: 234,
        }],
      }],
    }],
  });
  const registered = content.GetSpawns()[0];
  if (
    registered.wanderRadius !== 8
    || registered.wanderSchedule?.pauseMaxMs !== 8_000
    || !Object.isFrozen(registered.wanderSchedule)
    || registered.waypoints?.[0]?.delayMs !== 750
    || !Object.isFrozen(registered)
    || !Object.isFrozen(registered.waypoints)
    || !Object.isFrozen(registered.waypoints[0])
    || registered.waypoints[0]?.actions?.[0]?.presentationId !== 234
    || !Object.isFrozen(registered.waypoints[0]?.actions)
    || !Object.isFrozen(registered.waypoints[0]?.actions?.[0])
    || content.GetDefinitions()[0]?.resourceRegenAmount !== 3
    || content.GetDefinitions()[0]?.resourceRegenIntervalMs !== 2_000
    || content.GetDefinitions()[0]?.resourceRegenDelayAfterSpendMs !== 5_000
    || content.GetDefinitions()[0]?.minimumLevel !== 3
    || content.GetDefinitions()[0]?.maximumLevel !== 5
    || content.GetDefinitions()[0]?.combatStatsByLevel?.[2]?.maxHp !== 14
    || !Object.isFrozen(content.GetDefinitions()[0]?.combatStatsByLevel)
    || !Object.isFrozen(content.GetDefinitions()[0]?.combatStatsByLevel?.[0])
  ) {
    throw new Error("ambient spawn data must be retained and deeply frozen");
  }
  assertThrows(
    () => new MonsterContentProfileComponent({}).Register("org.example.invalid-level", {
      definitions: [{
        id: 504,
        name: "Invalid Level Fixture",
        modelId: "1",
        minimumLevel: 5,
        maximumLevel: 3,
        maxHp: 10,
        maxMp: 0,
        attackDamage: 1,
        moveSpeed: 7,
        attackRange: 2,
        attackIntervalMs: 2_000,
        attackMode: 0,
        skillId: 0,
        dropTableId: 0,
      }],
      spawns: [],
    }),
    "level range is inverted",
  );
  assertThrows(
    () => new MonsterContentProfileComponent({}).Register("org.example.partial-level-stats", {
      definitions: [{
        id: 505,
        name: "Partial Level Stats Fixture",
        modelId: "1",
        minimumLevel: 3,
        maximumLevel: 5,
        combatStatsByLevel: [{ level: 3, maxHp: 10, maxMp: 0, attackDamage: 1 }],
        maxHp: 10,
        maxMp: 0,
        attackDamage: 1,
        moveSpeed: 7,
        attackRange: 2,
        attackIntervalMs: 2_000,
        attackMode: 0,
        skillId: 0,
        dropTableId: 0,
      }],
      spawns: [],
    }),
    "must cover 3..5",
  );
  assertThrows(
    () => new MonsterContentProfileComponent({}).Register("org.example.invalid-regen", {
      definitions: [{
        id: 503,
        name: "Invalid Regen Fixture",
        modelId: "1",
        maxHp: 10,
        maxMp: 10,
        resourceRegenAmount: 3,
        attackDamage: 1,
        moveSpeed: 7,
        attackRange: 2,
        attackIntervalMs: 2_000,
        attackMode: 0,
        skillId: 0,
        dropTableId: 0,
      }],
      spawns: [],
    }),
    "resource regeneration requires maxMp, amount, and interval",
  );
  assertThrows(
    () => new MonsterContentProfileComponent({}).Register("org.example.invalid-ambient", {
      definitions: [{
        id: 502,
        name: "Invalid Fixture",
        modelId: "1",
        maxHp: 10,
        maxMp: 0,
        attackDamage: 1,
        moveSpeed: 7,
        attackRange: 2,
        attackIntervalMs: 2_000,
        attackMode: 0,
        skillId: 0,
        dropTableId: 0,
      }],
      spawns: [{
        id: 602,
        monsterDefinitionId: 502,
        spawnX: 0,
        spawnY: 0,
        spawnZ: 0,
        spawnYaw: 0,
        initialSpawn: true,
        respawnSeconds: 0,
        wanderRadius: -1,
      }],
    }),
    "wander radius must not be negative",
  );
}

function verifyContentBehaviorRules(): void {
  const action = {
    type: MonsterContentBehaviorActionType.Say,
    target: MonsterContentBehaviorTarget.CombatTarget,
    textChoices: ["first", "second"],
  } as const;
  const selected = SelectMonsterBehaviorText(action, 601, 1, 1, 0);
  if (selected !== SelectMonsterBehaviorText(action, 601, 1, 1, 0)) {
    throw new Error("behavior text selection must be deterministic");
  }
  const roll = RollMonsterBehaviorPermille(601, 1, 1);
  if (roll < 0 || roll >= 1_000) throw new Error(`behavior roll is invalid: ${roll}`);
  const delay = SelectMonsterBehaviorDelayMs(601, 1, 1, 8_000, 10_000);
  if (delay < 8_000 || delay > 10_000) throw new Error(`behavior delay is invalid: ${delay}`);
  if (delay !== SelectMonsterBehaviorDelayMs(601, 1, 1, 8_000, 10_000)) {
    throw new Error("behavior delay selection must be deterministic");
  }

  const content = new MonsterContentProfileComponent({});
  content.Register("org.example.behavior", {
    definitions: [{
      id: 701,
      name: "Talker",
      modelId: "1",
      maxHp: 10,
      maxMp: 0,
      attackDamage: 1,
      moveSpeed: 7,
      attackRange: 2,
      attackIntervalMs: 2_000,
      attackMode: 1,
      skillId: 0,
      dropTableId: 0,
      behaviorRules: [{
        id: 1,
        trigger: MonsterContentBehaviorTrigger.Engage,
        chancePermille: 300,
        actions: [action],
      }, {
        id: 2,
        trigger: MonsterContentBehaviorTrigger.HealthRange,
        chancePermille: 1_000,
        minHealthPermille: 10,
        maxHealthPermille: 30,
        actions: [{
          type: MonsterContentBehaviorActionType.ApplyBuff,
          target: MonsterContentBehaviorTarget.CombatTarget,
          buffDefinitionId: 335_103_604,
          sourceAbilityId: 335_003_604,
          requiredAbsentBuffDefinitionId: 335_103_604,
        }],
      }, {
        id: 3,
        trigger: MonsterContentBehaviorTrigger.AuraState,
        chancePermille: 1_000,
        requiredBuffDefinitionId: 335_103_605,
        requiredBuffPresent: true,
        repeatDelayMinMs: 0,
        repeatDelayMaxMs: 0,
        actions: [{
          type: MonsterContentBehaviorActionType.Evade,
          target: MonsterContentBehaviorTarget.Self,
        }],
      }, {
        id: 4,
        trigger: MonsterContentBehaviorTrigger.Death,
        chancePermille: 1_000,
        actions: [{
          type: MonsterContentBehaviorActionType.ExecuteAbility,
          target: MonsterContentBehaviorTarget.CombatTarget,
          abilityId: 335_062_014,
        }],
      }, {
        id: 5,
        trigger: MonsterContentBehaviorTrigger.HealthRange,
        chancePermille: 1_000,
        minHealthPermille: 0,
        maxHealthPermille: 500,
        repeatDelayMinMs: 1_000,
        repeatDelayMaxMs: 2_000,
        actions: [{
          type: MonsterContentBehaviorActionType.ExecuteAbility,
          target: MonsterContentBehaviorTarget.CombatTarget,
          abilityId: 335_031_325,
        }],
      }, {
        id: 6,
        trigger: MonsterContentBehaviorTrigger.CombatInterval,
        chancePermille: 1_000,
        initialDelayMinMs: 3_000,
        initialDelayMaxMs: 4_000,
        repeatDelayMinMs: 8_000,
        repeatDelayMaxMs: 9_000,
        actions: [{
          type: MonsterContentBehaviorActionType.ExecuteAbility,
          target: MonsterContentBehaviorTarget.CombatTarget,
          abilityId: 335_037_361,
        }],
      }, {
        id: 7,
        trigger: MonsterContentBehaviorTrigger.Spawned,
        chancePermille: 1_000,
        actions: [{
          type: MonsterContentBehaviorActionType.Emote,
          target: MonsterContentBehaviorTarget.Self,
          presentationId: 1,
        }],
      }, {
        id: 8,
        trigger: MonsterContentBehaviorTrigger.ExternalSignal,
        chancePermille: 300,
        requiredSignalId: 78,
        repeatDelayMinMs: 1_000,
        repeatDelayMaxMs: 1_500,
        actions: [{
          type: MonsterContentBehaviorActionType.Say,
          target: MonsterContentBehaviorTarget.Self,
          textChoices: ["signal response"],
        }],
      }],
    }],
    spawns: [{
      id: 702,
      monsterDefinitionId: 701,
      spawnX: 0,
      spawnY: 0,
      spawnZ: 0,
      spawnYaw: 0,
      initialSpawn: true,
      respawnSeconds: 30,
      idleSequences: [{
        id: 3,
        chancePermille: 1_000,
        initialDelayMinMs: 0,
        initialDelayMaxMs: 0,
        repeatDelayMinMs: 8_000,
        repeatDelayMaxMs: 10_000,
        actions: [{
          id: 31,
          type: MonsterContentIdleActionType.Emote,
          target: MonsterContentIdleActionTarget.StableSpawn,
          targetSpawnId: 703,
          delayMs: 2_000,
          chancePermille: 1_000,
          presentationId: 1,
        }, {
          id: 32,
          type: MonsterContentIdleActionType.Emote,
          target: MonsterContentIdleActionTarget.Self,
          delayMs: 4_000,
          chancePermille: 1_000,
          presentationId: 1,
        }, {
          id: 33,
          type: MonsterContentIdleActionType.Say,
          target: MonsterContentIdleActionTarget.Self,
          delayMs: 6_000,
          chancePermille: 1_000,
          textChoices: ["first idle line", "second idle line"],
        }],
      }],
    }, {
      id: 703,
      monsterDefinitionId: 701,
      spawnX: 1,
      spawnY: 0,
      spawnZ: 0,
      spawnYaw: 0,
      initialSpawn: true,
      respawnSeconds: 30,
    }],
  });
  const rule = content.TryGetDefinition(701)?.behaviorRules?.[0];
  const healthRule = content.TryGetDefinition(701)?.behaviorRules?.[1];
  const auraRule = content.TryGetDefinition(701)?.behaviorRules?.[2];
  const deathRule = content.TryGetDefinition(701)?.behaviorRules?.[3];
  const repeatHealthRule = content.TryGetDefinition(701)?.behaviorRules?.[4];
  const combatIntervalRule = content.TryGetDefinition(701)?.behaviorRules?.[5];
  const spawnedRule = content.TryGetDefinition(701)?.behaviorRules?.[6];
  const externalSignalRule = content.TryGetDefinition(701)?.behaviorRules?.[7];
  if (
    rule?.chancePermille !== 300
    || rule.actions[0]?.textChoices?.length !== 2
    || !Object.isFrozen(rule)
    || !Object.isFrozen(rule.actions)
    || !Object.isFrozen(rule.actions[0]?.textChoices)
  ) throw new Error("monster behavior rules must be retained and deeply frozen");
  if (
    healthRule?.minHealthPermille !== 10
    || healthRule.maxHealthPermille !== 30
    || healthRule.actions[0]?.buffDefinitionId !== 335_103_604
    || healthRule.actions[0]?.requiredAbsentBuffDefinitionId !== 335_103_604
    || !Object.isFrozen(healthRule.actions[0])
  ) throw new Error("health-range Buff behavior must be retained and deeply frozen");
  if (
    auraRule?.requiredBuffDefinitionId !== 335_103_605
    || auraRule?.requiredBuffPresent !== true
    || auraRule?.repeatDelayMinMs !== 0
    || auraRule?.repeatDelayMaxMs !== 0
    || !Object.isFrozen(auraRule)
  ) throw new Error("AuraState repeat timing must be retained and deeply frozen");
  if (
    deathRule?.trigger !== MonsterContentBehaviorTrigger.Death
    || deathRule.actions[0]?.type !== MonsterContentBehaviorActionType.ExecuteAbility
    || deathRule.actions[0]?.abilityId !== 335_062_014
    || !Object.isFrozen(deathRule)
  ) throw new Error("Death behavior requests must be retained and deeply frozen");
  if (
    repeatHealthRule?.repeatDelayMinMs !== 1_000
    || repeatHealthRule.repeatDelayMaxMs !== 2_000
    || !Object.isFrozen(repeatHealthRule)
  ) throw new Error("repeatable health-range timing must be retained and deeply frozen");
  if (
    combatIntervalRule?.trigger !== MonsterContentBehaviorTrigger.CombatInterval
    || combatIntervalRule.initialDelayMinMs !== 3_000
    || combatIntervalRule.initialDelayMaxMs !== 4_000
    || combatIntervalRule.repeatDelayMinMs !== 8_000
    || combatIntervalRule.repeatDelayMaxMs !== 9_000
    || !Object.isFrozen(combatIntervalRule)
  ) throw new Error("combat-interval timing must be retained and deeply frozen");
  if (
    spawnedRule?.trigger !== MonsterContentBehaviorTrigger.Spawned
    || spawnedRule.actions[0]?.type !== MonsterContentBehaviorActionType.Emote
    || spawnedRule.actions[0]?.presentationId !== 1
    || !Object.isFrozen(spawnedRule)
  ) throw new Error("spawned behavior must be retained and deeply frozen");
  if (
    externalSignalRule?.trigger !== MonsterContentBehaviorTrigger.ExternalSignal
    || externalSignalRule.requiredSignalId !== 78
    || externalSignalRule.repeatDelayMinMs !== 1_000
    || externalSignalRule.repeatDelayMaxMs !== 1_500
    || !Object.isFrozen(externalSignalRule)
  ) throw new Error("external-signal id and cooldown must be retained and deeply frozen");
  const idle = content.GetSpawns()[0]?.idleSequences?.[0];
  if (
    idle?.repeatDelayMinMs !== 8_000
    || idle.actions[0]?.targetSpawnId !== 703
    || !Object.isFrozen(idle)
    || !Object.isFrozen(idle.actions)
    || !Object.isFrozen(idle.actions[0])
    || idle.actions[2]?.textChoices?.length !== 2
    || !Object.isFrozen(idle.actions[2]?.textChoices)
  ) throw new Error("idle behavior sequences must be retained and deeply frozen");
}

/** 验证外置游戏可替换地图空间与单个怪物回巢点，且两个模块不能静默覆盖彼此。 / Verifies an external game can replace map spatial data and one monster's home point without allowing two modules to silently overwrite each other. */
function verifyExternalMapAndSpawnProfiles(): void {
  const map = new MapRuntimeProfileComponent({});
  map.Initialize(100, {
    spatialMode: SpatialMode.NavMesh3D,
    widthCells: 60,
    depthCells: 60,
    cellSizeMeters: 1,
    spawnX: -3,
    spawnY: 1,
    spawnZ: -18,
    spawnYaw: 0,
    navigationAsset: "navigation.bin",
    navigationHash: "fixture",
  });
  map.OverrideSpatial("org.example.world", {
    spatialMode: SpatialMode.Grid2D,
    widthCells: 512,
    depthCells: 512,
    cellSizeMeters: 1,
    spawnX: 0,
    spawnY: 0,
    spawnZ: 0,
    spawnYaw: Math.PI / 2,
    navigationAsset: "",
    navigationHash: "",
    externalMovementSnapshots: { maxDeltaMeters: 12 },
  });
  if (
    map.MapConfigId !== 100 ||
    map.Spatial.widthCells !== 512 ||
    map.Spatial.externalMovementSnapshots?.maxDeltaMeters !== 12
  ) {
    throw new Error("external map spatial override was not retained");
  }
  assertThrows(
    () => map.OverrideSpatial("org.example.other", map.Spatial),
    "map spatial profile already belongs to org.example.world",
  );

  const spawn = new MonsterSpawnProfileComponent({});
  spawn.Initialize({ x: -18, y: 0, z: 18, yaw: 0 });
  spawn.Override("org.example.world", { x: -20, y: 3.6134, z: 45, yaw: -2.3990437 });
  if (spawn.Point.x !== -20 || spawn.Point.y !== 3.6134 || spawn.Point.z !== 45) {
    throw new Error("external monster home override was not retained");
  }
  assertThrows(
    () => spawn.Override("org.example.other", spawn.Point),
    "monster spawn profile already belongs to org.example.world",
  );
}

function assertThrows(action: () => void, expected: string): void {
  try {
    action();
  } catch (error) {
    if (String(error).includes(expected)) return;
    throw error;
  }
  throw new Error(`expected failure containing: ${expected}`);
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
  const { CombatComponentSystem } = await import(
    "../app/hotfix/mmorpg/combat/CombatComponentSystem"
  );
  await verifyAuraStateBehaviorRuntime();
  verifyExternalSignalBoundary(
    MonsterComponentSystem.prototype as unknown as {
      TriggerContentSignal(source: unknown, monsterId: number, signalId: number): boolean;
    },
  );
  verifyReadyAutoAttackRetriesWithoutLosingWeaponTime(
    MonsterComponentSystem.prototype as unknown as {
      TickPlayerAutoAttacks(nowMs: number): void;
    },
    new CombatComponentSystem(),
  );
  const monster = fakePositionUnit(2_147_483_648, 0, 0);
  const player = fakePositionUnit(1_001, 30, 0);
  const state: MonsterRuntimeState = {
    targetUnitId: 0,
    threatByUnitId: new Map(),
    lootOwnerAccount: null,
    nextThinkAtMs: 0,
    nextAttackAtMs: 0,
    navigationSequence: 0,
    behaviorEncounterSequence: 0,
    triggeredBehaviorRuleIds: new Set(),
    behaviorBuffStates: new Map(),
    behaviorRuleNextAtMs: new Map(),
    behaviorRuleExecutionSequences: new Map(),
    idleSequenceStates: new Map(),
    ambientWaypointIndex: 0,
    ambientWaypointActiveIndex: -1,
    ambientWaypointArrivedAtMs: 0,
    ambientWaypointActionIndex: 0,
    ambientWaypointArrivalSequence: 0,
    ambientWaypointWanderRadius: 0,
    ambientWaypointWanderPauseUntilMs: 0,
    ambientPauseUntilMs: 0,
    ambientWanderSequence: 0,
    ambientWanderLegsSincePause: 0,
    ambientTarget: null,
    combatReturnPoint: null,
    returningToSpawn: false,
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
    BeginMonsterEngagement(
      monsterUnit: FakePositionUnit,
      target: FakePositionUnit,
      runtime: MonsterRuntimeState,
    ): void;
    MoveMonsterToward(
      monsterUnit: FakePositionUnit,
      target: { readonly x: number; readonly y: number; readonly z: number },
      runtime: MonsterRuntimeState,
    ): void;
    FindMonsterTarget(
      monsterUnit: FakePositionUnit,
      config: { attackMode: number },
      runtime: MonsterRuntimeState,
    ): FakePositionUnit | undefined;
    FindNearestPlayer(
      monsterUnit: FakePositionUnit,
      maxDistance: number,
      eligiblePlayerConfigIds?: readonly number[],
    ): FakePositionUnit | undefined;
    TickMonsterIdleSequences(
      monster: unknown,
      spawn: Readonly<MonsterContentSpawn>,
      state: MonsterRuntimeState,
      now: number,
    ): void;
    ExecuteMonsterIdleAction(source: unknown, action: MonsterContentIdleAction): void;
    TickMonster(
      monsterUnit: FakePositionUnit,
      config: unknown,
      spawn: Readonly<MonsterContentSpawn>,
      now: number,
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
    BeginMonsterEngagement: methods.BeginMonsterEngagement,
    ClearActiveWaypoint(): void {},
    TriggerMonsterBehavior(): void {},
    MarkCombatThreat: methods.MarkCombatThreat,
  };

  verifyEngagementInterruptsAmbientMovement(methods.BeginMonsterEngagement, monster, player, state);
  verifyNavigationTargetDedup(methods.MoveMonsterToward, monster, state);

  methods.AddThreat.call(fakeSystem, monster, player, 50n);
  methods.AddThreat.call(fakeSystem, monster, player, 5n);
  methods.AddThreat.call(fakeSystem, monster, player, 0n);
  if (state.threatByUnitId.get(player.UnitId) !== 55n) {
    throw new Error(`resolved damage must create 1:1 threat: ${state.threatByUnitId.get(player.UnitId)}`);
  }
  if (methods.FindHighestThreatPlayer.call(fakeSystem, monster, state) !== player) {
    throw new Error("a living 30m threat target must be selected for chase");
  }

  // 玩家在追击途中下线/死亡时，旧目标必须先进入归位流程；不能在同一帧把出生点附近
  // 的另一个玩家当成全新主动索敌目标，否则怪物会永久驻留在离刷点很远的位置。
  // When the chased player disappears or dies, the old engagement must return
  // home before active acquisition may choose another nearby player.
  const nearbyPlayer = fakePositionUnit(1_002, 1, 0);
  state.targetUnitId = player.UnitId;
  state.threatByUnitId.clear();
  const lostTargetSystem = {
    units: {
      Get(): FakePositionUnit | undefined {
        return undefined;
      },
      GetAll(): readonly FakePositionUnit[] {
        return [nearbyPlayer];
      },
    },
    FindHighestThreatPlayer: methods.FindHighestThreatPlayer,
    FindNearestPlayer: methods.FindNearestPlayer,
  };
  const replacement = methods.FindMonsterTarget.call(
    lostTargetSystem,
    monster,
    { attackMode: 1 },
    state,
  );
  if (replacement !== undefined) {
    throw new Error("a lost engagement must return home before active acquisition can run again");
  }
  const eligibleNearbyPlayer = fakePositionUnit(1_003, 2, 0, 2);
  const filteredTarget = methods.FindNearestPlayer.call({
    units: { GetAll: () => [nearbyPlayer, eligibleNearbyPlayer] },
  }, monster, 10, [2]);
  if (filteredTarget !== eligibleNearbyPlayer) {
    throw new Error("active acquisition must honor the module-owned player-template allowlist");
  }

  state.returningToSpawn = true;
  state.targetUnitId = 0;
  methods.AddThreat.call(fakeSystem, monster, player, 10n);
  if (state.threatByUnitId.size !== 0) {
    throw new Error("a returning monster must not accept new threat before reaching home");
  }
  verifyMonsterBehaviorVeto(methods, monster, state);
  verifyIdleSequenceRuntime(methods, state);
  HotfixSystem.Abort("monster behavior self-test complete");
}

function verifyExternalSignalBoundary(methods: {
  TriggerContentSignal(source: unknown, monsterId: number, signalId: number): boolean;
}): void {
  const source = { UnitId: 1_501 };
  const monster = { UnitId: 2_147_483_750 };
  const runtime = {};
  let visible = false;
  let dispatched: readonly unknown[] | undefined;
  const system = {
    RequireMapUnit(candidate: unknown): void {
      if (candidate !== source) throw new Error("unexpected external-signal source");
    },
    monsters: new Map([[monster.UnitId, monster]]),
    runtime: new Map([[monster.UnitId, runtime]]),
    aoi: {
      IsAttached: () => true,
      VisibleUnitIds: () => visible ? [source.UnitId, monster.UnitId] : [source.UnitId],
    },
    TriggerMonsterBehavior(...args: readonly unknown[]): void {
      dispatched = args;
    },
  };
  if (methods.TriggerContentSignal.call(system, source, monster.UnitId, 0)) {
    throw new Error("external signal must reject non-positive module ids");
  }
  if (methods.TriggerContentSignal.call(system, source, monster.UnitId, 78)) {
    throw new Error("external signal must reject targets outside the source AOI");
  }
  visible = true;
  if (!methods.TriggerContentSignal.call(system, source, monster.UnitId, 78)) {
    throw new Error("external signal must accept a visible live monster");
  }
  if (
    dispatched?.[0] !== monster
    || dispatched?.[1] !== source
    || dispatched?.[2] !== runtime
    || dispatched?.[3] !== MonsterContentBehaviorTrigger.ExternalSignal
    || dispatched?.[5] !== 78
  ) {
    throw new Error("external signal boundary did not dispatch the opaque id and source");
  }
}

/** 验证首次进入战斗会立刻交还环境移动控制权，避免高速巡逻怪在下一次5Hz判定前穿过近战目标。 / Verifies first engagement immediately releases ambient movement so a fast patrol cannot cross a melee target before the next 5 Hz decision. */
/** 验证相同导航目标不会在每个5Hz思考周期重建路径，避免客户端看到分段跳步。 / Verifies identical navigation targets do not rebuild a path every 5 Hz think tick, preventing segmented client movement. */
function verifyNavigationTargetDedup(
  moveMonsterToward: (
    monster: FakePositionUnit,
    target: { readonly x: number; readonly y: number; readonly z: number },
    state: MonsterRuntimeState,
  ) => void,
  monster: FakePositionUnit,
  sourceState: MonsterRuntimeState,
): void {
  const nativeData = NativeData as unknown as {
    SetGridMovementTarget(handle: number, cellX: number, cellZ: number, sequence: number): boolean;
  };
  const originalSetTarget = nativeData.SetGridMovementTarget;
  const requests: number[] = [];
  nativeData.SetGridMovementTarget = (_handle, _cellX, _cellZ, sequence): boolean => {
    requests.push(sequence);
    return true;
  };
  const state: MonsterRuntimeState = { ...sourceState, navigationSequence: 0, navigationTarget: null };
  const fakeSystem = {
    map: { SpatialProfile: { spatialMode: SpatialMode.Grid2D, cellSizeMeters: 1 } },
  };
  try {
    moveMonsterToward.call(fakeSystem, monster, { x: 10, y: 0, z: 20 }, state);
    moveMonsterToward.call(fakeSystem, monster, { x: 10.2, y: 0, z: 20 }, state);
    moveMonsterToward.call(fakeSystem, monster, { x: 10.6, y: 0, z: 20 }, state);
  } finally {
    nativeData.SetGridMovementTarget = originalSetTarget;
  }
  if (JSON.stringify(requests) !== JSON.stringify([1, 2])) {
    throw new Error(`identical monster navigation targets were submitted repeatedly: ${JSON.stringify(requests)}`);
  }
}

function verifyEngagementInterruptsAmbientMovement(
  beginEngagement: (
    monster: FakePositionUnit,
    target: FakePositionUnit,
    state: MonsterRuntimeState,
  ) => void,
  monster: FakePositionUnit,
  player: FakePositionUnit,
  state: MonsterRuntimeState,
): void {
  const nativeData = NativeData as unknown as { ResetMovement(handle: number): void };
  const originalResetMovement = nativeData.ResetMovement;
  let resetHandle = 0;
  nativeData.ResetMovement = (handle): void => {
    resetHandle = handle;
  };
  try {
    beginEngagement.call({
      ClearActiveWaypoint(): void {},
      StopMonsterMovement(source: FakePositionUnit, runtime: MonsterRuntimeState): void {
        runtime.navigationTarget = null;
        NativeData.ResetMovement(source.GetComponent(NativeUnitRef).Handle);
      },
      TriggerMonsterBehavior(): void {},
    }, monster, player, state);
  } finally {
    nativeData.ResetMovement = originalResetMovement;
  }
  if (resetHandle !== 1) {
    throw new Error("first engagement did not interrupt the monster's ambient movement");
  }
}

/** 验证移动目标造成的短暂超距或背向不会让完整武器间隔反复归零。 / Verifies a moving target's temporary range or facing failure cannot repeatedly restart the full weapon interval. */
function verifyReadyAutoAttackRetriesWithoutLosingWeaponTime(
  methods: { TickPlayerAutoAttacks(nowMs: number): void },
  combat: {
    AutoAttackState(): {
      readonly phase: number;
      readonly swingStartAtMs: number;
    };
    ToggleAutoAttack(targetUnitId: number, enabled: boolean): unknown;
  },
): void {
  const monster = {
    UnitId: 2_147_483_701,
    GetComponent(componentType: unknown): unknown {
      if (componentType === NativeUnitRef) return { alive: 1 };
      throw new Error("unexpected monster component in auto-attack fixture");
    },
  };
  const numeric = { [NumericType.AttackSpeed]: 2_000n };
  const player = {
    UnitId: 1_701,
    TryGetComponent(componentType: unknown): unknown {
      if (componentType === NumericRegenerationComponent) return undefined;
      throw new Error("unexpected optional player component in auto-attack fixture");
    },
    GetComponent(componentType: unknown): unknown {
      if (componentType === CombatStateComponent) {
        return { TickResources(): void {} };
      }
      if (componentType === NativeUnitRef) return { alive: 1 };
      if (componentType === CombatComponent) return combat;
      if (componentType === NumericComponent) return numeric;
      if (componentType === SkillComponent) return { IsCasting: () => false };
      throw new Error("unexpected player component in auto-attack fixture");
    },
  };
  let attackWindowOpen = false;
  let attackCount = 0;
  const publishedStates: unknown[] = [];
  const system = {
    units: { GetAll: () => [player] },
    monsters: new Map([[monster.UnitId, monster]]),
    CanAutoAttack: () => attackWindowOpen,
    Attack: () => {
      attackCount++;
      return { killed: false };
    },
    PublishAutoAttackState: (_player: unknown, state: unknown) => publishedStates.push(state),
  };

  combat.ToggleAutoAttack(monster.UnitId, true);
  methods.TickPlayerAutoAttacks.call(system, 1_000);
  const started = combat.AutoAttackState();
  if (started.phase !== AutoAttackPhase.Swinging || started.swingStartAtMs !== 1_000) {
    throw new Error("an active auto-attack did not start its weapon clock outside the hit window");
  }

  methods.TickPlayerAutoAttacks.call(system, 3_000);
  const ready = combat.AutoAttackState();
  if (ready.phase !== AutoAttackPhase.Swinging || ready.swingStartAtMs !== 1_000 || attackCount !== 0) {
    throw new Error("a temporarily invalid hit window reset or resolved the ready swing");
  }

  attackWindowOpen = true;
  methods.TickPlayerAutoAttacks.call(system, 3_100);
  const recovered = combat.AutoAttackState();
  if (attackCount !== 1 || recovered.swingStartAtMs !== 3_100 || publishedStates.length !== 2) {
    throw new Error("a ready swing did not resolve on the first valid 10 Hz retry");
  }
}

/** 验证中立否决点会停止已有移动并跳过整个行为Tick。 / Verifies the neutral veto stops existing movement and skips the whole behavior tick. */
function verifyMonsterBehaviorVeto(
  methods: {
    TickMonster(
      monsterUnit: FakePositionUnit,
      config: unknown,
      spawn: Readonly<MonsterContentSpawn>,
      now: number,
    ): void;
  },
  monster: FakePositionUnit,
  state: MonsterRuntimeState,
): void {
  const nativeData = NativeData as unknown as { ResetMovement(handle: number): void };
  const originalResetMovement = nativeData.ResetMovement;
  let resetHandle = 0;
  let observedEvent: { monster: FakePositionUnit; nowMs: number } | undefined;
  nativeData.ResetMovement = (handle): void => {
    resetHandle = handle;
  };
  state.nextThinkAtMs = 0;
  try {
    methods.TickMonster.call({
      runtime: new Map([[monster.UnitId, state]]),
      StopMonsterMovement(source: FakePositionUnit, runtime: MonsterRuntimeState): void {
        runtime.navigationTarget = null;
        NativeData.ResetMovement(source.GetComponent(NativeUnitRef).Handle);
      },
      DomainScene: () => ({
        Events: {
          Check(descriptor: unknown, event: { monster: FakePositionUnit; nowMs: number }): number {
            if (descriptor !== MonsterEvents.BeforeBehavior) {
              throw new Error("monster behavior used the wrong veto descriptor");
            }
            observedEvent = event;
            return 7_001;
          },
        },
      }),
    }, monster, {}, {
      id: 1,
      monsterDefinitionId: 1,
      spawnX: 0,
      spawnY: 0,
      spawnZ: 0,
      spawnYaw: 0,
      initialSpawn: true,
      respawnSeconds: 30,
    }, 10_000);
  } finally {
    nativeData.ResetMovement = originalResetMovement;
  }
  if (observedEvent?.monster !== monster || observedEvent.nowMs !== 10_000) {
    throw new Error("monster behavior veto did not receive the authoritative tick context");
  }
  if (resetHandle !== 1 || state.nextThinkAtMs !== 10_250) {
    throw new Error("monster behavior veto did not stop movement and advance the think deadline");
  }
}

function verifyIdleSequenceRuntime(
  methods: {
    TickMonsterIdleSequences(
      monster: unknown,
      spawn: Readonly<MonsterContentSpawn>,
      state: MonsterRuntimeState,
      now: number,
    ): void;
    ExecuteMonsterIdleAction(source: unknown, action: MonsterContentIdleAction): void;
  },
  state: MonsterRuntimeState,
): void {
  const source = { UnitId: 4_001, AreaId: 801 };
  const partner = { UnitId: 4_002 };
  const spawn: MonsterContentSpawn = {
    id: 801,
    monsterDefinitionId: 701,
    spawnX: 0,
    spawnY: 0,
    spawnZ: 0,
    spawnYaw: 0,
    initialSpawn: true,
    respawnSeconds: 30,
    idleSequences: [{
      id: 1,
      chancePermille: 1_000,
      initialDelayMinMs: 0,
      initialDelayMaxMs: 0,
      repeatDelayMinMs: 8_000,
      repeatDelayMaxMs: 8_000,
      actions: [{
        id: 11,
        type: MonsterContentIdleActionType.Emote,
        target: MonsterContentIdleActionTarget.StableSpawn,
        targetSpawnId: 802,
        delayMs: 2_000,
        chancePermille: 1_000,
        presentationId: 1,
      }, {
        id: 12,
        type: MonsterContentIdleActionType.Emote,
        target: MonsterContentIdleActionTarget.Self,
        delayMs: 4_000,
        chancePermille: 1_000,
        presentationId: 1,
      }, {
        id: 13,
        type: MonsterContentIdleActionType.Say,
        target: MonsterContentIdleActionTarget.Self,
        delayMs: 6_000,
        chancePermille: 1_000,
        textChoices: ["first idle line", "second idle line"],
      }],
    }],
  };
  const presentations: Array<{
    actor: unknown;
    type: number;
    presentationId: number;
    text: string;
  }> = [];
  const system = {
    slots: new Map([[802, { monster: partner }]]),
    ExecuteMonsterIdleAction: methods.ExecuteMonsterIdleAction,
    PublishMonsterPresentation(
      actor: unknown,
      presentation: { type: number; presentationId: number; text: string },
    ): void {
      presentations.push({ actor, ...presentation });
    },
  };
  state.idleSequenceStates.clear();
  methods.TickMonsterIdleSequences.call(system, source, spawn, state, 1_000);
  methods.TickMonsterIdleSequences.call(system, source, spawn, state, 2_999);
  if (presentations.length !== 0) throw new Error("idle action fired before its delay");
  methods.TickMonsterIdleSequences.call(system, source, spawn, state, 3_000);
  methods.TickMonsterIdleSequences.call(system, source, spawn, state, 5_000);
  methods.TickMonsterIdleSequences.call(system, source, spawn, state, 7_000);
  if (
    presentations.length !== 3
    || presentations[0]?.actor !== partner
    || presentations[1]?.actor !== source
    || presentations[2]?.actor !== source
    || presentations[2]?.type !== UnitPresentationType.Say
    || !["first idle line", "second idle line"].includes(presentations[2]?.text ?? "")
  ) throw new Error("idle sequence did not resolve actors and Say presentation in order");
  methods.TickMonsterIdleSequences.call(system, source, spawn, state, 9_000);
  methods.TickMonsterIdleSequences.call(system, source, spawn, state, 11_000);
  if (presentations.length !== 4 || presentations[3]?.actor !== partner) {
    throw new Error("idle sequence did not repeat from its configured interval");
  }
}

function fakePositionUnit(unitId: number, x: number, z: number, playerConfigId = 1): FakePositionUnit {
  const combatState: FakeCombatState = {
    AddMonster(): void {},
  };
  return {
    UnitId: unitId,
    PlayerConfigId: playerConfigId,
    TryGetComponent(): undefined { return undefined; },
    GetComponent(componentType: unknown): { alive: number; Handle: number } | { x: number; z: number } | FakeCombatState {
      if (componentType === NativeUnitRef) return { alive: 1, Handle: 1 };
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
