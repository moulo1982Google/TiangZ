import assert from "node:assert/strict";

void main();

async function main(): Promise<void> {
  const { InitializeGameSingletons } = await import("../app/core/runtime/Game");
  const { HotfixSystem } = await import("../app/core/hotReload/HotfixSystem");
  const { SingletonRegistry } = await import("../app/core/runtime/Singleton");
  InitializeGameSingletons(
    { fixedUpdateMs: 50, maxCatchUpSteps: 2 },
    { originServerId: 27, workerId: 1 },
  );
  HotfixSystem.Begin(testHotfixManifest());
  const { NpcUnitSystem } = await import("../app/hotfix/mmorpg/npc/NpcUnitSystem");
  const { InteractableUnitSystem } = await import(
    "../app/hotfix/mmorpg/interactable/InteractableUnitSystem"
  );
  const { NativeUnitRef } = await import("../app/generated/model/native/NativeUnitRef");
  const { NumericComponent } = await import("../app/model/mmorpg/numeric/NumericComponent");
  const { PositionComponent } = await import("../app/model/mmorpg/map/PositionComponent");
  HotfixSystem.Commit();

  const npc = Object.create(NpcUnitSystem.prototype) as InstanceType<typeof NpcUnitSystem>;
  Object.assign(npc as unknown as Record<string, unknown>, {
    runtimeContentPatches: new Map(),
    runtimeProfileRevision: 1,
  });
  (npc as unknown as { Awake(value: unknown): void }).Awake({
    mapId: 1,
    mapInstanceId: 1n,
    npcConfigId: 10,
    name: "runtime patch fixture",
    questStarterConfigIds: [100],
    questEnderConfigIds: [101],
    shopItemConfigIds: [200],
    trainerId: 7,
    shopEnabled: false,
    repairEnabled: false,
    conversationEnabled: false,
    trainingEnabled: false,
    recoveryEnabled: false,
  });
  assert.equal(npc.PresentationStateId, 0);
  npc.SetPresentationState(273);
  assert.equal(npc.PresentationStateId, 273);
  assert.throws(() => npc.SetPresentationState(-1), /must not be negative/);

  const eventA = {
    questStarterConfigIds: [102],
    shopItemConfigIds: [201],
    questEnabled: true as const,
    conversationEnabled: true as const,
    shopEnabled: true as const,
    trainingEnabled: true as const,
    presentationModelId: "300",
    presentationLoadoutId: "2",
    extensionCapabilities: ["org.example.capability.alpha"],
  };
  assert.equal(npc.ApplyRuntimeContentPatch("event-a", eventA), true);
  assert.equal(npc.ApplyRuntimeContentPatch("event-a", eventA), false);
  assert.equal(npc.ApplyRuntimeContentPatch("event-b", {
    questStarterConfigIds: [102, 103],
    shopItemConfigIds: [202],
    recoveryEnabled: true,
  }), true);
  assert.deepEqual(npc.QuestStarterConfigIds, [100, 102, 103]);
  assert.deepEqual(npc.ShopItemConfigIds, [200, 201, 202]);
  assert.equal(npc.ShopEnabled, true);
  assert.equal(npc.TrainingEnabled, true);
  assert.equal(npc.RecoveryEnabled, true);
  assert.equal(npc.PresentationModelId, "300");
  assert.equal(npc.PresentationLoadoutId, "2");
  assert.deepEqual(npc.ExtensionCapabilities, ["org.example.capability.alpha"]);
  assert.equal(npc.RuntimeProfileRevision, 3);
  assert.throws(
    () => npc.ApplyRuntimeContentPatch("event-c", { presentationModelId: "301" }),
    /conflicting model overrides/,
  );

  assert.equal(npc.RemoveRuntimeContentPatch("event-a"), true);
  assert.deepEqual(npc.QuestStarterConfigIds, [100, 102, 103]);
  assert.deepEqual(npc.ShopItemConfigIds, [200, 202]);
  assert.equal(npc.ShopEnabled, false);
  assert.equal(npc.PresentationModelId, "");
  assert.equal(npc.RemoveRuntimeContentPatch("event-b"), true);
  assert.deepEqual(npc.QuestStarterConfigIds, [100]);
  assert.deepEqual(npc.ShopItemConfigIds, [200]);
  assert.equal(npc.RecoveryEnabled, false);

  const numericSnapshot = [{ unitId: 700, numericType: 1, value: 80n }];
  Object.defineProperty(npc, "UnitId", { value: 700 });
  Object.defineProperty(npc, "GetComponent", {
    value: (ctor: unknown) => {
      if (ctor === PositionComponent) {
        return { snapshot: () => ({ x: 1, y: 2, z: 3, yaw: 0.5, cellX: 1, cellZ: 3 }) };
      }
      if (ctor === NativeUnitRef) {
        return { speedCellsPerSecond: 2, facing: 4, alive: 1 };
      }
      throw new Error("unexpected required NPC snapshot component");
    },
  });
  Object.defineProperty(npc, "TryGetComponent", {
    configurable: true,
    value: (ctor: unknown) => ctor === NumericComponent
      ? { Snapshot: () => numericSnapshot }
      : undefined,
  });
  assert.deepEqual(npc.Snapshot().numerics, numericSnapshot);
  Object.defineProperty(npc, "TryGetComponent", {
    configurable: true,
    value: () => undefined,
  });
  assert.deepEqual(npc.Snapshot().numerics, []);

  const interactable = Object.create(InteractableUnitSystem.prototype) as InstanceType<
    typeof InteractableUnitSystem
  >;
  Object.assign(interactable as unknown as Record<string, unknown>, {
    runtimeContentPatches: new Map(),
    runtimeProfileRevision: 1,
  });
  (interactable as unknown as { Awake(value: unknown): void }).Awake({
    mapId: 1,
    mapInstanceId: 1n,
    interactableConfigId: 20,
    name: "runtime quest fixture",
    presentationModelId: "1",
    useRangeMeters: 5,
    respawnDelayMs: 0,
    rewards: [],
    questStarterConfigIds: [300],
  });
  interactable.ApplyRuntimeContentPatch("event-a", { questStarterConfigIds: [301] });
  interactable.ApplyRuntimeContentPatch("event-b", { questStarterConfigIds: [301, 302] });
  assert.deepEqual(interactable.QuestStarterConfigIds, [300, 301, 302]);
  interactable.RemoveRuntimeContentPatch("event-a");
  assert.deepEqual(interactable.QuestStarterConfigIds, [300, 301, 302]);
  interactable.RemoveRuntimeContentPatch("event-b");
  assert.deepEqual(interactable.QuestStarterConfigIds, [300]);

  await SingletonRegistry.DestroyAll();
  console.log("runtime content patch self-test passed");
}

function testHotfixManifest() {
  return {
    formatVersion: 1 as const,
    bundleVersion: "runtime-content-patch-self-test",
    modelFingerprint: "runtime-content-patch-self-test",
    modelSourceHash: "runtime-content-patch-self-test",
    protocolFingerprint: "runtime-content-patch-self-test",
    stableCoreApiHash: "runtime-content-patch-self-test",
    nativeSchemaHash: "runtime-content-patch-self-test",
    hotfixHash: "runtime-content-patch-self-test",
    buildMode: "demo" as const,
  };
}
