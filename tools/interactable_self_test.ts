import { runSelfTest } from "./self_test_entry";
import assert from "node:assert/strict";

import {
  GameErrCode,
  ItemComponent,
  LootContentProfileComponent,
  PlayerPersistenceComponent,
  PositionComponent,
  QuestComponent,
  QuestObjectiveType,
  QuestStatus,
  RpcError,
  SkillComponent,
  type ItemSnapshot,
  type PlayerUnit,
} from "#tiangz/model";
import type {
  PlayerSaveData,
  PlayerTransactionReceipt,
  PlayerTransactionResult,
} from "../app/model/mmorpg/persistence/PlayerRepository";
import type { QuestState, QuestTransferState } from "../app/model/domains/quest/QuestComponent";
import type { SkillTransferState } from "../app/model/mmorpg/skill/SkillComponent";
import type { InteractableComponentSystem } from "../app/hotfix/mmorpg/interactable/InteractableComponentSystem";

const GRAPE_ITEM_ID = 11_119;
const GRAPE_QUEST_ID = 3_904;
const GRAPE_OBJECTIVE_ID = 390_411;
const SHRINE_TARGET_CONFIG_ID = 720_516;
const SHRINE_QUEST_ID = 8_345;
const SHRINE_OBJECTIVE_ID = 834_521;
const CHEST_ITEM_ID = 774;
const CHEST_LOOT_TABLE_ID = 91_227;


export async function main(): Promise<void> {
  const { InitializeGameSingletons } = await import("../app/core/runtime/Game");
  const { HotfixSystem } = await import("../app/core/hotReload/HotfixSystem");
  const { SingletonRegistry } = await import("../app/core/runtime/Singleton");
  InitializeGameSingletons(
    { fixedUpdateMs: 50, maxCatchUpSteps: 2 },
    { originServerId: 22, workerId: 1 },
  );
  HotfixSystem.Begin(testHotfixManifest());
  const { InteractableComponentSystem: InteractableSystem } = await import(
    "../app/hotfix/mmorpg/interactable/InteractableComponentSystem"
  );
  HotfixSystem.Commit();

  const actionEvents: unknown[] = [];
  const scene = {
    logger: {
      info() {},
      error() {},
    },
    Events: {
      Publish(_event: unknown, value: unknown) {
        actionEvents.push(value);
      },
    },
  };
  const inventory = new FakeInventory();
  const quests = new FakeQuest();
  const persistence = new FakePersistence(quests);
  const playerPosition = { x: -8_835, y: -184, z: 80 };
  const player = {
    CharacterId: 42n,
    DomainScene: () => scene,
    GetComponent<T>(ctor: unknown): T {
      if (ctor === ItemComponent) return inventory as T;
      if (ctor === QuestComponent) return quests as T;
      if (ctor === PlayerPersistenceComponent) return persistence as T;
      if (ctor === PositionComponent) return playerPosition as T;
      throw new Error(`unexpected player component: ${String(ctor)}`);
    },
  } as unknown as PlayerUnit;
  const objectPosition = { x: -8_833, y: -184, z: 80 };
  const interactableUnitId = 338_026_752;
  const interactable = {
    UnitId: interactableUnitId,
    Rewards: [{ itemConfigId: GRAPE_ITEM_ID, count: 1 }],
    RespawnDelayMs: 900_000,
    UseRangeMeters: 5,
    DomainScene: () => scene,
    GetComponent<T>(ctor: unknown): T {
      if (ctor === PositionComponent) return objectPosition as T;
      throw new Error(`unexpected interactable component: ${String(ctor)}`);
    },
  };
  const aoi = new FakeAoi(interactable);
  const map = new FakeMap();
  const system = Object.create(InteractableSystem.prototype) as InteractableComponentSystem;
  Object.assign(system as unknown as Record<string, unknown>, {
    map,
    aoi,
    interactables: new Map([[interactableUnitId, interactable]]),
    respawnAtByUnitId: new Map<number, number>(),
    inFlightUnitIds: new Set<number>(),
  });
  Object.defineProperty(system, "DomainScene", { value: () => scene });

  const presentationOnlyUnitId = interactableUnitId + 10;
  const presentationOnly = {
    ...interactable,
    UnitId: presentationOnlyUnitId,
    InteractionEnabled: false,
    Rewards: [],
  };
  const presentationOnlySystem = Object.create(
    InteractableSystem.prototype,
  ) as InteractableComponentSystem;
  Object.assign(presentationOnlySystem as unknown as Record<string, unknown>, {
    map: new FakeMap(),
    aoi: new FakeAoi(presentationOnly),
    interactables: new Map([[presentationOnlyUnitId, presentationOnly]]),
    respawnAtByUnitId: new Map<number, number>(),
    inFlightUnitIds: new Set<number>(),
  });
  Object.defineProperty(presentationOnlySystem, "DomainScene", { value: () => scene });
  await assert.rejects(
    presentationOnlySystem.Use(player, presentationOnlyUnitId, "presentation-only-click"),
    (error: unknown) => error instanceof RpcError
      && error.code === GameErrCode.InteractableUnavailable,
  );

  const actionUnitId = interactableUnitId + 11;
  const actionInteractable = {
    ...interactable,
    UnitId: actionUnitId,
    InteractionEnabled: true,
    InteractionActionId: 700_007,
    Rewards: [],
  };
  const actionSystem = Object.create(InteractableSystem.prototype) as InteractableComponentSystem;
  Object.assign(actionSystem as unknown as Record<string, unknown>, {
    map: new FakeMap(),
    aoi: new FakeAoi(actionInteractable),
    interactables: new Map([[actionUnitId, actionInteractable]]),
    respawnAtByUnitId: new Map<number, number>(),
    inFlightUnitIds: new Set<number>(),
  });
  Object.defineProperty(actionSystem, "DomainScene", { value: () => scene });
  const actionResult = await actionSystem.Use(player, actionUnitId, "chair-click");
  assert.deepEqual(actionResult, {
    interactableUnitId: actionUnitId,
    items: [],
    quests: [],
    respawnAtMs: 0n,
    proficiencies: [],
  });
  assert.equal(actionEvents.length, 1);
  assert.deepEqual(actionEvents[0], {
    interactable: actionInteractable,
    player,
    actionId: 700_007,
    nowMs: (actionEvents[0] as { nowMs: number }).nowMs,
  });
  assert.deepEqual(persistence.lastDomains, []);

  const result = await system.Use(player, interactableUnitId, "grape-click-1");
  assert.equal(result.interactableUnitId, interactableUnitId);
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0], item(11_119n, GRAPE_ITEM_ID, 1));
  assert.equal(result.quests.length, 1);
  assert.deepEqual(result.quests[0], {
    questConfigId: GRAPE_QUEST_ID,
    objectives: [{ objectiveId: GRAPE_OBJECTIVE_ID, current: 1, required: 8 }],
    revision: 1,
    readyToComplete: false,
    status: QuestStatus.InProgress,
  });
  assert.ok(result.respawnAtMs > BigInt(Date.now()));
  assert.equal(inventory.Count(GRAPE_ITEM_ID), 1);
  assert.equal(quests.Current, 1);
  assert.equal(inventory.commitCount, 1);
  assert.equal(quests.commitCount, 1);
  assert.deepEqual(persistence.lastDomains, ["inventory", "quest"]);
  assert.equal(persistence.lastData?.items.length, 1);
  assert.equal(persistence.lastData?.quests.active[0]?.objectives[0]?.current, 1);
  assert.equal(aoi.IsAttached(interactable), false);
  assert.equal(map.itemPublications, 1);
  assert.equal(map.questPublications, 1);
  assert.equal(map.visibilityPublications, 1);

  const replayed = await system.Use(player, interactableUnitId, "grape-click-1");
  assert.deepEqual(replayed, result);
  assert.equal(inventory.Count(GRAPE_ITEM_ID), 1);
  assert.equal(quests.Current, 1);
  assert.equal(inventory.commitCount, 1);
  assert.equal(quests.commitCount, 1);
  assert.equal(map.itemPublications, 1);
  assert.equal(map.questPublications, 1);
  assert.equal(map.visibilityPublications, 1);

  await assert.rejects(
    system.Use(player, interactableUnitId, "grape-click-2"),
    (error: unknown) => error instanceof RpcError && error.code === GameErrCode.InteractableUnavailable,
  );

  // An interactable may be a pure quest objective (for example the Shrine of
  // Dath'Remar) and have no item reward at all.  The same transaction path
  // must still persist and publish its neutral UseInteractable progress.
  const shrineInventory = new FakeInventory([]);
  const shrineQuests = new FakeQuest(
    QuestObjectiveType.UseInteractable,
    SHRINE_TARGET_CONFIG_ID,
    1,
    SHRINE_QUEST_ID,
    SHRINE_OBJECTIVE_ID,
  );
  const shrinePersistence = new FakePersistence(shrineQuests);
  const shrinePlayer = {
    CharacterId: 43n,
    DomainScene: () => scene,
    GetComponent<T>(ctor: unknown): T {
      if (ctor === ItemComponent) return shrineInventory as T;
      if (ctor === QuestComponent) return shrineQuests as T;
      if (ctor === PlayerPersistenceComponent) return shrinePersistence as T;
      if (ctor === PositionComponent) return playerPosition as T;
      throw new Error(`unexpected shrine player component: ${String(ctor)}`);
    },
  } as unknown as PlayerUnit;
  const shrineUnitId = interactableUnitId + 1;
  const shrineInteractable = {
    UnitId: shrineUnitId,
    Rewards: [],
    QuestObjectiveTargetConfigId: SHRINE_TARGET_CONFIG_ID,
    RespawnDelayMs: 900_000,
    UseRangeMeters: 5,
    DomainScene: () => scene,
    GetComponent<T>(ctor: unknown): T {
      if (ctor === PositionComponent) return objectPosition as T;
      throw new Error(`unexpected shrine interactable component: ${String(ctor)}`);
    },
  };
  const shrineAoi = new FakeAoi(shrineInteractable);
  const shrineMap = new FakeMap();
  const shrineSystem = Object.create(InteractableSystem.prototype) as InteractableComponentSystem;
  Object.assign(shrineSystem as unknown as Record<string, unknown>, {
    map: shrineMap,
    aoi: shrineAoi,
    interactables: new Map([[shrineUnitId, shrineInteractable]]),
    respawnAtByUnitId: new Map<number, number>(),
    inFlightUnitIds: new Set<number>(),
  });
  Object.defineProperty(shrineSystem, "DomainScene", { value: () => scene });

  const shrineResult = await shrineSystem.Use(shrinePlayer, shrineUnitId, "shrine-click-1");
  assert.equal(shrineResult.items.length, 0);
  assert.deepEqual(shrineResult.quests, [{
    questConfigId: SHRINE_QUEST_ID,
    objectives: [{ objectiveId: SHRINE_OBJECTIVE_ID, current: 1, required: 1 }],
    revision: 1,
    readyToComplete: true,
    status: QuestStatus.ReadyToTurnIn,
  }]);
  assert.equal(shrineInventory.commitCount, 1);
  assert.equal(shrineQuests.commitCount, 1);
  assert.deepEqual(shrinePersistence.lastDomains, ["inventory", "quest"]);
  assert.equal(shrineMap.itemPublications, 0);
  assert.equal(shrineMap.questPublications, 1);
  assert.equal(shrineMap.visibilityPublications, 1);

  // Ordinary interactables may reference the same neutral probability/group
  // loot model as monsters. Unlike fixed quest rewards, selected ordinary
  // rows are granted even when the player has no matching collect objective.
  const chestInventory = new FakeInventory([{ configId: CHEST_ITEM_ID, count: 2 }]);
  const chestQuests = new FakeQuest();
  const chestPersistence = new FakePersistence(chestQuests);
  const chestScene = {
    logger: scene.logger,
    GetComponent<T>(ctor: unknown): T {
      if (ctor === LootContentProfileComponent) {
        return {
          IncludesColdContent: false,
          GetRows(dropTableId: number) {
            assert.equal(dropTableId, CHEST_LOOT_TABLE_ID);
            return [{
              id: 901,
              dropTableId,
              groupId: 1,
              itemConfigId: CHEST_ITEM_ID,
              minCount: 2,
              maxCount: 2,
              chancePermille: 0,
              questObjectiveId: 0,
              gold: 0,
            }];
          },
        } as T;
      }
      throw new Error(`unexpected chest scene component: ${String(ctor)}`);
    },
  };
  const chestPlayer = {
    CharacterId: 44n,
    DomainScene: () => chestScene,
    GetComponent<T>(ctor: unknown): T {
      if (ctor === ItemComponent) return chestInventory as T;
      if (ctor === QuestComponent) return chestQuests as T;
      if (ctor === PlayerPersistenceComponent) return chestPersistence as T;
      if (ctor === PositionComponent) return playerPosition as T;
      throw new Error(`unexpected chest player component: ${String(ctor)}`);
    },
  } as unknown as PlayerUnit;
  const chestUnitId = interactableUnitId + 2;
  const chestInteractable = {
    UnitId: chestUnitId,
    Rewards: [],
    LootTableId: CHEST_LOOT_TABLE_ID,
    QuestObjectiveTargetConfigId: 0,
    RespawnDelayMs: 3_600_000,
    UseRangeMeters: 5,
    DomainScene: () => chestScene,
    GetComponent<T>(ctor: unknown): T {
      if (ctor === PositionComponent) return objectPosition as T;
      throw new Error(`unexpected chest interactable component: ${String(ctor)}`);
    },
  };
  const chestAoi = new FakeAoi(chestInteractable);
  const chestMap = new FakeMap();
  const chestSystem = Object.create(InteractableSystem.prototype) as InteractableComponentSystem;
  Object.assign(chestSystem as unknown as Record<string, unknown>, {
    map: chestMap,
    aoi: chestAoi,
    interactables: new Map([[chestUnitId, chestInteractable]]),
    respawnAtByUnitId: new Map<number, number>(),
    inFlightUnitIds: new Set<number>(),
  });
  Object.defineProperty(chestSystem, "DomainScene", { value: () => chestScene });

  const chestResult = await chestSystem.Use(chestPlayer, chestUnitId, "chest-click-1");
  assert.deepEqual(chestResult.items, [item(774n, CHEST_ITEM_ID, 2)]);
  assert.equal(chestResult.quests.length, 0);
  assert.equal(chestInventory.Count(CHEST_ITEM_ID), 2);
  assert.equal(chestMap.itemPublications, 1);
  assert.equal(chestMap.questPublications, 0);
  assert.equal(chestMap.visibilityPublications, 1);

  // Gathering is the same neutral interaction transaction plus a generic
  // proficiency requirement/progress record. The external module owns what
  // proficiency 182 means; Core only enforces and persists the numbers.
  const gatherInventory = new FakeInventory([{ configId: CHEST_ITEM_ID, count: 2 }]);
  const gatherQuests = new FakeQuest();
  const gatherPersistence = new FakePersistence(gatherQuests);
  const gatherSkill = new FakeSkill({ proficiencyId: 182, rank: 24, maximumRank: 75 });
  const gatherPlayer = {
    CharacterId: 45n,
    DomainScene: () => chestScene,
    GetComponent<T>(ctor: unknown): T {
      if (ctor === ItemComponent) return gatherInventory as T;
      if (ctor === QuestComponent) return gatherQuests as T;
      if (ctor === PlayerPersistenceComponent) return gatherPersistence as T;
      if (ctor === PositionComponent) return playerPosition as T;
      if (ctor === SkillComponent) return gatherSkill as T;
      throw new Error(`unexpected gather player component: ${String(ctor)}`);
    },
  } as unknown as PlayerUnit;
  const gatherUnitId = interactableUnitId + 3;
  const gatherInteractable = {
    ...chestInteractable,
    UnitId: gatherUnitId,
    ProficiencyId: 182,
    RequiredProficiencyRank: 25,
    ProficiencyGain: 1,
  };
  const gatherAoi = new FakeAoi(gatherInteractable);
  const gatherMap = new FakeMap();
  const gatherSystem = Object.create(InteractableSystem.prototype) as InteractableComponentSystem;
  Object.assign(gatherSystem as unknown as Record<string, unknown>, {
    map: gatherMap,
    aoi: gatherAoi,
    interactables: new Map([[gatherUnitId, gatherInteractable]]),
    respawnAtByUnitId: new Map<number, number>(),
    inFlightUnitIds: new Set<number>(),
  });
  Object.defineProperty(gatherSystem, "DomainScene", { value: () => chestScene });

  await assert.rejects(
    gatherSystem.Use(gatherPlayer, gatherUnitId, "gather-blocked"),
    (error: unknown) =>
      error instanceof RpcError && error.code === GameErrCode.InteractableRequirementNotMet,
  );
  gatherSkill.ApplyCommittedProficiency(182, 25, 75);
  const gathered = await gatherSystem.Use(gatherPlayer, gatherUnitId, "gather-1");
  assert.deepEqual(gathered.proficiencies, [{
    proficiencyId: 182,
    rank: 26,
    maximumRank: 75,
  }]);
  assert.deepEqual(gatherPersistence.lastDomains, ["inventory", "quest", "runtime"]);
  assert.deepEqual(gatherPersistence.lastData?.skill.proficiencies, gathered.proficiencies);
  assert.deepEqual(gatherSkill.Proficiency(182), gathered.proficiencies[0]);
  const gatherReplay = await gatherSystem.Use(gatherPlayer, gatherUnitId, "gather-1");
  assert.deepEqual(gatherReplay, gathered);
  assert.equal(gatherSkill.Proficiency(182)?.rank, 26);

  await SingletonRegistry.DestroyAll();
  console.log("interactable transaction self-test passed");
}

function item(itemId: bigint, configId: number, count: number, version = 1): ItemSnapshot {
  return { itemId, configId, count, quality: 0, level: 1, version };
}

class FakeInventory {
  private items: ItemSnapshot[] = [];
  commitCount = 0;

  constructor(private readonly expectedGrants: readonly { configId: number; count: number }[] = [
    { configId: GRAPE_ITEM_ID, count: 1 },
  ]) {}

  Count(configId: number): number {
    return this.items
      .filter((value) => value.configId === configId)
      .reduce((total, value) => total + value.count, 0);
  }

  PlanGrantItems(grants: readonly { configId: number; count: number }[]): {
    baseItems: readonly ItemSnapshot[];
    nextItems: readonly ItemSnapshot[];
    affectedItems: readonly ItemSnapshot[];
  } {
    assert.deepEqual(grants, this.expectedGrants);
    if (grants.length === 0) {
      return { baseItems: [], nextItems: [], affectedItems: [] };
    }
    const nextItems = grants.map((grant) => item(
      BigInt(grant.configId),
      grant.configId,
      grant.count,
    ));
    return { baseItems: [], nextItems, affectedItems: nextItems };
  }

  CommitGrantPlan(plan: { nextItems: readonly ItemSnapshot[] }): readonly ItemSnapshot[] {
    this.commitCount += 1;
    this.items = plan.nextItems.map((value) => ({ ...value }));
    return this.items;
  }

  ApplyCommittedGrantItems(items: readonly ItemSnapshot[]): readonly ItemSnapshot[] {
    this.commitCount += 1;
    this.items = items.map((value) => ({ ...value }));
    return this.items;
  }
}

class FakeQuest {
  private current = 0;
  private revision = 0;
  commitCount = 0;

  constructor(
    private readonly objectiveType: number = QuestObjectiveType.CollectItem,
    private readonly targetConfigId: number = GRAPE_ITEM_ID,
    private readonly required = 8,
    private readonly questConfigId = GRAPE_QUEST_ID,
    private readonly objectiveId = GRAPE_OBJECTIVE_ID,
  ) {}

  get Current(): number {
    return this.current;
  }

  RemainingProgress(objectiveType: number, targetConfigId: number): number {
    if (objectiveType !== this.objectiveType || targetConfigId !== this.targetConfigId) return 0;
    return this.required - this.current;
  }

  PlanProgress(event: { objectiveType: number; targetConfigId: number; count: number }): readonly QuestState[] {
    if (event.objectiveType !== this.objectiveType || event.targetConfigId !== this.targetConfigId) return [];
    const next = Math.min(this.required, this.current + event.count);
    return [this.state(next, this.revision + 1)];
  }

  ApplyCommittedProgress(states: readonly QuestState[]): void {
    if (states.length === 0) return;
    assert.equal(states.length, 1);
    this.commitCount += 1;
    this.current = states[0]!.objectives[0]!.current;
    this.revision = states[0]!.revision;
  }

  CaptureTransfer(): QuestTransferState {
    return { active: [this.state(this.current, this.revision)], completedQuestConfigIds: [] };
  }

  Snapshot(): readonly QuestState[] {
    return [this.state(this.current, this.revision)];
  }

  private state(current: number, revision: number): QuestState {
    return {
      questConfigId: this.questConfigId,
      objectives: [{ objectiveId: this.objectiveId, current, required: this.required }],
      status: current >= this.required ? QuestStatus.ReadyToTurnIn : QuestStatus.InProgress,
      revision,
    };
  }
}

class FakePersistence {
  private readonly transactions = new Map<string, Uint8Array>();
  lastDomains: readonly string[] = [];
  lastData: PlayerSaveData | undefined;

  constructor(private readonly quests: FakeQuest) {}

  LoadTransaction(operationId: string): PlayerTransactionReceipt | undefined {
    const result = this.transactions.get(operationId);
    return result
      ? {
          revisions: [
            { characterId: 42n, domain: "inventory", revision: 1n },
            { characterId: 42n, domain: "quest", revision: 1n },
          ],
          result: result.slice(),
        }
      : undefined;
  }

  Capture(
    reason: string,
    overrides: { items?: readonly ItemSnapshot[]; skill?: SkillTransferState } = {},
  ): PlayerSaveData {
    return {
      player: {} as PlayerSaveData["player"],
      items: overrides.items ?? [],
      buffs: [],
      skill: overrides.skill ?? {
        globalCooldownEndAtMs: 0,
        cooldowns: [],
        itemCooldowns: [],
        knownSkillIds: [],
        proficiencies: [],
      },
      quests: this.quests.CaptureTransfer(),
      reason,
    };
  }

  ApplyTransaction(
    operationId: string,
    domains: readonly string[],
    data: PlayerSaveData,
    result: Uint8Array,
  ): PlayerTransactionResult {
    this.lastDomains = [...domains];
    this.lastData = data;
    const existing = this.transactions.get(operationId);
    if (existing) {
      return {
        disposition: "duplicate",
        revisions: [
          { characterId: 42n, domain: "inventory", revision: 1n },
          { characterId: 42n, domain: "quest", revision: 1n },
        ],
        result: existing.slice(),
      };
    }
    this.transactions.set(operationId, result.slice());
    return {
      disposition: "applied",
      revisions: [
        { characterId: 42n, domain: "inventory", revision: 1n },
        { characterId: 42n, domain: "quest", revision: 1n },
      ],
      result: result.slice(),
    };
  }
}

class FakeSkill {
  private proficiency: import("#tiangz/model").SkillProficiencyState;

  constructor(proficiency: import("#tiangz/model").SkillProficiencyState) {
    this.proficiency = { ...proficiency };
  }

  Proficiency(id: number): Readonly<import("#tiangz/model").SkillProficiencyState> | undefined {
    return id === this.proficiency.proficiencyId ? { ...this.proficiency } : undefined;
  }

  ProficiencyRank(id: number): number {
    return this.Proficiency(id)?.rank ?? 0;
  }

  CaptureTransfer(): SkillTransferState {
    return {
      globalCooldownEndAtMs: 0,
      cooldowns: [],
      itemCooldowns: [],
      knownSkillIds: [],
      proficiencies: [{ ...this.proficiency }],
    };
  }

  ApplyCommittedProficiency(
    proficiencyId: number,
    minimumRank: number,
    maximumRank: number,
  ): Readonly<import("#tiangz/model").SkillProficiencyState> {
    assert.equal(proficiencyId, this.proficiency.proficiencyId);
    this.proficiency = {
      proficiencyId,
      rank: Math.max(this.proficiency.rank, minimumRank),
      maximumRank: Math.max(this.proficiency.maximumRank, maximumRank),
    };
    return { ...this.proficiency };
  }
}

class FakeAoi {
  private attached = true;

  constructor(private readonly expected: unknown) {}

  IsAttached(value: unknown): boolean {
    assert.equal(value, this.expected);
    return this.attached;
  }

  Detach(value: unknown): readonly unknown[] {
    assert.equal(value, this.expected);
    this.attached = false;
    return [{ kind: "leave" }];
  }
}

class FakeMap {
  itemPublications = 0;
  questPublications = 0;
  visibilityPublications = 0;

  async PublishItemChanged(): Promise<void> {
    this.itemPublications += 1;
  }

  async PublishQuestProgress(): Promise<void> {
    this.questPublications += 1;
  }

  async PublishVisibilityChanges(): Promise<void> {
    this.visibilityPublications += 1;
  }
}

function testHotfixManifest() {
  return {
    formatVersion: 1 as const,
    bundleVersion: "interactable-self-test",
    modelFingerprint: "interactable-self-test",
    modelSourceHash: "interactable-self-test",
    protocolFingerprint: "interactable-self-test",
    stableCoreApiHash: "interactable-self-test",
    nativeSchemaHash: "interactable-self-test",
    hotfixHash: "interactable-self-test",
    buildMode: "demo" as const,
  };
}

runSelfTest(main);
