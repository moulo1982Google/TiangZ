import { runSelfTest } from "./self_test_entry";
import assert from "node:assert/strict";

import {
  CurrencyComponent,
  NumericComponent,
  NumericType,
  PlayerPersistenceComponent,
  SkillComponent,
  type PlayerUnit,
} from "#tiangz/model";
import type {
  PlayerSaveData,
  PlayerTransactionReceipt,
  PlayerTransactionResult,
} from "../app/model/mmorpg/persistence/PlayerRepository";
import type { SkillTransferState } from "../app/model/mmorpg/skill/SkillComponent";
import type { TrainerComponentSystem } from "../app/hotfix/mmorpg/trainer/TrainerComponentSystem";


export async function main(): Promise<void> {
  const { InitializeGameSingletons } = await import("../app/core/runtime/Game");
  const { HotfixSystem } = await import("../app/core/hotReload/HotfixSystem");
  const { SingletonRegistry } = await import("../app/core/runtime/Singleton");
  InitializeGameSingletons(
    { fixedUpdateMs: 50, maxCatchUpSteps: 2 },
    { originServerId: 22, workerId: 1 },
  );
  HotfixSystem.Begin(testHotfixManifest());
  const { TrainerComponentSystem: TrainerSystem } = await import(
    "../app/hotfix/mmorpg/trainer/TrainerComponentSystem"
  );
  HotfixSystem.Commit();

  const currency = new FakeCurrency(250n);
  const skill = new FakeSkill([7_001], [{ proficiencyId: 182, rank: 50, maximumRank: 75 }]);
  const persistence = new FakePersistence();
  const numeric = { [NumericType.Level]: 5n };
  const player = {
    CharacterId: 42n,
    PlayerConfigId: 301,
    GetComponent<T>(ctor: unknown): T {
      if (ctor === CurrencyComponent) return currency as T;
      if (ctor === SkillComponent) return skill as T;
      if (ctor === PlayerPersistenceComponent) return persistence as T;
      if (ctor === NumericComponent) return numeric as T;
      throw new Error(`unexpected component: ${String(ctor)}`);
    },
  } as unknown as PlayerUnit;
  const npc = {
    ValidateTrainerInteraction(received: PlayerUnit, npcUnitId: number) {
      assert.equal(received, player);
      assert.equal(npcUnitId, 9001);
      return { TrainerId: 77 };
    },
  };
  const content = {
    TryGetDefinition(id: number) {
      assert.equal(id, 77);
      return {
        id: 77,
        kind: 0,
        requirementId: 0,
        greeting: "Train well.",
        eligiblePlayerConfigIds: [301],
        offers: [{
          skillConfigId: 7_002,
          price: 100,
          requiredLevel: 4,
          requiredSkillLineId: 0,
          requiredSkillRank: 0,
          prerequisiteSkillConfigIds: [7_001],
        }, {
          skillConfigId: 7_003,
          grantedSkillConfigIds: [7_004],
          price: 25,
          requiredLevel: 5,
          requiredSkillLineId: 182,
          requiredSkillRank: 50,
          prerequisiteSkillConfigIds: [],
          grantedProficiencyId: 182,
          grantedProficiencyMinimumRank: 50,
          grantedProficiencyMaximumRank: 150,
        }],
      };
    },
  };
  const definitions = { TryGet: (id: number) => id === 7_002 ? { id } : undefined };
  const trainer = Object.create(TrainerSystem.prototype) as TrainerComponentSystem;
  (trainer as unknown as { Awake(...args: unknown[]): void }).Awake(
    npc,
    content,
    definitions,
  );

  const request = {
    npcUnitId: 9001,
    skillConfigId: 7_002,
    operationId: "lesson-1",
  };
  const learned = await trainer.Learn(player, request);
  assert.deepEqual(learned, {
    skillConfigId: 7_002,
    learned: true,
    gold: 150n,
    proficiencies: [],
    learnedSkillConfigIds: [7_002],
  });
  assert.equal(currency.Gold, 150n);
  assert.deepEqual(skill.KnownSkillIds(), [7_001, 7_002]);
  assert.deepEqual(persistence.lastDomains, ["runtime", "wallet"]);
  assert.deepEqual(persistence.lastSkillIds, [7_001, 7_002]);

  const replayed = await trainer.Learn(player, request);
  assert.deepEqual(replayed, learned);
  assert.equal(currency.Gold, 150n);
  assert.deepEqual(skill.KnownSkillIds(), [7_001, 7_002]);

  const professionLearned = await trainer.Learn(player, {
    npcUnitId: 9001,
    skillConfigId: 7_003,
    operationId: "profession-lesson-1",
  });
  assert.deepEqual(professionLearned, {
    skillConfigId: 7_003,
    learned: true,
    gold: 125n,
    proficiencies: [{ proficiencyId: 182, rank: 50, maximumRank: 150 }],
    learnedSkillConfigIds: [7_004],
  });
  assert.deepEqual(skill.KnownSkillIds(), [7_001, 7_002, 7_004]);
  assert.deepEqual(skill.Proficiency(182), {
    proficiencyId: 182,
    rank: 50,
    maximumRank: 150,
  });
  assert.deepEqual(persistence.lastProficiencies, [{
    proficiencyId: 182,
    rank: 50,
    maximumRank: 150,
  }]);

  await SingletonRegistry.DestroyAll();
  console.log("trainer self-test passed");
}

class FakeCurrency {
  constructor(private gold: bigint) {}

  get Gold(): bigint {
    return this.gold;
  }

  ApplyCommittedGold(expectedGold: bigint, expectedBase: bigint): void {
    if (this.gold === expectedGold) return;
    assert.equal(this.gold, expectedBase);
    this.gold = expectedGold;
  }
}

class FakeSkill {
  private readonly known = new Set<number>();
  private readonly proficiencies = new Map<number, import("#tiangz/model").SkillProficiencyState>();

  constructor(
    ids: readonly number[],
    proficiencies: readonly import("#tiangz/model").SkillProficiencyState[] = [],
  ) {
    for (const id of ids) this.known.add(id);
    for (const proficiency of proficiencies) {
      this.proficiencies.set(proficiency.proficiencyId, { ...proficiency });
    }
  }

  KnowsSkill(id: number): boolean {
    return this.known.has(id);
  }

  KnownSkillIds(): readonly number[] {
    return [...this.known].sort(numberSort);
  }

  Proficiency(id: number): Readonly<import("#tiangz/model").SkillProficiencyState> | undefined {
    const value = this.proficiencies.get(id);
    return value ? { ...value } : undefined;
  }

  ProficiencyRank(id: number): number {
    return this.proficiencies.get(id)?.rank ?? 0;
  }

  CaptureTransfer(): SkillTransferState {
    return {
      globalCooldownEndAtMs: 0,
      cooldowns: [],
      itemCooldowns: [],
      knownSkillIds: this.KnownSkillIds(),
      proficiencies: [...this.proficiencies.values()].map((value) => ({ ...value })),
    };
  }

  ApplyCommittedLearnSkill(id: number): boolean {
    const previous = this.known.size;
    this.known.add(id);
    return previous !== this.known.size;
  }

  ApplyCommittedProficiency(
    proficiencyId: number,
    minimumRank: number,
    maximumRank: number,
  ): Readonly<import("#tiangz/model").SkillProficiencyState> {
    const previous = this.proficiencies.get(proficiencyId);
    const next = {
      proficiencyId,
      rank: Math.max(previous?.rank ?? 0, minimumRank),
      maximumRank: Math.max(previous?.maximumRank ?? 0, maximumRank),
    };
    this.proficiencies.set(proficiencyId, next);
    return { ...next };
  }
}

class FakePersistence {
  private readonly transactions = new Map<string, Uint8Array>();
  lastDomains: readonly string[] = [];
  lastSkillIds: readonly number[] = [];
  lastProficiencies: readonly import("#tiangz/model").SkillProficiencyState[] = [];

  IsTransactionUncertain(): boolean {
    return false;
  }

  LoadTransaction(operationId: string): PlayerTransactionReceipt | undefined {
    const result = this.transactions.get(operationId);
    if (!result) return undefined;
    return {
      revisions: [
        { characterId: 42n, domain: "runtime", revision: 1n },
        { characterId: 42n, domain: "wallet", revision: 1n },
      ],
      result: result.slice(),
    };
  }

  Capture(_reason: string, overrides: { skill?: SkillTransferState } = {}): PlayerSaveData {
    this.lastSkillIds = [...(overrides.skill?.knownSkillIds ?? [])];
    this.lastProficiencies = (overrides.skill?.proficiencies ?? []).map((value) => ({ ...value }));
    return { skill: overrides.skill } as PlayerSaveData;
  }

  ApplyTransaction(
    operationId: string,
    domains: readonly string[],
    _data: PlayerSaveData,
    result: Uint8Array,
  ): PlayerTransactionResult {
    this.lastDomains = [...domains];
    const existing = this.transactions.get(operationId);
    if (existing) {
      return {
        disposition: "duplicate",
        revisions: [
          { characterId: 42n, domain: "runtime", revision: 1n },
          { characterId: 42n, domain: "wallet", revision: 1n },
        ],
        result: existing.slice(),
      };
    }
    this.transactions.set(operationId, result.slice());
    return {
      disposition: "applied",
      revisions: [
        { characterId: 42n, domain: "runtime", revision: 1n },
        { characterId: 42n, domain: "wallet", revision: 1n },
      ],
      result: result.slice(),
    };
  }
}

function numberSort(left: number, right: number): number {
  return left - right;
}

function testHotfixManifest() {
  return {
    formatVersion: 1 as const,
    bundleVersion: "trainer-self-test",
    modelFingerprint: "trainer-self-test",
    modelSourceHash: "trainer-self-test",
    protocolFingerprint: "trainer-self-test",
    stableCoreApiHash: "trainer-self-test",
    nativeSchemaHash: "trainer-self-test",
    hotfixHash: "trainer-self-test",
    buildMode: "demo" as const,
  };
}

runSelfTest(main);
