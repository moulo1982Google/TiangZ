import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  GameConfigRegistry,
  type ItemSnapshot,
  type PlayerTradeOfferState,
} from "#tiangz/model";
import {
  DecodePlayerTradeReceipt,
  EncodePlayerTradeReceipt,
  PlanPlayerTrade,
} from "../app/hotfix/mmorpg/trade/PlayerTradeTransaction";
import {
  InMemoryPlayerRepository,
  type PlayerSaveData,
} from "../app/model/mmorpg/persistence/PlayerRepository";
import { ProjectPlayerDomainData } from "../app/model/mmorpg/persistence/PlayerPersistenceCodec";

void main();

async function main(): Promise<void> {
  const manifest = readFileSync(path.resolve("game_config/generated/game-config.manifest.json"), "utf8");
  const data = readFileSync(path.resolve("game_config/generated/server.json"), "utf8");
  GameConfigRegistry.Install(manifest, data);

  const { InitializeGameSingletons } = await import("../app/core/runtime/Game");
  const { SingletonRegistry } = await import("../app/core/runtime/Singleton");
  InitializeGameSingletons(
    { fixedUpdateMs: 50, maxCatchUpSteps: 2 },
    { originServerId: 31, workerId: 1 },
  );

  const requesterItems = [item(11n, 1001, 5)];
  const targetItems = [item(21n, 1003, 2)];
  const requesterOffer = offer(10n, [{ itemId: 11n, itemConfigId: 1001, count: 2 }]);
  const targetOffer = offer(5n, [{ itemId: 21n, itemConfigId: 1003, count: 1 }]);
  const receipt = PlanPlayerTrade(
    "trade:9001",
    101n,
    100n,
    requesterItems,
    requesterOffer,
    202n,
    50n,
    targetItems,
    targetOffer,
  );

  assert.equal(receipt.requester.gold, 95n);
  assert.equal(receipt.target.gold, 55n);
  assert.equal(findCount(receipt.requester.nextItems, 1001), 3);
  assert.equal(findCount(receipt.requester.nextItems, 1003), 1);
  assert.equal(findCount(receipt.target.nextItems, 1001), 2);
  assert.equal(findCount(receipt.target.nextItems, 1003), 1);
  assert.notEqual(receipt.requester.nextItems.find((value) => value.configId === 1003)?.itemId, 21n);
  assert.notEqual(receipt.target.nextItems.find((value) => value.configId === 1001)?.itemId, 11n);
  assert.deepEqual(DecodePlayerTradeReceipt(EncodePlayerTradeReceipt(receipt)), receipt);

  const repository = new InMemoryPlayerRepository();
  repository.Save(saveData(101n, 100n, requesterItems, "before-trade"));
  repository.Save(saveData(202n, 50n, targetItems, "before-trade"));
  const resultBytes = EncodePlayerTradeReceipt(receipt);
  const write = {
    operationId: "player-trade:9001",
    records: [
      {
        domain: "wallet",
        data: ProjectPlayerDomainData(
          saveData(101n, receipt.requester.gold, receipt.requester.nextItems, "player-trade"),
          "wallet",
        ),
        expectedRevision: 1n,
      },
      {
        domain: "inventory",
        data: ProjectPlayerDomainData(
          saveData(101n, receipt.requester.gold, receipt.requester.nextItems, "player-trade"),
          "inventory",
        ),
        expectedRevision: 1n,
      },
      {
        domain: "wallet",
        data: ProjectPlayerDomainData(
          saveData(202n, receipt.target.gold, receipt.target.nextItems, "player-trade"),
          "wallet",
        ),
        expectedRevision: 1n,
      },
      {
        domain: "inventory",
        data: ProjectPlayerDomainData(
          saveData(202n, receipt.target.gold, receipt.target.nextItems, "player-trade"),
          "inventory",
        ),
        expectedRevision: 1n,
      },
    ],
    result: resultBytes,
  } as const;
  const applied = repository.ApplyMultiTransaction(write);
  assert.equal(applied.disposition, "applied");
  assert.deepEqual(applied.revisions, [
    { characterId: 101n, domain: "inventory", revision: 2n },
    { characterId: 101n, domain: "wallet", revision: 2n },
    { characterId: 202n, domain: "inventory", revision: 2n },
    { characterId: 202n, domain: "wallet", revision: 2n },
  ]);
  assert.equal(repository.GetDomain(101n, "wallet")?.gold, 95n);
  assert.equal(repository.GetDomain(202n, "wallet")?.gold, 55n);
  assert.equal(findCount(repository.GetDomain(101n, "inventory")?.items ?? [], 1003), 1);
  assert.equal(findCount(repository.GetDomain(202n, "inventory")?.items ?? [], 1001), 2);
  assert.equal(repository.Load(101n)?.revisions.progression, 1n);
  assert.equal(repository.Load(101n)?.revisions.runtime, 1n);

  // ACK丢失后的同operationId重试必须返回首次结果，不能重复转移金币或Item。
  // Retrying the same operation after a lost ACK must return the first result without moving currency or Items again.
  const duplicate = repository.ApplyMultiTransaction(write);
  assert.equal(duplicate.disposition, "duplicate");
  assert.deepEqual(duplicate.result, resultBytes);
  assert.deepEqual(
    repository.LoadMultiTransaction([
      { characterId: 202n, domain: "inventory" },
      { characterId: 202n, domain: "wallet" },
      { characterId: 101n, domain: "inventory" },
      { characterId: 101n, domain: "wallet" },
    ], write.operationId)?.result,
    resultBytes,
  );

  // 任一参与者revision冲突时，两条记录都必须保持原值，不能出现只写成功一边。
  // A revision conflict on either participant must preserve both records and never commit only one side.
  assert.throws(
    () => repository.ApplyMultiTransaction({
      operationId: "player-trade:9002",
      records: [
        {
          domain: "inventory",
          data: ProjectPlayerDomainData(saveData(101n, 1n, [], "invalid-half-trade"), "inventory"),
          expectedRevision: 2n,
        },
        {
          domain: "wallet",
          data: ProjectPlayerDomainData(saveData(101n, 1n, [], "invalid-half-trade"), "wallet"),
          expectedRevision: 2n,
        },
        {
          domain: "inventory",
          data: ProjectPlayerDomainData(saveData(202n, 1n, [], "invalid-half-trade"), "inventory"),
          expectedRevision: 1n,
        },
        {
          domain: "wallet",
          data: ProjectPlayerDomainData(saveData(202n, 1n, [], "invalid-half-trade"), "wallet"),
          expectedRevision: 1n,
        },
      ],
      result: new Uint8Array([9]),
    }),
    /revision conflict/,
  );
  assert.equal(repository.GetDomain(101n, "wallet")?.gold, 95n);
  assert.equal(repository.GetDomain(202n, "wallet")?.gold, 55n);

  await SingletonRegistry.DestroyAll();
  console.log("player trade self-test passed");
}

function offer(
  gold: bigint,
  items: PlayerTradeOfferState["items"],
): PlayerTradeOfferState {
  return { gold, items, confirmed: false };
}

function item(itemId: bigint, configId: number, count: number): ItemSnapshot {
  return { itemId, configId, count, quality: 0, level: 1, version: 1 };
}

function findCount(items: readonly ItemSnapshot[], configId: number): number {
  return items
    .filter((value) => value.configId === configId)
    .reduce((total, value) => total + value.count, 0);
}

function saveData(
  characterId: bigint,
  gold: bigint,
  items: readonly ItemSnapshot[],
  reason: string,
): PlayerSaveData {
  return {
    player: {
      account: `trade-${characterId}`,
      characterId,
      mapId: 100,
      mapInstanceId: 100n,
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      cellX: 0,
      cellZ: 0,
      speedCellsPerSecond: 4,
      facing: 0,
      alive: true,
      gold,
      numerics: [],
    },
    items: items.map((value) => ({ ...value })),
    buffs: [],
    skill: { globalCooldownEndAtMs: 0, cooldowns: [], itemCooldowns: [] },
    quests: { active: [], completedQuestConfigIds: [] },
    reason,
  };
}
