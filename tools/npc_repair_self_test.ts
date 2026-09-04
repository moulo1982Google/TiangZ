import { runSelfTest } from "./self_test_entry";
import assert from "node:assert/strict";

import {
  CurrencyComponent,
  ItemComponent,
  MapComponent,
  PlayerPersistenceComponent,
  type InventoryRepairPlan,
  type ItemSnapshot,
  type PlayerUnit,
} from "#tiangz/model";
import type {
  PlayerSaveData,
  PlayerTransactionReceipt,
  PlayerTransactionResult,
} from "../app/model/mmorpg/persistence/PlayerRepository";
import type { NpcRepairComponentSystem } from "../app/hotfix/mmorpg/repair/NpcRepairComponentSystem";


export async function main(): Promise<void> {
  const { InitializeGameSingletons } = await import("../app/core/runtime/Game");
  const { HotfixSystem } = await import("../app/core/hotReload/HotfixSystem");
  const { SingletonRegistry } = await import("../app/core/runtime/Singleton");
  InitializeGameSingletons(
    { fixedUpdateMs: 50, maxCatchUpSteps: 2 },
    { originServerId: 23, workerId: 1 },
  );
  HotfixSystem.Begin(testHotfixManifest());
  const { NpcRepairComponentSystem: RepairSystem } = await import(
    "../app/hotfix/mmorpg/repair/NpcRepairComponentSystem"
  );
  HotfixSystem.Commit();

  const inventory = new FakeInventory([
    item(9_001n, 1_001, 3, 10, 16),
    item(9_002n, 1_002, 5, 5, 0),
  ]);
  const currency = new FakeCurrency(25n);
  const persistence = new FakePersistence();
  const published: ItemSnapshot[] = [];
  const map = {
    PublishItemChanged: async (_player: PlayerUnit, changed: ItemSnapshot): Promise<void> => {
      published.push({ ...changed });
    },
  };
  const player = {
    Account: "npc-repair-self-test",
    CharacterId: 42n,
    GetComponent<T>(ctor: unknown): T {
      if (ctor === CurrencyComponent) return currency as T;
      if (ctor === ItemComponent) return inventory as T;
      if (ctor === PlayerPersistenceComponent) return persistence as T;
      throw new Error(`unexpected component: ${String(ctor)}`);
    },
    DomainScene: () => ({
      GetComponent<T>(ctor: unknown): T {
        assert.equal(ctor, MapComponent);
        return map as T;
      },
    }),
  } as unknown as PlayerUnit;
  const npc = {
    ValidateRepairInteraction(received: PlayerUnit, npcUnitId: number): void {
      assert.equal(received, player);
      assert.equal(npcUnitId, 0x4000_004e);
    },
  };
  const repair = Object.create(RepairSystem.prototype) as NpcRepairComponentSystem;
  (repair as unknown as { Awake(value: unknown): void }).Awake(npc);

  const request = {
    npcUnitId: 0x4000_004e,
    itemId: 9_001n,
    operationId: "repair-main-hand-1",
  };
  const repaired = await repair.Repair(player, request);
  assert.equal(repaired.cost, 7n);
  assert.equal(repaired.gold, 18n);
  assert.deepEqual(repaired.items, [item(9_001n, 1_001, 10, 10, 16, 2)]);
  assert.equal(currency.Gold, 18n);
  assert.deepEqual(persistence.lastDomains, ["inventory", "wallet"]);
  assert.deepEqual(persistence.lastItems, inventory.Snapshot());
  assert.equal(persistence.lastGold, 18n);

  // Replaying the operation must apply the durable receipt without charging twice.
  const replayed = await repair.Repair(player, request);
  assert.deepEqual(replayed, repaired);
  assert.equal(currency.Gold, 18n);
  assert.equal(inventory.Snapshot()[0]?.version, 2);
  assert.equal(published.length, 2);

  const repairAll = await repair.Repair(player, {
    npcUnitId: 0x4000_004e,
    itemId: 0n,
    operationId: "repair-all-full-inventory",
  });
  assert.deepEqual(repairAll, { cost: 0n, gold: 18n, items: [] });
  assert.equal(persistence.transactionCount, 1, "a no-op repair must not create a transaction");

  await SingletonRegistry.DestroyAll();
  console.log("NPC repair self-test passed");
}

function item(
  itemId: bigint,
  configId: number,
  durability: number,
  maxDurability: number,
  placementId: number,
  version = 1,
): ItemSnapshot {
  return {
    itemId,
    configId,
    count: 1,
    quality: 1,
    level: 1,
    version,
    durability,
    maxDurability,
    placementId,
  };
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

class FakeInventory {
  constructor(private items: ItemSnapshot[]) {}

  Snapshot(): ItemSnapshot[] {
    return this.items.map((value) => ({ ...value }));
  }

  PlanRepairItems(itemId: bigint): InventoryRepairPlan {
    const baseItems = this.Snapshot();
    const candidates = baseItems.filter((value) => (
      (itemId === 0n || value.itemId === itemId) &&
      (value.maxDurability ?? 0) > (value.durability ?? 0)
    ));
    if (itemId !== 0n && !baseItems.some((value) => value.itemId === itemId)) {
      throw new Error(`item not found: ${itemId}`);
    }
    const repairedById = new Map(candidates.map((value) => [value.itemId, {
      ...value,
      durability: value.maxDurability,
      version: value.version + 1,
    }]));
    const nextItems = baseItems.map((value) => repairedById.get(value.itemId) ?? value);
    const cost = candidates.reduce(
      (total, value) => total + BigInt((value.maxDurability ?? 0) - (value.durability ?? 0)),
      0n,
    );
    return {
      baseItems,
      nextItems,
      affectedItems: candidates.map((value) => repairedById.get(value.itemId)!),
      cost,
    };
  }

  CommitRepairPlan(plan: InventoryRepairPlan): readonly ItemSnapshot[] {
    assert.deepEqual(this.Snapshot(), plan.baseItems);
    this.items = plan.nextItems.map((value) => ({ ...value }));
    return plan.affectedItems.map((value) => ({ ...value }));
  }

  ApplyCommittedInventoryReplace(change: {
    readonly baseItems: readonly ItemSnapshot[];
    readonly nextItems: readonly ItemSnapshot[];
  }): readonly ItemSnapshot[] {
    const current = this.Snapshot();
    if (isSameInventory(current, change.nextItems)) return current;
    assert.ok(isSameInventory(current, change.baseItems));
    this.items = change.nextItems.map((value) => ({ ...value }));
    return this.Snapshot();
  }
}

class FakePersistence {
  private readonly transactions = new Map<string, Uint8Array>();
  lastDomains: readonly string[] = [];
  lastItems: readonly ItemSnapshot[] = [];
  lastGold = 0n;

  get transactionCount(): number {
    return this.transactions.size;
  }

  IsTransactionUncertain(): boolean {
    return false;
  }

  LoadTransaction(operationId: string): PlayerTransactionReceipt | undefined {
    const result = this.transactions.get(operationId);
    if (!result) return undefined;
    return {
      revisions: [
        { characterId: 42n, domain: "inventory", revision: 1n },
        { characterId: 42n, domain: "wallet", revision: 1n },
      ],
      result: result.slice(),
    };
  }

  Capture(_reason: string, overrides: { items?: readonly ItemSnapshot[]; gold?: bigint }): PlayerSaveData {
    this.lastItems = (overrides.items ?? []).map((value) => ({ ...value }));
    this.lastGold = overrides.gold ?? 0n;
    return {} as PlayerSaveData;
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
          { characterId: 42n, domain: "inventory", revision: 1n },
          { characterId: 42n, domain: "wallet", revision: 1n },
        ],
        result: existing.slice(),
      };
    }
    this.transactions.set(operationId, result.slice());
    return {
      disposition: "applied",
      revisions: [
        { characterId: 42n, domain: "inventory", revision: 1n },
        { characterId: 42n, domain: "wallet", revision: 1n },
      ],
      result: result.slice(),
    };
  }
}

function isSameInventory(
  left: readonly ItemSnapshot[],
  right: readonly ItemSnapshot[],
): boolean {
  return JSON.stringify(left, bigintJson) === JSON.stringify(right, bigintJson);
}

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function testHotfixManifest() {
  return {
    formatVersion: 1 as const,
    bundleVersion: "npc-repair-self-test",
    modelFingerprint: "npc-repair-self-test",
    modelSourceHash: "npc-repair-self-test",
    protocolFingerprint: "npc-repair-self-test",
    stableCoreApiHash: "npc-repair-self-test",
    nativeSchemaHash: "npc-repair-self-test",
    hotfixHash: "npc-repair-self-test",
    buildMode: "demo" as const,
  };
}

runSelfTest(main);
