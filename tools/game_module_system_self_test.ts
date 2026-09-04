import { runSelfTest } from "./self_test_entry";
import { strict as assert } from "node:assert";

import { HotfixSystem } from "../app/core/hotReload/HotfixSystem";
import type { HotfixManifest } from "../app/core/hotReload/contracts";
import {
  defineGameModule,
  sealGameModules,
} from "../app/core/modules/GameModuleSystem";
import {
  applyEntityExtensions,
  entityExtensionHandler,
  type EntityExtensionHandler,
} from "../app/core/modules/EntityExtensionSystem";
import { Component, Entity } from "../app/core/runtime/entities";
import { systemFor } from "../app/core/hotReload/HotfixSystem";
import { ActionType } from "../app/model/mmorpg/action/ActionType";
import { ItemContentProfileComponent } from "../app/model/mmorpg/item/ItemContentProfileComponent";
import { LootContentProfileComponent } from "../app/model/mmorpg/loot/LootContentProfileComponent";
import { MonsterContentProfileComponent } from "../app/model/mmorpg/monster/MonsterContentProfileComponent";
import { NpcContentProfileComponent } from "../app/model/mmorpg/npc/NpcContentProfileComponent";
import { PlayerContentProfileComponent } from "../app/model/mmorpg/login/PlayerContentProfileComponent";
import { QuestContentProfileComponent } from "../app/model/mmorpg/quest/QuestContentProfileComponent";
import { TrainerContentProfileComponent } from "../app/model/mmorpg/trainer/TrainerContentProfileComponent";
import { SkillDefinitionProfileComponent } from "../app/model/mmorpg/skill/SkillDefinitionProfileComponent";
import {
  SkillAutoAttackPolicy,
  SkillDelivery,
  SkillEffectTarget,
  SkillMovementPolicy,
  SkillTargetRelation,
  type SkillDefinition,
} from "../app/model/mmorpg/skill/SkillDefinition";

export function main(): void {
  class GreetingCounter extends Component {
    protected count = 0;
  }

  class ExtensionTarget extends Entity {}
  class ExtensionMarker extends Component {}
  class AttachExtensionMarker implements EntityExtensionHandler<ExtensionTarget> {
    Attach(entity: ExtensionTarget): void {
      entity.AddComponent(ExtensionMarker);
    }
  }

  assert.throws(
    () => defineGameModule({ id: "invalid", version: "1.0.0", modelExports: {} }),
    /invalid game module id/,
  );
  assert.throws(
    () => defineGameModule({ id: "org.example.invalid-version", version: "1.0.0-01", modelExports: {} }),
    /invalid game module version/,
  );
  const accessorExports = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(accessorExports, "Dynamic", {
    enumerable: true,
    get: () => ({}),
  });
  assert.throws(
    () => defineGameModule({
      id: "org.example.accessor",
      version: "1.0.0",
      modelExports: accessorExports,
    }),
    /enumerable data properties/,
  );

  const moduleMetadata = { labels: ["fixture"] };

  defineGameModule({
    id: "org.example.greeting",
    version: "1.0.0+fixture.1",
    modelExports: { GreetingCounter, moduleMetadata },
    requiredSystems: [GreetingCounter],
  });
  sealGameModules([{ id: "org.example.greeting", version: "1.0.0+fixture.1" }]);

  const installed = (globalThis as typeof globalThis & {
    __tiangzModuleModelExports: Record<string, Record<string, unknown>>;
  }).__tiangzModuleModelExports;
  assert.equal(installed["org.example.greeting"].GreetingCounter, GreetingCounter);
  assert.equal(installed["org.example.greeting"].moduleMetadata, moduleMetadata);
  assert.equal(Object.isFrozen(installed), true);
  assert.equal(Object.isFrozen(installed["org.example.greeting"]), true);
  assert.equal(Object.isFrozen(moduleMetadata), true);
  assert.equal(Object.isFrozen(moduleMetadata.labels), true);
  assert.equal(Reflect.set(moduleMetadata, "changed", true), false);
  assert.throws(
    () => defineGameModule({ id: "org.example.late", version: "1.0.0", modelExports: {} }),
    /registration is sealed/,
  );

  HotfixSystem.Begin(manifest("missing"));
  assert.throws(() => HotfixSystem.Commit(), /required System is missing/);

  HotfixSystem.Begin(manifest("complete"));
  systemFor(GreetingCounter)(class GreetingCounterSystem extends GreetingCounter {
    Increment(): number {
      this.count += 1;
      return this.count;
    }
  });
  entityExtensionHandler(ExtensionTarget, { id: "org.example.extension-marker" })(
    AttachExtensionMarker,
  );
  const status = HotfixSystem.Commit();
  assert.equal(status.activeGeneration, 1);
  assert.equal(status.activeVersion, "complete");

  const extended = new ExtensionTarget();
  assert.deepEqual(applyEntityExtensions(extended), { handlerCount: 1 });
  assert.equal(extended.HasComponent(ExtensionMarker), true);
  assert.throws(() => applyEntityExtensions(extended), /already applied/);

  const skillDefinitions = new SkillDefinitionProfileComponent({});
  const externalStrike: SkillDefinition = {
    id: 900_001,
    name: "External Strike",
    description: "Neutral module fixture skill",
    relation: SkillTargetRelation.Enemy,
    castTimeMs: 0,
    cooldownMs: 0,
    globalCooldownMs: 0,
    rangeMeters: 4,
    delivery: SkillDelivery.Direct,
    projectileSpeedMetersPerSecond: 0,
    movementPolicy: SkillMovementPolicy.Allow,
    autoAttackPolicy: SkillAutoAttackPolicy.Keep,
    revalidateOnComplete: true,
    requiredAbsentBuffConfigId: 0,
    queueWindowMs: 0,
    channelTickMs: 0,
    channelTicks: 0,
    effects: [{
      target: SkillEffectTarget.PrimaryTarget,
      action: { type: ActionType.DealDamage, parameters: [15n, 1n] },
    }],
  };
  skillDefinitions.Register("org.example.greeting", [externalStrike]);
  assert.equal(skillDefinitions.Count, 1);
  assert.equal(skillDefinitions.OwnerOf(externalStrike.id), "org.example.greeting");
  assert.equal(skillDefinitions.TryGet(externalStrike.id)?.effects[0]?.action.parameters[0], 15n);
  assert.equal(Object.isFrozen(skillDefinitions.TryGet(externalStrike.id)), true);
  assert.equal(Object.isFrozen(skillDefinitions.TryGet(externalStrike.id)?.effects), true);
  assert.throws(
    () => skillDefinitions.Register("org.example.other", [externalStrike]),
    /already belongs to org\.example\.greeting/,
  );
  assert.throws(
    () => skillDefinitions.Register("org.example.invalid", [{ ...externalStrike, id: 900_002, effects: [] }]),
    /must contain at least one effect/,
  );

  const monsterContent = new MonsterContentProfileComponent({});
  monsterContent.ReplaceColdContent("org.example.greeting");
  assert.equal(monsterContent.IncludesColdContent, false);
  assert.equal(monsterContent.ColdContentReplacementOwner, "org.example.greeting");
  assert.throws(
    () => monsterContent.ReplaceColdContent("org.example.other"),
    /already belongs to org\.example\.greeting/,
  );
  monsterContent.Register("org.example.greeting", {
    definitions: [{
      id: 700_001,
      name: "Training Dummy",
      modelId: "fixture-dummy",
      presentationStateId: 234,
      initialBuffDefinitionIds: [800_001],
      maxHp: 100,
      maxMp: 0,
      attackDamage: 0,
      moveSpeed: 1,
      attackRange: 2,
      attackIntervalMs: 2_000,
      attackMode: 0,
      skillId: 0,
      dropTableId: 0,
      rewardExperienceByPlayerLevel: [
        { playerLevel: 2, experience: 45 },
        { playerLevel: 1, experience: 50 },
      ],
    }],
    spawns: [{
      id: 710_001,
      monsterDefinitionId: 700_001,
      presentationStateId: 235,
      initialBuffDefinitionIds: [800_002],
      spawnX: 2,
      spawnY: 0,
      spawnZ: -3,
      spawnYaw: 0,
      initialSpawn: true,
      respawnSeconds: 15,
    }],
  });
  assert.equal(monsterContent.DefinitionCount, 1);
  assert.equal(monsterContent.SpawnCount, 1);
  assert.equal(monsterContent.DefinitionOwnerOf(700_001), "org.example.greeting");
  assert.equal(monsterContent.SpawnOwnerOf(710_001), "org.example.greeting");
  assert.equal(monsterContent.TryGetDefinition(700_001)?.presentationStateId, 234);
  assert.deepEqual(monsterContent.TryGetDefinition(700_001)?.initialBuffDefinitionIds, [800_001]);
  assert.equal(monsterContent.GetSpawns()[0].presentationStateId, 235);
  assert.deepEqual(monsterContent.GetSpawns()[0].initialBuffDefinitionIds, [800_002]);
  assert.equal(Object.isFrozen(monsterContent.TryGetDefinition(700_001)), true);
  assert.deepEqual(monsterContent.TryGetDefinition(700_001)?.rewardExperienceByPlayerLevel, [
    { playerLevel: 1, experience: 50 },
    { playerLevel: 2, experience: 45 },
  ]);
  assert.equal(
    Object.isFrozen(monsterContent.TryGetDefinition(700_001)?.rewardExperienceByPlayerLevel),
    true,
  );
  assert.equal(Object.isFrozen(monsterContent.GetSpawns()[0]), true);
  assert.throws(
    () => monsterContent.Register("org.example.other", {
      definitions: [],
      spawns: [{
        id: 710_002,
        monsterDefinitionId: 700_001,
        spawnX: 0,
        spawnY: 0,
        spawnZ: 0,
        spawnYaw: 0,
        initialSpawn: true,
        respawnSeconds: 0,
      }],
    }),
    /owned by org\.example\.greeting/,
  );
  assert.equal(monsterContent.SpawnCount, 1);
  monsterContent.Seal();
  assert.throws(
    () => monsterContent.Register("org.example.greeting", { definitions: [], spawns: [] }),
    /is sealed/,
  );

  const npcContent = new NpcContentProfileComponent({});
  npcContent.ReplaceColdContent("org.example.greeting");
  npcContent.Register("org.example.greeting", {
    definitions: [{
      id: 720_001,
      name: "Training Quartermaster",
      presentationStateId: 234,
      initialBuffDefinitionIds: [800_003],
      questStarterConfigIds: [730_001],
      questEnderConfigIds: [730_001, 730_002],
      shopItemConfigIds: [750_001],
      trainerId: 17,
      shopEnabled: true,
    }],
    spawns: [{
      id: 721_001,
      npcDefinitionId: 720_001,
      presentationStateId: 235,
      initialBuffDefinitionIds: [800_004],
      spawnX: 4,
      spawnY: 0,
      spawnZ: -2,
      spawnYaw: 1.5,
      initialSpawn: true,
      waypoints: [{
        x: 4,
        y: 0,
        z: -2,
        yaw: 1.5,
        delayMs: 250,
        moveSpeed: 1.25,
      }],
      idleSequences: [{
        id: 721_101,
        chancePermille: 1_000,
        initialDelayMinMs: 0,
        initialDelayMaxMs: 0,
        repeatDelayMinMs: 1_000,
        repeatDelayMaxMs: 1_000,
        actions: [{
          id: 721_102,
          type: 1,
          target: 1,
          delayMs: 0,
          chancePermille: 1_000,
          presentationId: 273,
        }, {
          id: 721_103,
          type: 1,
          target: 1,
          delayMs: 100,
          delayMaxMs: 200,
          chancePermille: 1_000,
          presentationIds: [273, 274],
        }, {
          id: 721_104,
          type: 3,
          target: 1,
          delayMs: 300,
          chancePermille: 1_000,
          textChoices: ["Welcome to the training yard."],
        }, {
          id: 721_105,
          type: 4,
          target: 1,
          delayMs: 400,
          chancePermille: 1_000,
          presentationId: 0,
        }],
      }],
    }],
  });
  assert.equal(npcContent.IncludesColdContent, false);
  assert.equal(npcContent.DefinitionCount, 1);
  assert.equal(npcContent.SpawnCount, 1);
  assert.equal(npcContent.DefinitionOwnerOf(720_001), "org.example.greeting");
  assert.equal(npcContent.SpawnOwnerOf(721_001), "org.example.greeting");
  assert.equal(npcContent.TryGetDefinition(720_001)?.presentationStateId, 234);
  assert.deepEqual(npcContent.TryGetDefinition(720_001)?.initialBuffDefinitionIds, [800_003]);
  assert.equal(npcContent.GetSpawns()[0].presentationStateId, 235);
  assert.deepEqual(npcContent.GetSpawns()[0].initialBuffDefinitionIds, [800_004]);
  assert.deepEqual(npcContent.GetSpawns()[0].waypoints, [{
    x: 4,
    y: 0,
    z: -2,
    yaw: 1.5,
    delayMs: 250,
    moveSpeed: 1.25,
  }]);
  assert.equal(Object.isFrozen(npcContent.GetSpawns()[0].waypoints), true);
  assert.equal(npcContent.GetSpawns()[0].idleSequences?.length, 1);
  assert.equal(npcContent.GetSpawns()[0].idleSequences?.[0].actions[0].presentationId, 273);
  assert.deepEqual(npcContent.GetSpawns()[0].idleSequences?.[0].actions[1].presentationIds, [273, 274]);
  assert.equal(npcContent.GetSpawns()[0].idleSequences?.[0].actions[1].delayMaxMs, 200);
  assert.deepEqual(npcContent.GetSpawns()[0].idleSequences?.[0].actions[2].textChoices, [
    "Welcome to the training yard.",
  ]);
  assert.equal(npcContent.GetSpawns()[0].idleSequences?.[0].actions[3].presentationId, 0);
  assert.equal(Object.isFrozen(npcContent.GetSpawns()[0].idleSequences), true);
  assert.equal(Object.isFrozen(npcContent.GetSpawns()[0].idleSequences?.[0].actions), true);
  assert.deepEqual(npcContent.TryGetDefinition(720_001)?.questStarterConfigIds, [730_001]);
  assert.deepEqual(npcContent.TryGetDefinition(720_001)?.questEnderConfigIds, [730_001, 730_002]);
  assert.equal(Object.isFrozen(npcContent.TryGetDefinition(720_001)?.questStarterConfigIds), true);
  assert.equal(Object.isFrozen(npcContent.TryGetDefinition(720_001)?.questEnderConfigIds), true);
  assert.throws(
    () => npcContent.Register("org.example.other", {
      definitions: [],
      spawns: [{
        id: 721_002,
        npcDefinitionId: 720_001,
        spawnX: 0,
        spawnY: 0,
        spawnZ: 0,
        spawnYaw: 0,
        initialSpawn: true,
      }],
    }),
    /owned by org\.example\.greeting/,
  );
  assert.equal(npcContent.SpawnCount, 1);
  npcContent.Seal();
  assert.throws(
    () => npcContent.Register("org.example.greeting", { definitions: [], spawns: [] }),
    /is sealed/,
  );

  const questContent = new QuestContentProfileComponent({});
  questContent.Register("org.example.greeting", [{
    id: 730_001,
    name: "Cull the Practice Beasts",
    objectives: [{
      id: 731_001,
      objectiveType: 1,
      targetConfigId: 700_001,
      requiredCount: 2,
    }],
    acceptActions: [],
    rewardActions: [],
    autoAccept: false,
    requiredQuestIds: [],
    minimumLevel: 1,
  }]);
  assert.equal(questContent.DefinitionCount, 1);
  assert.equal(questContent.DefinitionOwnerOf(730_001), "org.example.greeting");
  assert.deepEqual(questContent.TryGetDefinition(730_001)?.objectives[0], {
    id: 731_001,
    objectiveType: 1,
    targetConfigId: 700_001,
    requiredCount: 2,
  });
  assert.equal(Object.isFrozen(questContent.TryGetDefinition(730_001)?.objectives), true);
  assert.equal(Object.isFrozen(questContent.TryGetDefinition(730_001)?.objectives[0]), true);
  questContent.Seal();
  assert.throws(
    () => questContent.Register("org.example.greeting", []),
    /is sealed/,
  );

  const itemContent = new ItemContentProfileComponent({});
  itemContent.ReplaceColdContent("org.example.greeting");
  itemContent.Register("org.example.greeting", [{
    id: 750_001,
    name: "Training Token",
    quality: 1,
    level: 1,
    maxStack: 20,
    useEffect: 0,
    useParams: [],
    cooldownMs: 0,
    globalCooldownMs: 0,
    buyPrice: 5,
    sellPrice: 1,
    maxDurability: 12,
  }]);
  assert.equal(itemContent.IncludesColdContent, false);
  assert.equal(itemContent.DefinitionCount, 1);
  assert.equal(itemContent.DefinitionOwnerOf(750_001), "org.example.greeting");
  assert.equal(Object.isFrozen(itemContent.TryGetDefinition(750_001)), true);
  assert.equal(Object.isFrozen(itemContent.TryGetDefinition(750_001)?.useParams), true);
  assert.equal(itemContent.TryGetDefinition(750_001)?.maxDurability, 12);
  assert.throws(
    () => itemContent.Register("org.example.other", [{
      ...itemContent.TryGetDefinition(750_001)!,
    }]),
    /already belongs to org\.example\.greeting/,
  );
  itemContent.Seal();
  assert.throws(
    () => itemContent.Register("org.example.greeting", []),
    /is sealed/,
  );

  const lootContent = new LootContentProfileComponent({});
  lootContent.ReplaceColdContent("org.example.greeting");
  lootContent.Register("org.example.greeting", [
    {
      id: 760_001,
      dropTableId: 761_001,
      itemConfigId: 750_001,
      minCount: 1,
      maxCount: 2,
      chancePermille: 1_000,
      questObjectiveId: 0,
      gold: 0,
    },
    {
      id: 760_002,
      dropTableId: 761_002,
      nestedDropTableId: 761_001,
      itemConfigId: 0,
      minCount: 1,
      maxCount: 1,
      chancePermille: 1_000,
      questObjectiveId: 0,
      gold: 0,
    },
  ]);
  assert.equal(lootContent.IncludesColdContent, false);
  assert.equal(lootContent.RowCount, 2);
  assert.equal(lootContent.RowOwnerOf(760_001), "org.example.greeting");
  assert.deepEqual(lootContent.GetRows(761_001).map((row) => row.id), [760_001]);
  assert.equal(Object.isFrozen(lootContent.GetRows(761_001)[0]), true);
  assert.throws(
    () => lootContent.Register("org.example.other", [{
      id: 760_001,
      dropTableId: 761_002,
      itemConfigId: 750_001,
      minCount: 1,
      maxCount: 1,
      chancePermille: 1,
      questObjectiveId: 0,
      gold: 0,
    }]),
    /already belongs to org\.example\.greeting/,
  );
  const missingNestedLoot = new LootContentProfileComponent({});
  assert.throws(
    () => missingNestedLoot.Register("org.example.invalid", [{
      id: 760_010,
      dropTableId: 761_010,
      nestedDropTableId: 761_099,
      itemConfigId: 0,
      minCount: 1,
      maxCount: 1,
      chancePermille: 1_000,
      questObjectiveId: 0,
      gold: 0,
    }]),
    /missing nested table 761099/,
  );
  const cyclicNestedLoot = new LootContentProfileComponent({});
  assert.throws(
    () => cyclicNestedLoot.Register("org.example.invalid", [
      {
        id: 760_011,
        dropTableId: 761_011,
        nestedDropTableId: 761_012,
        itemConfigId: 0,
        minCount: 1,
        maxCount: 1,
        chancePermille: 1_000,
        questObjectiveId: 0,
        gold: 0,
      },
      {
        id: 760_012,
        dropTableId: 761_012,
        nestedDropTableId: 761_011,
        itemConfigId: 0,
        minCount: 1,
        maxCount: 1,
        chancePermille: 1_000,
        questObjectiveId: 0,
        gold: 0,
      },
    ]),
    /cycle/,
  );
  const invalidGroupedLoot = new LootContentProfileComponent({});
  assert.throws(
    () => invalidGroupedLoot.Register("org.example.invalid", [
      {
        id: 760_013,
        dropTableId: 761_013,
        groupId: 1,
        itemConfigId: 750_001,
        minCount: 1,
        maxCount: 1,
        chancePermille: 700,
        questObjectiveId: 0,
        gold: 0,
      },
      {
        id: 760_014,
        dropTableId: 761_013,
        groupId: 1,
        itemConfigId: 750_002,
        minCount: 1,
        maxCount: 1,
        chancePermille: 400,
        questObjectiveId: 0,
        gold: 0,
      },
    ]),
    /exceed 1000 permille/,
  );
  assert.equal(invalidGroupedLoot.RowCount, 0);
  assert.throws(
    () => invalidGroupedLoot.Register("org.example.invalid", [
      {
        id: 760_015,
        dropTableId: 761_014,
        groupId: 1,
        itemConfigId: 750_001,
        minCount: 1,
        maxCount: 1,
        chancePermille: 1_000,
        questObjectiveId: 0,
        gold: 0,
      },
      {
        id: 760_016,
        dropTableId: 761_014,
        groupId: 1,
        itemConfigId: 750_002,
        minCount: 1,
        maxCount: 1,
        chancePermille: 0,
        questObjectiveId: 0,
        gold: 0,
      },
    ]),
    /leave no probability for equal candidates/,
  );
  assert.equal(invalidGroupedLoot.RowCount, 0);
  lootContent.Seal();
  assert.throws(
    () => lootContent.Register("org.example.greeting", []),
    /is sealed/,
  );

  const trainerContent = new TrainerContentProfileComponent({});
  trainerContent.ReplaceColdContent("org.example.greeting");
  trainerContent.Register("org.example.greeting", [{
    id: 17,
    kind: 0,
    requirementId: 8,
    greeting: "Ready for training?",
    offers: [{
      skillConfigId: 335_000_116,
      price: 100,
      requiredLevel: 4,
      requiredSkillLineId: 0,
      requiredSkillRank: 0,
      prerequisiteSkillConfigIds: [],
    }],
  }]);
  assert.equal(trainerContent.IncludesColdContent, false);
  assert.equal(trainerContent.DefinitionCount, 1);
  assert.equal(trainerContent.DefinitionOwnerOf(17), "org.example.greeting");
  assert.equal(trainerContent.TryGetDefinition(17)?.offers[0]?.skillConfigId, 335_000_116);
  assert.equal(Object.isFrozen(trainerContent.TryGetDefinition(17)?.offers), true);
  assert.equal(Object.isFrozen(trainerContent.TryGetDefinition(17)?.offers[0]), true);
  assert.throws(
    () => trainerContent.Register("org.example.other", [{
      ...trainerContent.TryGetDefinition(17)!,
    }]),
    /already belongs to org\.example\.greeting/,
  );
  trainerContent.Seal();
  assert.throws(
    () => trainerContent.Register("org.example.greeting", []),
    /is sealed/,
  );

  const playerContent = new PlayerContentProfileComponent({});
  playerContent.Register("org.example.greeting", [{
    id: 740_001,
    initialItems: [
      { configId: 750_001, count: 1, placementId: 3 },
      { configId: 750_001, count: 2 },
    ],
    progressionLevels: [{
      level: 1,
      experienceToNextLevel: 400,
      numerics: [{ numericType: 10_001, value: 20 }],
    }, {
      level: 2,
      experienceToNextLevel: 0,
      numerics: [{ numericType: 10_001, value: 29 }],
    }],
  }, { id: 740_002, deadAdmissionPolicy: "preserve" }]);
  assert.equal(playerContent.Count, 2);
  assert.equal(playerContent.IsRegistered(740_001), true);
  assert.equal(playerContent.OwnerOf(740_002), "org.example.greeting");
  assert.equal(playerContent.TryGet(740_001)?.deadAdmissionPolicy, "revive-at-spawn");
  assert.equal(playerContent.TryGet(740_002)?.deadAdmissionPolicy, "preserve");
  assert.equal(playerContent.TryGet(740_001)?.progressionLevels?.[1]?.numerics[0]?.value, 29);
  assert.deepEqual(playerContent.TryGet(740_001)?.initialItems, [
    { configId: 750_001, count: 1, placementId: 3 },
    { configId: 750_001, count: 2, placementId: 0 },
  ]);
  assert.equal(Object.isFrozen(playerContent.TryGet(740_001)?.initialItems), true);
  assert.throws(
    () => new PlayerContentProfileComponent({}).Register("org.example.invalid", [{
      id: 740_003,
      initialItems: [
        { configId: 750_001, count: 1, placementId: 3 },
        { configId: 750_002, count: 1, placementId: 3 },
      ],
    }]),
    /duplicate placement 3/,
  );
  assert.throws(
    () => new PlayerContentProfileComponent({}).Register("org.example.invalid-policy", [{
      id: 740_004,
      deadAdmissionPolicy: "unknown" as never,
    }]),
    /dead admission policy must be revive-at-spawn or preserve/,
  );
  assert.throws(
    () => playerContent.Register("org.example.other", [{ id: 740_002 }]),
    /already belongs to org\.example\.greeting/,
  );
  playerContent.Seal();
  assert.throws(
    () => playerContent.Register("org.example.greeting", [{ id: 740_003 }]),
    /is sealed/,
  );

  process.stdout.write("game module system self-test passed\n");

  function manifest(bundleVersion: string): HotfixManifest {
    return {
      formatVersion: 1,
      bundleVersion,
      modelFingerprint: "module-self-test",
      modelSourceHash: "module-self-test",
      protocolFingerprint: "module-self-test",
      stableCoreApiHash: "module-self-test",
      nativeSchemaHash: "module-self-test",
      hotfixHash: bundleVersion,
      buildMode: "demo",
    };
  }
}

runSelfTest(main);
