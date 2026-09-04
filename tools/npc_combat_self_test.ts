import assert from "node:assert/strict";

import { HotfixSystem } from "../app/core/hotReload/HotfixSystem";
import type { HotfixManifest } from "../app/core/hotReload/contracts";
import { InitializeGameSingletons } from "../app/core/runtime/Game";
import { ProcessHost } from "../app/core/runtime/host";
import { Scene } from "../app/core/runtime/entities";
import { scene } from "../app/core/runtime/metadata";
import { syncEventHandler, type SyncSceneEventHandler } from "../app/core/runtime/SceneEventSystem";
import { SingletonRegistry } from "../app/core/runtime/Singleton";
import { TimeSystem } from "../app/core/runtime/TimeSystem";
import { UnitComponent } from "../app/core/runtime/Unit";
import type { NativeHostOpsApi } from "../app/generated/model/native/NativeOps";
import { NativeUnitRef } from "../app/generated/model/native/NativeUnitRef";
import { SpatialMode } from "../app/generated/model/config";
import { CombatComponent } from "../app/model/mmorpg/combat/CombatComponent";
import { CombatStateComponent } from "../app/model/mmorpg/combat/CombatStateComponent";
import type { AoiVisibilityDelta, MapAoiComponent } from "../app/model/mmorpg/map/MapAoiComponent";
import { MapComponent } from "../app/model/mmorpg/map/MapComponent";
import { PlayerUnit } from "../app/model/mmorpg/map/PlayerUnit";
import { PositionComponent } from "../app/model/mmorpg/map/PositionComponent";
import { NpcComponent } from "../app/model/mmorpg/npc/NpcComponent";
import {
  NpcCombatBehaviorActionType,
  NpcCombatBehaviorTarget,
  NpcCombatBehaviorTrigger,
  NpcContentProfileComponent,
} from "../app/model/mmorpg/npc/NpcContentProfileComponent";
import { NpcEvents, type NpcCombatActionRequestedEvent } from "../app/model/mmorpg/npc/NpcEvents";
import { NumericComponent } from "../app/model/mmorpg/numeric/NumericComponent";
import { IsDerivedNumericType, NumericType } from "../app/model/mmorpg/numeric/NumericType";
import { SkillComponent } from "../app/model/mmorpg/skill/SkillComponent";
import { SkillMapComponent } from "../app/model/mmorpg/skill/SkillMapComponent";

@scene({ sceneType: "NpcCombatTest" })
class NpcCombatTestScene extends Scene {
  readonly combatAbilityRequests: NpcCombatActionRequestedEvent[] = [];
}

@syncEventHandler(NpcCombatTestScene, NpcEvents.CombatActionRequested, {
  id: "npc-combat-self-test.ability",
})
class NpcCombatAbilityProbe
implements SyncSceneEventHandler<NpcCombatTestScene, NpcCombatActionRequestedEvent> {
  Handle(scene: NpcCombatTestScene, event: NpcCombatActionRequestedEvent): void {
    scene.combatAbilityRequests.push(event);
  }
}

void main();

async function main(): Promise<void> {
  InitializeGameSingletons(
    { fixedUpdateMs: 50, maxCatchUpSteps: 2 },
    { originServerId: 46, workerId: 1 },
  );
  installNativeHostOps();
  HotfixSystem.Begin(testHotfixManifest());
  await import("../app/hotfix/mmorpg/numeric/NumericComponentSystem");
  await import("../app/hotfix/mmorpg/numeric/NumericRegenerationComponentSystem");
  await import("../app/hotfix/mmorpg/combat/CombatComponentSystem");
  await import("../app/hotfix/mmorpg/combat/CombatStateComponentSystem");
  await import("../app/hotfix/mmorpg/buff/BuffComponentSystem");
  await import("../app/hotfix/mmorpg/skill/SkillComponentSystem");
  await import("../app/hotfix/mmorpg/skill/SkillMapComponentSystem");
  await import("../app/hotfix/mmorpg/map/PlayerUnitSystem");
  await import("../app/hotfix/mmorpg/npc/NpcUnitSystem");
  await import("../app/hotfix/mmorpg/npc/NpcComponentSystem");
  HotfixSystem.Commit();

  const host = new ProcessHost("npc-combat-self-test");
  const mapScene = host.spawnScene("npc-combat", NpcCombatTestScene);
  const units = mapScene.AddComponent(UnitComponent);
  const content = mapScene.AddComponent(NpcContentProfileComponent);

  assert.throws(
    () => content.Register("org.example.invalid", {
      definitions: [{
        ...definition(1_001, "invalid combat NPC"),
        combatProfile: combatProfile([42], [43]),
      }],
      spawns: [],
    }),
    /aggressive player config 43 is not attackable/,
  );
  assert.equal(content.DefinitionCount, 0, "failed registration must remain atomic");
  assert.throws(
    () => content.Register("org.example.invalid-level", {
      definitions: [{ ...definition(1_003, "incomplete level NPC"), minimumLevel: 3 }],
      spawns: [],
    }),
    /level bounds must be provided together/,
  );
  assert.throws(
    () => content.Register("org.example.invalid-level", {
      definitions: [{
        ...definition(1_004, "inverted level NPC"),
        minimumLevel: 5,
        maximumLevel: 3,
      }],
      spawns: [],
    }),
    /minimum level must not exceed maximum level/,
  );

  content.ReplaceColdContent("org.example.npc-combat");
  content.Register("org.example.npc-combat", {
    definitions: [
      { ...definition(1_101, "service-only NPC"), minimumLevel: 8, maximumLevel: 8 },
      {
        ...definition(1_102, "combat-capable NPC"),
        minimumLevel: 3,
        maximumLevel: 5,
        combatProfile: {
          ...combatProfile([42], []),
          combatStatsByLevel: [
            { level: 3, maxHp: 10, maxMp: 10, attackDamage: 2 },
            { level: 4, maxHp: 11, maxMp: 10, attackDamage: 2 },
            { level: 5, maxHp: 12, maxMp: 10, attackDamage: 2 },
          ],
        },
      },
    ],
    spawns: [{
      id: 2_101,
      npcDefinitionId: 1_101,
      spawnX: 4,
      spawnY: 0,
      spawnZ: 4,
      spawnYaw: 0,
      initialSpawn: true,
      respawnSeconds: 30,
    }, {
      id: 2_102,
      npcDefinitionId: 1_102,
      spawnX: 6,
      spawnY: 0,
      spawnZ: 4,
      spawnYaw: 0,
      initialSpawn: true,
      respawnSeconds: 12,
    }],
  });
  content.Seal();

  const attached = new Set<number>();
  const visibility: AoiVisibilityDelta[][] = [];
  const damageEvents: Array<{
    targetUnitId: number;
    sourceUnitId: number;
    killed: boolean;
    abilityId: number;
  }> = [];
  const aoi = {
    Attach(unit: { UnitId: number }): readonly AoiVisibilityDelta[] {
      attached.add(unit.UnitId);
      return [{ observerId: 7, subjectId: unit.UnitId, visible: true }];
    },
    Detach(unit: { UnitId: number }): readonly AoiVisibilityDelta[] {
      attached.delete(unit.UnitId);
      return [{ observerId: 7, subjectId: unit.UnitId, visible: false }];
    },
    IsAttached(unit: { UnitId: number }): boolean {
      return attached.has(unit.UnitId);
    },
  } as unknown as MapAoiComponent;
  const map = Object.assign(Object.create(MapComponent.prototype) as MapComponent, {
    async PublishVisibilityChanges(changes: readonly AoiVisibilityDelta[]): Promise<void> {
      visibility.push([...changes]);
    },
    async PublishCombatDamage(
      target: { UnitId: number },
      sourceUnitId: number,
      result: { killed: boolean },
      abilityId = 0,
    ): Promise<void> {
      damageEvents.push({ targetUnitId: target.UnitId, sourceUnitId, killed: result.killed, abilityId });
    },
    async PublishItemChanged(): Promise<void> {},
  });
  Object.defineProperties(map, {
    mapId: { value: 777, writable: true },
    mapInstanceId: { value: 777n, writable: true },
    nativeMapKey: { value: 777, writable: true },
    stopping: { value: false, writable: true },
    spatialProfile: { value: {
      spatialMode: SpatialMode.Grid2D,
      widthCells: 100,
      depthCells: 100,
      cellSizeMeters: 1,
      spawnX: 0,
      spawnY: 0,
      spawnZ: 0,
      spawnYaw: 0,
    }, writable: true },
    logger: { value: mapScene.logger, writable: true },
    DomainScene: { value: () => mapScene },
  });
  mapScene.AddComponent(SkillMapComponent, map);
  const npcs = mapScene.AddComponent(NpcComponent, map, aoi);
  const serviceNpc = npcs.Get(2_101);
  const initialCombatNpc = npcs.Get(2_102);
  assert.ok(serviceNpc);
  assert.ok(initialCombatNpc);
  assert.equal(serviceNpc.GetComponent(NumericComponent)[NumericType.Level], 8n);
  assert.equal(serviceNpc.TryGetComponent(CombatComponent), undefined);
  assert.equal(serviceNpc.TryGetComponent(SkillComponent), undefined);
  assert.equal(initialCombatNpc.GetComponent(NumericComponent)[NumericType.CurrentHp], 12n);
  assert.equal(initialCombatNpc.GetComponent(NumericComponent)[NumericType.CurrentMp], 10n);
  assert.equal(initialCombatNpc.GetComponent(NumericComponent)[NumericType.Level], 5n);
  assert.ok(initialCombatNpc.GetComponent(CombatComponent));
  assert.ok(initialCombatNpc.GetComponent(SkillComponent));

  const player = units.Create(10, PlayerUnit, {
    account: "npc-combat-player",
    characterId: 10n,
    playerConfigId: 42,
    mapId: 777,
    mapInstanceId: 777n,
  });
  const playerNative = player.AddComponent(NativeUnitRef, {
    id: player.UnitId,
    instanceId: player.InstanceId,
    mapId: 777,
  });
  const playerPosition = player.AddComponent(PositionComponent, playerNative, 100, 100, 1);
  playerPosition.SetGridWorldPosition(5, 0, 4, 0);
  player.AddComponent(NumericComponent, {
    [NumericType.CurrentHp]: 100n,
    [NumericType.CurrentMp]: 0n,
    [NumericType.MaxHpBase]: 100n,
    [NumericType.MaxMpBase]: 0n,
    [NumericType.AttackBase]: 7n,
    [NumericType.MoveSpeedBase]: 7_000n,
  });
  const playerCombat = player.AddComponent(CombatComponent);
  playerCombat.SetAutoAttackRangeMeters(3);
  player.AddComponent(CombatStateComponent);
  aoi.Attach(player, 0, true, true);

  initialCombatNpc.GetComponent(NumericComponent)[NumericType.CurrentMp] = 2n;
  TimeSystem.Instance.__update(100, 100);
  npcs.Update5Hz();
  TimeSystem.Instance.__update(5_099, 5_099);
  npcs.Update5Hz();
  assert.equal(initialCombatNpc.GetComponent(NumericComponent)[NumericType.CurrentMp], 2n);
  TimeSystem.Instance.__update(5_100, 5_100);
  npcs.Update5Hz();
  assert.equal(initialCombatNpc.GetComponent(NumericComponent)[NumericType.CurrentMp], 5n);

  TimeSystem.Instance.__update(6_000, 6_000);
  assert.equal(npcs.CanPlayerAttack(player, initialCombatNpc), true);
  const first = npcs.Attack(player, initialCombatNpc);
  assert.equal(first.finalDamage, 7n);
  assert.equal(player.GetComponent(CombatStateComponent).IsInCombat(), true);
  assert.equal(mapScene.combatAbilityRequests.length, 1, "engage ability must be module-owned and synchronous");
  npcs.Update5Hz();
  assert.equal(mapScene.combatAbilityRequests.length, 2, "distance rule must execute through the same boundary");
  assert.equal(mapScene.combatAbilityRequests[1]?.target, player);
  const killed = npcs.Attack(player, initialCombatNpc);
  assert.equal(killed.killed, true);
  assert.equal(initialCombatNpc.GetComponent(NativeUnitRef).alive, 0);
  assert.equal(player.GetComponent(CombatStateComponent).IsInCombat(), false);
  assert.equal(npcs.CanPlayerAttack(player, initialCombatNpc), false);

  TimeSystem.Instance.__update(16_001, 16_001);
  npcs.Update1Hz();
  assert.equal(npcs.Get(2_102), undefined, "expired corpse must leave the Unit and AOI indexes");
  assert.ok(npcs.Get(2_101), "service-only NPC must not enter the corpse lifecycle");

  TimeSystem.Instance.__update(18_000, 18_000);
  npcs.Update1Hz();
  const respawned = npcs.Get(2_102);
  assert.ok(respawned);
  assert.notEqual(respawned, initialCombatNpc);
  assert.equal(respawned.GetComponent(NativeUnitRef).alive, 1);
  assert.equal(respawned.GetComponent(NumericComponent)[NumericType.CurrentHp], 11n);
  assert.equal(respawned.GetComponent(NumericComponent)[NumericType.Level], 4n);
  assert.equal(damageEvents.length, 2);
  assert.equal(damageEvents[1]?.killed, true);
  assert.equal(visibility.flat().some((change) => !change.visible && change.subjectId === 2_102), true);

  player.GetComponent(NumericComponent)[NumericType.CurrentHp] = 5n;
  const spellKill = npcs.ApplyDamageToPlayer(respawned, player, {
    amount: 20n,
    abilityId: 9_002,
  });
  assert.equal(spellKill.killed, true, "NPC abilities must share the authoritative player-death boundary");
  assert.equal(player.GetComponent(NativeUnitRef).alive, 0);
  assert.equal(player.GetComponent(CombatStateComponent).IsInCombat(), false);
  assert.deepEqual(damageEvents[2], {
    targetUnitId: player.UnitId,
    sourceUnitId: respawned.UnitId,
    killed: true,
    abilityId: 9_002,
  });

  host.despawnScene("npc-combat");
  await SingletonRegistry.DestroyAll();
  console.log("[npc-combat] self-test passed");
}

function definition(id: number, name: string) {
  return {
    id,
    name,
    questStarterConfigIds: [],
    questEnderConfigIds: [],
    shopItemConfigIds: [],
    trainerId: 0,
    shopEnabled: false,
  };
}

function combatProfile(
  attackablePlayerConfigIds: readonly number[],
  aggressivePlayerConfigIds: readonly number[],
) {
  return {
    maxHp: 12,
    maxMp: 10,
    attackDamage: 2,
    moveSpeed: 3,
    attackRange: 2,
    attackIntervalMs: 1_500,
    acquireRangeMeters: 10,
    leashRangeMeters: 20,
    resourceRegenAmount: 3,
    resourceRegenIntervalMs: 2_000,
    resourceRegenDelayAfterSpendMs: 5_000,
    attackablePlayerConfigIds,
    aggressivePlayerConfigIds,
    behaviorRules: [{
      id: 1,
      trigger: NpcCombatBehaviorTrigger.Reset,
      chancePermille: 1_000,
      actions: [{
        type: NpcCombatBehaviorActionType.SetCombatMovement,
        target: NpcCombatBehaviorTarget.Self,
        enabled: false,
      }, {
        type: NpcCombatBehaviorActionType.SetState,
        target: NpcCombatBehaviorTarget.Self,
        state: 0,
      }],
    }, {
      id: 2,
      trigger: NpcCombatBehaviorTrigger.Engage,
      chancePermille: 1_000,
      actions: [{
        type: NpcCombatBehaviorActionType.ExecuteAbility,
        target: NpcCombatBehaviorTarget.CombatTarget,
        abilityId: 9_001,
      }, {
        type: NpcCombatBehaviorActionType.ChangeState,
        target: NpcCombatBehaviorTarget.Self,
        stateDelta: 1,
      }],
    }, {
      id: 3,
      trigger: NpcCombatBehaviorTrigger.TargetDistanceRange,
      chancePermille: 1_000,
      minDistanceMeters: 0,
      maxDistanceMeters: 10,
      repeatDelayMinMs: 1_000,
      repeatDelayMaxMs: 1_000,
      actions: [{
        type: NpcCombatBehaviorActionType.ExecuteAbility,
        target: NpcCombatBehaviorTarget.CombatTarget,
        abilityId: 9_002,
      }],
    }, {
      id: 4,
      trigger: NpcCombatBehaviorTrigger.HealthRange,
      chancePermille: 1_000,
      oncePerEngagement: true,
      minValuePermille: 0,
      maxValuePermille: 500,
      actions: [{
        type: NpcCombatBehaviorActionType.Flee,
        target: NpcCombatBehaviorTarget.Self,
        fleeDistanceMeters: 5,
      }],
    }],
  };
}

function installNativeHostOps(): void {
  let nextHandle = 1;
  const entities = new Map<number, Float64Array>();
  const numerics = new Map<number, Map<number, bigint>>();
  (globalThis as typeof globalThis & { __etsNativeOps?: NativeHostOpsApi }).__etsNativeOps = {
    entityCreate: (_type, values) => {
      const handle = nextHandle++;
      entities.set(handle, values.slice());
      return handle;
    },
    entityDestroy: (handle) => { entities.delete(handle); numerics.delete(handle); },
    entityGetNumber: (handle, field) => entities.get(handle)![field - 1]!,
    entitySetNumber: (handle, field, value) => { entities.get(handle)![field - 1] = value; },
    numericAttach: (handle) => { numerics.set(handle, new Map()); },
    numericDetach: (handle) => { numerics.delete(handle); },
    numericGet: (handle, type) => numerics.get(handle)?.get(type) ?? 0n,
    numericSet: (handle, type, value) => {
      const values = numerics.get(handle)!;
      if (IsDerivedNumericType(type)) throw new Error("derived Numeric is read-only");
      if (values.get(type) === value) return false;
      values.set(type, value);
      const target = Math.trunc(type / 10);
      const suffix = type % 10;
      if (IsDerivedNumericType(target) && suffix >= 1 && suffix <= 3) {
        const base = values.get(target * 10 + 1) ?? 0n;
        const addition = values.get(target * 10 + 2) ?? 0n;
        const pct = values.get(target * 10 + 3) ?? 0n;
        values.set(target, (base + addition) * (100n + pct) / 100n);
      }
      return true;
    },
    unitSetMovementInput: () => true,
    unitSetGridMovementTarget: () => true,
    unitResetMovement: () => {},
  } as NativeHostOpsApi;
}

function testHotfixManifest(): HotfixManifest {
  return {
    formatVersion: 1,
    bundleVersion: "npc-combat-self-test",
    modelFingerprint: "npc-combat-self-test",
    modelSourceHash: "npc-combat-self-test",
    protocolFingerprint: "npc-combat-self-test",
    stableCoreApiHash: "npc-combat-self-test",
    nativeSchemaHash: "npc-combat-self-test",
    hotfixHash: "npc-combat-self-test",
    buildMode: "demo",
  };
}
