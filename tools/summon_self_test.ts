import { runSelfTest } from "./self_test_entry";
import assert from "node:assert/strict";

import { HotfixSystem } from "../app/core/hotReload/HotfixSystem";
import type { HotfixManifest } from "../app/core/hotReload/contracts";
import { InitializeGameSingletons } from "../app/core/runtime/Game";
import { ProcessHost } from "../app/core/runtime/host";
import { Scene } from "../app/core/runtime/entities";
import { UnitComponent } from "../app/core/runtime/Unit";
import { scene } from "../app/core/runtime/metadata";
import type { NativeHostOpsApi } from "../app/generated/model/native/NativeOps";
import { NativeUnitRef } from "../app/generated/model/native/NativeUnitRef";
import { SpatialMode } from "../app/generated/model/config";
import { BuffComponent } from "../app/model/mmorpg/buff/BuffComponent";
import {
  CombatComponent,
  DamageSchool,
  type DamageResult,
} from "../app/model/mmorpg/combat/CombatComponent";
import type { MapAoiComponent, AoiVisibilityDelta } from "../app/model/mmorpg/map/MapAoiComponent";
import type { MapComponent } from "../app/model/mmorpg/map/MapComponent";
import { PlayerUnit } from "../app/model/mmorpg/map/PlayerUnit";
import { PositionComponent } from "../app/model/mmorpg/map/PositionComponent";
import { MonsterComponent } from "../app/model/mmorpg/monster/MonsterComponent";
import { MonsterUnit } from "../app/model/mmorpg/monster/MonsterUnit";
import { NpcUnit } from "../app/model/mmorpg/npc/NpcUnit";
import { NumericComponent } from "../app/model/mmorpg/numeric/NumericComponent";
import { NumericRegenerationComponent } from "../app/model/mmorpg/numeric/NumericRegenerationComponent";
import { IsDerivedNumericType, NumericType } from "../app/model/mmorpg/numeric/NumericType";
import { SkillMapComponent } from "../app/model/mmorpg/skill/SkillMapComponent";
import {
  OwnedUnitCommand,
  OwnedUnitReaction,
  SummonComponent,
  type OwnedSummonDefinition,
  type SummonRuntimeState,
} from "../app/model/mmorpg/summon/SummonComponent";

@scene({ sceneType: "SummonTest" })
class SummonTestScene extends Scene {}


export async function main(): Promise<void> {
  InitializeGameSingletons(
    { fixedUpdateMs: 50, maxCatchUpSteps: 2 },
    { originServerId: 41, workerId: 2 },
  );
  installNativeHostOps();
  HotfixSystem.Begin(testHotfixManifest());
  await import("../app/hotfix/mmorpg/numeric/NumericComponentSystem");
  await import("../app/hotfix/mmorpg/numeric/NumericRegenerationComponentSystem");
  await import("../app/hotfix/mmorpg/combat/CombatComponentSystem");
  await import("../app/hotfix/mmorpg/buff/BuffSystem");
  await import("../app/hotfix/mmorpg/buff/BuffComponentSystem");
  await import("../app/hotfix/mmorpg/map/PlayerUnitSystem");
  await import("../app/hotfix/mmorpg/monster/MonsterUnitSystem");
  await import("../app/hotfix/mmorpg/npc/NpcUnitSystem");
  await import("../app/hotfix/mmorpg/skill/SkillComponentSystem");
  await import("../app/hotfix/mmorpg/summon/SummonedUnitSystem");
  await import("../app/hotfix/mmorpg/summon/SummonComponentSystem");
  HotfixSystem.Commit();

  const host = new ProcessHost("summon-self-test");
  const mapScene = host.spawnScene("summon", SummonTestScene);
  const units = mapScene.AddComponent(UnitComponent);
  const published: AoiVisibilityDelta[][] = [];
  const attached = new Set<number>();
  const aoi = {
    Attach(unit: { UnitId: number }): readonly AoiVisibilityDelta[] {
      attached.add(unit.UnitId);
      return [{ observerId: 1, subjectId: unit.UnitId, visible: true }];
    },
    Detach(unit: { UnitId: number }): readonly AoiVisibilityDelta[] {
      attached.delete(unit.UnitId);
      return [{ observerId: 1, subjectId: unit.UnitId, visible: false }];
    },
    IsAttached(unit: { UnitId: number }): boolean {
      return attached.has(unit.UnitId);
    },
    VisibleUnitIds(observerId: number): readonly number[] {
      return [observerId, 20];
    },
  } as unknown as MapAoiComponent;
  const map = {
    MapId: 100,
    MapInstanceId: 100n,
    NativeMapKey: 100,
    IsStopping: false,
    SpatialProfile: {
      spatialMode: SpatialMode.Grid2D,
      widthCells: 100,
      depthCells: 100,
      cellSizeMeters: 1,
    },
    async PublishVisibilityChanges(changes: readonly AoiVisibilityDelta[]): Promise<void> {
      published.push([...changes]);
    },
  } as unknown as MapComponent;
  const summons = mapScene.AddComponent(SummonComponent, map, aoi);
  const owner = units.Create(1, PlayerUnit, {
    account: "summon-owner",
    characterId: 7n,
    playerConfigId: 1,
    mapId: 100,
    mapInstanceId: 100n,
  });
  const ownerNative = owner.AddComponent(NativeUnitRef, {
    id: owner.UnitId,
    instanceId: owner.InstanceId,
    mapId: 100,
  });
  const ownerPosition = owner.AddComponent(PositionComponent, ownerNative, 100, 100, 1);
  ownerPosition.SetGridCell(0, 0, 3, 0);
  owner.AddComponent(NumericComponent, {
    [NumericType.CurrentHp]: 100n,
    [NumericType.MaxHpBase]: 100n,
    [NumericType.CurrentMp]: 100n,
    [NumericType.MaxMpBase]: 100n,
    [NumericType.PrimaryResourcePulseAmount]: 4n,
    [NumericType.Level]: 5n,
    [NumericType.MoveSpeedBase]: 7_000n,
  });
  owner.AddComponent(CombatComponent);
  owner.AddComponent(BuffComponent);
  const ownerNumeric = owner.GetComponent(NumericComponent);
  const dynamicRegeneration = owner.AddComponent(NumericRegenerationComponent, {
    currentNumericType: NumericType.CurrentMp,
    maximumNumericType: NumericType.MaxMp,
    amountNumericType: NumericType.PrimaryResourcePulseAmount,
    intervalMs: 1_000,
    delayAfterDecreaseMs: 500,
  });
  ownerNumeric[NumericType.CurrentMp] = 90n;
  assert.equal(dynamicRegeneration.Tick(100), false);
  assert.equal(dynamicRegeneration.Tick(599), false);
  assert.equal(dynamicRegeneration.Tick(600), true);
  assert.equal(ownerNumeric[NumericType.CurrentMp], 94n);
  ownerNumeric[NumericType.PrimaryResourcePulseAmount] = 6n;
  assert.equal(dynamicRegeneration.Tick(1_600), true);
  assert.equal(ownerNumeric[NumericType.CurrentMp], 100n);

  const definition: OwnedSummonDefinition = {
    id: 7001,
    name: "Assist Fixture",
    modelId: "42",
    maxHp: 50,
    maxMp: 25,
    attackDamage: 8,
    moveSpeed: 7,
    attackRange: 5,
    attackIntervalMs: 2_000,
    attackDamageSchool: DamageSchool.Fire,
    attackAbilityId: 7002,
    followDistance: 3,
    teleportDistance: 40,
    assistOwner: true,
    initialReaction: OwnedUnitReaction.Defensive,
    aggressiveAcquireRange: 20,
    abilities: [{ abilityId: 7003, autoCastByDefault: false }],
    resourceRegenAmount: 3,
    resourceRegenIntervalMs: 2_000,
    resourceRegenDelayAfterSpendMs: 5_000,
  };
  const first = summons.SummonOwnedUnit(owner, {
    ownershipSlot: 0,
    createdByAbilityId: 7000,
    definition,
  });
  assert.equal(first.OwnerUnitId, owner.UnitId);
  assert.equal(first.OwnerPersistentId, owner.CharacterId);
  assert.equal(first.GetComponent(NumericComponent)[NumericType.Level], 5n);
  const summonNumeric = first.GetComponent(NumericComponent);
  const regeneration = first.GetComponent(NumericRegenerationComponent);
  summonNumeric[NumericType.CurrentMp] = 5n;
  assert.equal(regeneration.Tick(1_000), false);
  assert.equal(regeneration.Tick(5_999), false);
  assert.equal(summonNumeric[NumericType.CurrentMp], 5n);
  assert.equal(regeneration.Tick(6_000), true);
  assert.equal(summonNumeric[NumericType.CurrentMp], 8n);
  assert.equal(regeneration.Tick(8_000), true);
  assert.equal(summonNumeric[NumericType.CurrentMp], 11n);
  summonNumeric[NumericType.CurrentMp] = summonNumeric[NumericType.MaxMp];
  regeneration.ResetSchedule();
  assert.equal(first.Snapshot().modelId, "42");
  assert.equal(Object.isFrozen(
    [...(summons as unknown as { runtime: Map<number, SummonRuntimeState> }).runtime.values()][0]?.definition,
  ), true);
  assert.equal(published.flat().some((change) => change.visible && change.subjectId === first.UnitId), true);

  const target = units.Create(20, MonsterUnit, {
    mapId: 100,
    mapInstanceId: 100n,
    areaId: 20,
    monsterConfigId: 30,
    name: "Target",
    modelId: "30",
  });
  const targetNative = target.AddComponent(NativeUnitRef, {
    id: target.UnitId,
    instanceId: target.InstanceId,
    mapId: 100,
  });
  const targetPosition = target.AddComponent(PositionComponent, targetNative, 100, 100, 1);
  targetPosition.SetGridCell(1, 0, 3, 0);
  target.AddComponent(NumericComponent, {
    [NumericType.CurrentHp]: 50n,
    [NumericType.MaxHpBase]: 50n,
    [NumericType.MoveSpeedBase]: 7_000n,
  });
  target.AddComponent(CombatComponent);
  target.AddComponent(BuffComponent);
  const damageRequests: Array<{ owner: PlayerUnit; target: MonsterUnit; amount: bigint; sourceUnitId?: number }> = [];
  const monsterService = {
    Get(unitId: number): MonsterUnit | undefined {
      return unitId === target.UnitId ? target : undefined;
    },
    GetAll(): readonly MonsterUnit[] { return [target]; },
    CanPlayerAttack(): boolean { return true; },
    ApplyPlayerDamage(
      creditOwner: PlayerUnit,
      damagedTarget: MonsterUnit,
      request: { amount: bigint; sourceUnitId?: number },
    ): DamageResult {
      damageRequests.push({ owner: creditOwner, target: damagedTarget, ...request });
      return {
        requestedDamage: request.amount,
        absorbedDamage: 0n,
        finalDamage: request.amount,
        remainingHp: 42n,
        killed: false,
        absorptions: [],
        damageSchool: DamageSchool.Fire,
        preventedReason: 0,
      };
    },
  };
  const originalGetComponent = mapScene.GetComponent.bind(mapScene);
  const skillCasts: Array<{ casterUnitId: number; skillId: number; targetUnitId: number }> = [];
  const skillMap = {
    Cast(caster: { UnitId: number }, command: { skillId: number; targetUnitId: number }) {
      skillCasts.push({ casterUnitId: caster.UnitId, ...command });
      return {};
    },
  };
  mapScene.GetComponent = ((ctor: unknown) => (
    ctor === MonsterComponent
      ? monsterService
      : ctor === SkillMapComponent
        ? skillMap
        : originalGetComponent(ctor as never)
  )) as typeof mapScene.GetComponent;
  assert.equal(
    summons.CommandOwnedUnit(owner, first.UnitId, OwnedUnitCommand.Attack, target.UnitId),
    true,
  );
  summons.Update5Hz();
  assert.deepEqual(damageRequests.map((request) => ({
    owner: request.owner.UnitId,
    target: request.target.UnitId,
    amount: request.amount,
    sourceUnitId: request.sourceUnitId,
  })), [{ owner: 1, target: 20, amount: 8n, sourceUnitId: first.UnitId }]);

  assert.equal(
    summons.CommandOwnedUnit(
      owner,
      first.UnitId,
      OwnedUnitCommand.CastAbility,
      target.UnitId,
      7003,
    ),
    true,
  );
  assert.deepEqual(skillCasts.at(-1), {
    casterUnitId: first.UnitId,
    skillId: 7003,
    targetUnitId: target.UnitId,
  });
  assert.equal(
    summons.CommandOwnedUnit(owner, first.UnitId, OwnedUnitCommand.CastAbility, target.UnitId, 7999),
    false,
  );

  const state = (summons as unknown as { runtime: Map<number, SummonRuntimeState> }).runtime.get(first.UnitId)!;
  assert.deepEqual([...state.autoCastAbilityIds], []);
  assert.equal(
    summons.CommandOwnedUnit(owner, first.UnitId, OwnedUnitCommand.EnableAbilityAutoCast, 0, 7003),
    true,
  );
  assert.deepEqual(summons.GetControlState(first.UnitId), {
    reaction: OwnedUnitReaction.Defensive,
    autoCastAbilityIds: [7003],
  });
  state.nextThinkAtMs = 0;
  state.targetMonsterUnitId = target.UnitId;
  summons.Update5Hz();
  assert.equal(skillCasts.at(-1)?.skillId, 7003);
  assert.equal(
    summons.CommandOwnedUnit(owner, first.UnitId, OwnedUnitCommand.DisableAbilityAutoCast, 0, 7003),
    true,
  );
  assert.deepEqual([...state.autoCastAbilityIds], []);
  assert.equal(state.reaction, OwnedUnitReaction.Defensive);
  assert.equal(summons.CommandOwnedUnit(owner, first.UnitId, OwnedUnitCommand.SetPassive, 0), true);
  summons.AssistOwnerAgainst(owner, target);
  assert.equal(state.targetMonsterUnitId, 0, "passive summon assisted its owner");
  assert.equal(summons.CommandOwnedUnit(owner, first.UnitId, OwnedUnitCommand.SetDefensive, 0), true);
  summons.AssistOwnerAgainst(owner, target);
  assert.equal(state.targetMonsterUnitId, target.UnitId, "defensive summon did not assist its owner");
  state.targetMonsterUnitId = 0;
  assert.equal(summons.CommandOwnedUnit(owner, first.UnitId, OwnedUnitCommand.SetAggressive, 0), true);
  assert.deepEqual(summons.GetControlState(first.UnitId), {
    reaction: OwnedUnitReaction.Aggressive,
    autoCastAbilityIds: [],
  });
  summons.Update5Hz();
  assert.equal(state.targetMonsterUnitId, target.UnitId, "aggressive summon did not acquire a visible target");
  assert.equal(summons.CommandOwnedUnit(owner, first.UnitId, OwnedUnitCommand.SetDefensive, 0), true);
  assert.equal(summons.CommandOwnedUnit(owner, first.UnitId, OwnedUnitCommand.Stay, 0), true);
  assert.equal(state.followOwner, false);
  assert.equal(summons.CommandOwnedUnit(owner, first.UnitId, OwnedUnitCommand.Follow, 0), true);
  assert.equal(state.followOwner, true);
  assert.equal(summons.CommandOwnedUnit(owner, first.UnitId, OwnedUnitCommand.Attack, 999), false);
  state.targetMonsterUnitId = 0;
  state.nextThinkAtMs = 0;
  ownerPosition.SetGridCell(10, 0, 3, 0);
  movementInputs.length = 0;
  gridMovementTargets.length = 0;
  summons.Update5Hz();
  assert.deepEqual(
    gridMovementTargets.at(-1),
    { targetCellX: 10, targetCellZ: 0 },
    "summon did not follow its owner through a bounded Grid2D target",
  );

  state.nextThinkAtMs = 0;
  ownerPosition.SetGridCell(45, 0, 3, 0);
  summons.Update5Hz();
  assert.equal(first.GetComponent(PositionComponent).cellX, 45, "distant summon was not recovered");

  assert.equal(summons.CommandOwnedUnit(owner, first.UnitId, OwnedUnitCommand.SetAggressive, 0), true);
  assert.equal(
    summons.CommandOwnedUnit(owner, first.UnitId, OwnedUnitCommand.EnableAbilityAutoCast, 0, 7003),
    true,
  );
  const transferState = summons.CaptureOwnedState(owner);
  assert.equal(transferState.length, 1);
  assert.equal(transferState[0]?.ownershipSlot, 0);
  assert.equal(transferState[0]?.createdByAbilityId, 7000);
  assert.equal(transferState[0]?.reaction, OwnedUnitReaction.Aggressive);
  assert.deepEqual(transferState[0]?.autoCastAbilityIds, [7003]);
  assert.notEqual(transferState[0]?.definition, definition, "transfer captured the source definition object");
  assert.deepEqual(transferState[0]?.definition, definition);
  assert.equal(summons.DismissOwnedUnit(owner, 0), true);
  assert.throws(
    () => summons.RestoreOwnedState(owner, [...transferState, ...transferState]),
    /duplicate summon ownership slot/,
  );
  assert.equal(summons.GetOwnedUnit(owner, 0), undefined, "invalid summon transfer mutated the target");
  const originalSummonOwnedUnit = summons.SummonOwnedUnit.bind(summons);
  const summonSystem = summons as unknown as {
    SummonOwnedUnit: typeof summons.SummonOwnedUnit;
  };
  let restoreCalls = 0;
  summonSystem.SummonOwnedUnit = ((currentOwner, request) => {
    restoreCalls += 1;
    if (restoreCalls === 2) throw new Error("injected summon restore failure");
    return originalSummonOwnedUnit(currentOwner, request);
  }) as typeof summons.SummonOwnedUnit;
  try {
    assert.throws(
      () => summons.RestoreOwnedState(owner, [
        transferState[0]!,
        { ...transferState[0]!, ownershipSlot: 1 },
      ]),
      /injected summon restore failure/,
    );
  } finally {
    summonSystem.SummonOwnedUnit = originalSummonOwnedUnit;
  }
  assert.equal(summons.GetOwnedUnit(owner, 0), undefined, "failed restore kept a partial summon");
  assert.equal(summons.GetOwnedUnit(owner, 1), undefined, "failed restore kept a later summon");
  const restored = summons.RestoreOwnedState(owner, transferState);
  assert.equal(restored.length, 1);
  assert.notEqual(restored[0]?.UnitId, first.UnitId);
  assert.equal(restored[0]?.SummonDefinitionId, definition.id);
  assert.equal(restored[0]?.CreatedByAbilityId, 7000);
  assert.equal(restored[0]?.OwnerPersistentId, owner.CharacterId);

  const replacement = summons.SummonOwnedUnit(owner, {
    ownershipSlot: 0,
    createdByAbilityId: 7000,
    definition,
  });
  assert.notEqual(replacement.UnitId, first.UnitId);
  assert.equal(units.Get(first.UnitId), undefined);
  assert.equal(summons.GetOwnedUnit(owner, 0), replacement);
  assert.equal(summons.DismissOwnedUnit(owner, 0), true);
  assert.equal(summons.GetOwnedUnit(owner, 0), undefined);
  assert.equal(summons.DismissOwnedUnit(owner, 0), false);

  const leaving = summons.SummonOwnedUnit(owner, {
    ownershipSlot: 0,
    createdByAbilityId: 7000,
    definition,
  });
  const leaveChanges = summons.OwnerLeaving(owner);
  assert.equal(leaveChanges.some((change) => !change.visible && change.subjectId === leaving.UnitId), true);
  assert.equal(units.Get(leaving.UnitId), undefined);

  const monsterOwned = summons.SummonOwnedUnit(target, {
    ownershipSlot: 0,
    createdByAbilityId: 7_003,
    definition: { ...definition, id: 7_004, assistOwner: false },
  });
  assert.equal(monsterOwned.OwnerUnitId, target.UnitId);
  assert.equal(monsterOwned.OwnerPersistentId, 0n);
  assert.equal(monsterOwned.GetComponent(NumericComponent)[NumericType.Level], 1n);
  targetPosition.SetGridCell(8, 0, 3, 0);
  const monsterOwnedState = (summons as unknown as {
    runtime: Map<number, SummonRuntimeState>;
  }).runtime.get(monsterOwned.UnitId)!;
  monsterOwnedState.nextThinkAtMs = 0;
  summons.Update5Hz();
  assert.deepEqual(gridMovementTargets.at(-1), { targetCellX: 8, targetCellZ: 0 });
  const monsterLeaveChanges = summons.OwnerLeaving(target);
  assert.equal(
    monsterLeaveChanges.some((change) => !change.visible && change.subjectId === monsterOwned.UnitId),
    true,
  );
  assert.equal(units.Get(monsterOwned.UnitId), undefined);

  const npcOwner = units.Create(30, NpcUnit, {
    mapId: 100,
    mapInstanceId: 100n,
    npcConfigId: 40,
    name: "Encounter Owner",
    questStarterConfigIds: [],
    questEnderConfigIds: [],
    shopItemConfigIds: [],
    trainerId: 0,
    shopEnabled: false,
    repairEnabled: false,
  });
  const npcNative = npcOwner.AddComponent(NativeUnitRef, {
    id: npcOwner.UnitId,
    instanceId: npcOwner.InstanceId,
    mapId: 100,
  });
  const npcPosition = npcOwner.AddComponent(PositionComponent, npcNative, 100, 100, 1);
  npcPosition.SetGridCell(12, 0, 3, 0);
  const npcOwned = summons.SummonOwnedUnit(npcOwner, {
    ownershipSlot: 0,
    createdByAbilityId: 7_005,
    definition: { ...definition, id: 7_006, assistOwner: false },
  });
  assert.equal(npcOwned.OwnerUnitId, npcOwner.UnitId);
  assert.equal(npcOwned.OwnerPersistentId, 0n);
  assert.equal(npcOwned.GetComponent(NumericComponent)[NumericType.Level], 1n);
  const npcLeaveChanges = summons.OwnerLeaving(npcOwner);
  assert.equal(
    npcLeaveChanges.some((change) => !change.visible && change.subjectId === npcOwned.UnitId),
    true,
  );
  assert.equal(units.Get(npcOwned.UnitId), undefined);

  host.despawnScene("summon");
  console.log("[summon] self-test passed");
}

const movementInputs: Array<{ handle: number; inputX: number; inputZ: number; sequence: number }> = [];
const gridMovementTargets: Array<{ targetCellX: number; targetCellZ: number }> = [];

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
    unitSetMovementInput: (handle, inputX, inputZ, sequence) => {
      movementInputs.push({ handle, inputX, inputZ, sequence });
      return true;
    },
    unitSetGridMovementTarget: (_handle, targetCellX, targetCellZ) => {
      gridMovementTargets.push({ targetCellX, targetCellZ });
      return true;
    },
    unitResetMovement: () => {},
  } as NativeHostOpsApi;
}

function testHotfixManifest(): HotfixManifest {
  return {
    formatVersion: 1,
    bundleVersion: "summon-self-test",
    modelFingerprint: "summon-self-test",
    modelSourceHash: "summon-self-test",
    protocolFingerprint: "summon-self-test",
    stableCoreApiHash: "summon-self-test",
    nativeSchemaHash: "summon-self-test",
    hotfixHash: "summon-self-test",
    buildMode: "demo",
  };
}

runSelfTest(main);
