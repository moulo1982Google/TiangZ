import { ClientMessages } from "../client_sdk/typescript/Generated/Model/demo/protocol/messageDescriptors";
import type {
  G2C_AoiDelta,
  MapEntitySnapshot,
} from "../client_sdk/typescript/Generated/Model/demo/protocol/messages";
import {
  GateClient,
  MapClient,
} from "../client_sdk/typescript/Generated/Model/demo/protocol/clients";
import { LoginFlow } from "../client_sdk/typescript/Demo/LoginFlow";
import { CreateOperationId } from "../client_sdk/typescript/Core/Protocol/OperationId";
import "../client_sdk/typescript/Core/Net/BrowserWebSocketTransport";

const HOST = process.env.TIANGZ_LOGIN_HOST ?? "14.103.24.32";
const PORT = Number(process.env.TIANGZ_LOGIN_PORT ?? 17_000);
const MAP_ID = Number(process.env.TIANGZ_MAP_ID ?? 100);
const SHOP_NPC_CONFIG_ID = 9002;
const PASSIVE_MONSTER_CONFIG_ID = 1;

/**
 * 通过真实外网链路验证“进图背包”和“打开商店背包”来自同一个权威PlayerUnit。
 * 此探针会注册临时账号，但不会购买、出售或修改已有玩家数据。
 *
 * Verifies through the real WebSocket chain that map entry and shop opening
 * expose inventory from the same authoritative PlayerUnit. The probe registers
 * a temporary account but never buys, sells, or mutates an existing player.
 */
async function main(): Promise<void> {
  const account = `shop_probe_${Date.now()}`;
  const password = "shop_probe_password";
  const flow = new LoginFlow({ transport: "websocket", host: HOST, port: PORT });
  const updates = setInterval(() => flow.update(), 1);
  try {
    await flow.register(account, password);
    const result = await flow.enterGame(account, password, MAP_ID);
    const gate = result.gateSocket;
    const gateClient = new GateClient(gate);
    const entities = [...result.enterMap.entities];

    if (entities.length === 0) {
      const initial = gate.waitForMessage<G2C_AoiDelta>(ClientMessages.AoiDelta, {
        timeoutMs: 5_000,
      });
      await gateClient.mapSnapshotReady({ unitId: result.enterMap.unitId });
      entities.push(...(await initial).enters);
    }

    const shopNpc = entities.find((entity) =>
      entity.configId === SHOP_NPC_CONFIG_ID && entity.shopEnabled
    );
    if (!shopNpc) {
      throw new Error(`shop NPC ${SHOP_NPC_CONFIG_ID} was absent from the initial AOI snapshot`);
    }

    const mapClient = new MapClient(gate);
    const expectedItems = new Map(
      result.enterMap.items.map((item) => [item.itemId.toString(), item]),
    );
    const looted = await lootOneMonster(mapClient, entities, expectedItems);
    await moveNear(mapClient, shopNpc, 100);
    const opened = await mapClient.openNpcShop({ npcUnitId: shopNpc.unitId });
    const entryItems = normalizeItems([...expectedItems.values()]);
    const shopItems = normalizeItems(opened.inventory?.items ?? []);
    if (JSON.stringify(shopItems) !== JSON.stringify(entryItems)) {
      throw new Error(
        `shop inventory differs from entry inventory: entry=${JSON.stringify(entryItems)} shop=${JSON.stringify(shopItems)}`,
      );
    }
    if (shopItems.length === 0) {
      throw new Error("new player shop inventory is unexpectedly empty");
    }

    console.log("NPC shop WebSocket probe passed", {
      account,
      unitId: result.enterMap.unitId,
      npcUnitId: shopNpc.unitId,
      looted,
      inventory: shopItems,
    });
  } finally {
    clearInterval(updates);
    flow.close();
  }
}

/** 让新角色进入NPC交互距离；导航仅用于抵达，不参与商店断言。 / Moves the fresh player into interaction range; navigation is only setup for the shop assertion. */
async function moveNear(map: MapClient, target: MapEntitySnapshot, sequence: number): Promise<void> {
  await map.navigateTo({
    targetX: target.x,
    targetY: target.y,
    targetZ: target.z,
    sequence,
  });
  // Demo地图最远约50米；统一等待7秒覆盖从怪区返回商店的路径。
  // The demo map spans roughly 50 meters; seven seconds covers a return from a monster area to the shop.
  await new Promise((resolve) => setTimeout(resolve, 7_000));
}

/**
 * 真实击杀并拾取一只被动怪，再把事务回包合并进客户端期望投影。
 * Kills and loots one passive monster, then merges the committed receipt into
 * the client-side expected projection used by the shop assertion.
 */
async function lootOneMonster(
  map: MapClient,
  entities: readonly MapEntitySnapshot[],
  expected: Map<string, { itemId: bigint; configId: number; count: number }>,
): Promise<string[]> {
  const monsters = entities.filter((entity) =>
    entity.entityType === 2 &&
    entity.configId === PASSIVE_MONSTER_CONFIG_ID &&
    entity.alive
  );
  for (let index = 0; index < monsters.length; index += 1) {
    const monster = monsters[index]!;
    await moveNear(map, monster, 10 + index);
    let killed = false;
    for (let hit = 0; hit < 40 && !killed; hit += 1) {
      const attack = await map.attackMonster({ monsterId: monster.unitId });
      killed = attack.killed;
    }
    if (!killed) throw new Error(`probe failed to kill monster ${monster.unitId}`);

    const inspected = await map.inspectLootMonster({ monsterId: monster.unitId });
    if (inspected.drops.length === 0) continue;
    const receipt = await map.lootMonster({
      monsterId: monster.unitId,
      operationId: CreateOperationId("shop-probe-loot"),
      dropId: 0,
      lootAll: true,
    });
    for (const item of receipt.items) {
      if (item.count <= 0) expected.delete(item.itemId.toString());
      else expected.set(item.itemId.toString(), item);
    }
    return receipt.items.map((item) => `${item.configId}:${item.count}`);
  }
  throw new Error("all passive probe monsters rolled empty loot");
}

function normalizeItems(items: readonly { itemId: bigint; configId: number; count: number }[]): string[] {
  return items
    .filter((item) => item.count > 0)
    .map((item) => `${item.itemId}:${item.configId}:${item.count}`)
    .sort();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
