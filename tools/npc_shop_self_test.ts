import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  CurrencyComponent,
  GameConfigRegistry,
  GameConfigs,
  MapComponent,
  PlayerPersistenceComponent,
  type PlayerUnit,
} from "#tiangz/model";
import type { ItemSnapshot } from "../app/generated/model/server/demo/protocol/messages";
import type {
  PlayerSaveData,
  PlayerTransactionReceipt,
  PlayerTransactionResult,
} from "../app/model/mmorpg/persistence/PlayerRepository";
import type { NpcShopComponentSystem } from "../app/hotfix/mmorpg/shop/NpcShopComponentSystem";

void main();

async function main(): Promise<void> {
  const manifestJson = readFileSync(
    path.resolve("game_config/generated/game-config.manifest.json"),
    "utf8",
  );
  const dataJson = readFileSync(path.resolve("game_config/generated/server.json"), "utf8");
  GameConfigRegistry.Install(manifestJson, dataJson);

  assert.equal(GameConfigs.ItemConfig.Get(1001).buyPrice, 50);
  assert.equal(GameConfigs.ItemConfig.Get(1003).buyPrice, 50);
  assert.equal(GameConfigs.ItemConfig.Get(1201).sellPrice, 10);

  // Decorator注册需要处于一次热更提交中；测试只安装商店System，不启动完整Runtime。
  // Decorator registration requires one hotfix commit; this test installs only
  // the shop System and does not start the full runtime.
  const { InitializeGameSingletons } = await import("../app/core/runtime/Game");
  const { HotfixSystem } = await import("../app/core/hotReload/HotfixSystem");
  const { SingletonRegistry } = await import("../app/core/runtime/Singleton");
  InitializeGameSingletons(
    { fixedUpdateMs: 50, maxCatchUpSteps: 2 },
    { originServerId: 21, workerId: 1 },
  );
  HotfixSystem.Begin(testHotfixManifest());
  const { NpcShopComponentSystem: ShopSystem } = await import(
    "../app/hotfix/mmorpg/shop/NpcShopComponentSystem"
  );
  HotfixSystem.Commit();

  const inventory = new FakeInventory([
    item(9001n, 1201, 2),
  ]);
  const currency = new FakeCurrency(100n);
  const persistence = new FakePersistence();
  const publishedItems: ItemSnapshot[] = [];
  const map = {
    PublishItemChanged: async (_player: PlayerUnit, changed: ItemSnapshot): Promise<void> => {
      publishedItems.push({ ...changed });
    },
  };
  const player = {
    Account: "npc-shop-self-test",
    CharacterId: 1n,
    UnitId: 1,
    GetComponent<T>(ctor: unknown): T {
      if (ctor === CurrencyComponent) return currency as T;
      if (ctor === PlayerPersistenceComponent) return persistence as T;
      return inventory as T;
    },
    DomainScene: () => ({
      GetComponent<T>(ctor: unknown): T {
        assert.equal(ctor, MapComponent);
        return map as T;
      },
    }),
  } as unknown as PlayerUnit;
  const npc = {
    ValidateShopInteraction(receivedPlayer: PlayerUnit, npcUnitId: number): void {
      assert.equal(receivedPlayer, player);
      assert.equal(npcUnitId, 0x4000_0002);
    },
  };
  const shop = Object.create(ShopSystem.prototype) as NpcShopComponentSystem;
  Object.defineProperty(shop, "DomainScene", {
    value: () => ({ logger: { info(): void {} } }),
  });
  (shop as unknown as { Awake(value: unknown): void }).Awake(npc);

  const opened = shop.Open(player, 0x4000_0002);
  assert.deepEqual(opened.items.map((value) => value.itemConfigId), [1001, 1003]);
  assert.equal(opened.gold, 100n);
  assert.ok(opened.inventory);
  assert.deepEqual(opened.inventory.items, inventory.Snapshot());

  const buyRequest = {
    npcUnitId: 0x4000_0002,
    itemConfigId: 1001,
    count: 1,
    operationId: "buy-red-1",
  };
  const bought = await shop.Buy(player, buyRequest);
  assert.equal(bought.itemConfigId, 1001);
  assert.equal(bought.count, 1);
  assert.equal(bought.gold, 50n);
  assert.equal(currency.gold, 50n);
  assert.equal(inventory.Count(1001), 1);

  // 同一个operationId重复到达时只能返回第一次回执，不能再次增加药品或扣金币。
  // Replaying one operationId returns the first receipt and must not grant or charge again.
  const duplicateBuy = await shop.Buy(player, buyRequest);
  assert.deepEqual(duplicateBuy, bought);
  assert.equal(currency.gold, 50n);
  assert.equal(inventory.Count(1001), 1);

  const sellRequest = {
    npcUnitId: 0x4000_0002,
    itemId: 9001n,
    count: 1,
    operationId: "sell-cloth-1",
  };
  const sold = await shop.Sell(player, sellRequest);
  assert.equal(sold.itemConfigId, 1201);
  assert.equal(sold.count, 1);
  assert.equal(sold.gold, 60n);
  assert.equal(currency.gold, 60n);
  assert.equal(inventory.Count(1201), 1);

  // 出售重试同样不能再次扣除同一Item，也不能重复发放金币。
  // Selling the same operation again must not consume the Item or mint more gold.
  const duplicateSell = await shop.Sell(player, sellRequest);
  assert.deepEqual(duplicateSell, sold);
  assert.equal(currency.gold, 60n);
  assert.equal(inventory.Count(1201), 1);
  assert.equal(publishedItems.length, 4);

  await SingletonRegistry.DestroyAll();
  console.log("NPC shop self-test passed");
}

function item(itemId: bigint, configId: number, count: number, version = 1): ItemSnapshot {
  return { itemId, configId, count, quality: 0, level: 1, version };
}

class FakeCurrency {
  constructor(public gold: bigint) {}

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

  Count(configId: number): number {
    return this.items
      .filter((value) => value.configId === configId)
      .reduce((total, value) => total + value.count, 0);
  }

  GetItem(itemId: bigint): ItemSnapshot | undefined {
    return this.items.find((value) => value.itemId === itemId);
  }

  PlanGrantItems(grants: readonly { configId: number; count: number }[]): {
    baseItems: readonly ItemSnapshot[];
    nextItems: readonly ItemSnapshot[];
    affectedItems: readonly ItemSnapshot[];
  } {
    const baseItems = this.Snapshot();
    const grant = grants[0]!;
    const current = this.items.find((value) => value.configId === grant.configId);
    const next = current
      ? { ...current, count: current.count + grant.count, version: current.version + 1 }
      : item(9100n + BigInt(grant.configId), grant.configId, grant.count);
    const nextItems = current
      ? this.items.map((value) => value.itemId === current.itemId ? next : { ...value })
      : [...this.items.map((value) => ({ ...value })), next];
    return { baseItems, nextItems, affectedItems: [next] };
  }

  CommitGrantPlan(plan: { nextItems: readonly ItemSnapshot[]; affectedItems: readonly ItemSnapshot[] }): readonly ItemSnapshot[] {
    this.items = plan.nextItems.map((value) => ({ ...value }));
    return plan.affectedItems.map((value) => ({ ...value }));
  }

  ApplyCommittedGrantItems(items: readonly ItemSnapshot[]): readonly ItemSnapshot[] {
    for (const expected of items) {
      const index = this.items.findIndex((value) => value.itemId === expected.itemId);
      if (index < 0) this.items.push({ ...expected });
      else this.items[index] = { ...expected };
    }
    return items.map((value) => ({ ...value }));
  }

  PlanConsumeItem(itemId: bigint, count: number): {
    baseItems: readonly ItemSnapshot[];
    nextItems: readonly ItemSnapshot[];
    consumedItem: ItemSnapshot;
  } {
    const current = this.GetItem(itemId);
    assert.ok(current);
    const consumedItem = { ...current, count: current.count - count, version: current.version + 1 };
    const nextItems = this.items
      .map((value) => value.itemId === itemId ? consumedItem : { ...value })
      .filter((value) => value.count > 0);
    return { baseItems: this.Snapshot(), nextItems, consumedItem };
  }

  CommitConsumePlan(plan: { nextItems: readonly ItemSnapshot[]; consumedItem: ItemSnapshot }): ItemSnapshot {
    this.items = plan.nextItems.map((value) => ({ ...value }));
    return { ...plan.consumedItem };
  }

  ApplyCommittedConsumeItem(itemValue: ItemSnapshot): ItemSnapshot {
    const index = this.items.findIndex((value) => value.itemId === itemValue.itemId);
    if (itemValue.count === 0) this.items = this.items.filter((value) => value.itemId !== itemValue.itemId);
    else if (index < 0) this.items.push({ ...itemValue });
    else this.items[index] = { ...itemValue };
    return { ...itemValue };
  }
}

class FakePersistence {
  private readonly transactions = new Map<string, { revision: bigint; result: Uint8Array }>();
  private revision = 0n;

  IsTransactionUncertain(): boolean {
    return false;
  }

  LoadTransaction(_operationId: string): PlayerTransactionReceipt | undefined {
    return undefined;
  }

  Capture(_reason: string): PlayerSaveData {
    return {} as PlayerSaveData;
  }

  ApplyTransaction(
    operationId: string,
    _data: PlayerSaveData,
    result: Uint8Array,
  ): PlayerTransactionResult {
    const existing = this.transactions.get(operationId);
    if (existing) {
      return { disposition: "duplicate", revision: existing.revision, result: existing.result.slice() };
    }
    this.revision += 1n;
    this.transactions.set(operationId, { revision: this.revision, result: result.slice() });
    return { disposition: "applied", revision: this.revision, result: result.slice() };
  }
}

function testHotfixManifest() {
  return {
    formatVersion: 1 as const,
    bundleVersion: "npc-shop-self-test",
    modelFingerprint: "npc-shop-self-test",
    modelSourceHash: "npc-shop-self-test",
    protocolFingerprint: "npc-shop-self-test",
    stableCoreApiHash: "npc-shop-self-test",
    nativeSchemaHash: "npc-shop-self-test",
    hotfixHash: "npc-shop-self-test",
    buildMode: "demo" as const,
  };
}
