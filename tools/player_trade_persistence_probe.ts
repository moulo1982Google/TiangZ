import "../client_sdk/typescript/Core/Net/BrowserWebSocketTransport";
import { CreateOperationId } from "../client_sdk/typescript/Core/Protocol/OperationId";
import { LoginFlow } from "../client_sdk/typescript/Demo/LoginFlow";
import { ClientMessages } from "../client_sdk/typescript/Generated/Model/demo/protocol/messageDescriptors";
import type {
  G2C_AoiDelta,
  G2C_PlayerTradeClosed,
  ItemSnapshot,
  MapEntitySnapshot,
} from "../client_sdk/typescript/Generated/Model/demo/protocol/messages";
import {
  GateClient,
  MapClient,
} from "../client_sdk/typescript/Generated/Model/demo/protocol/clients";

const HOST = process.env.TIANGZ_LOGIN_HOST ?? "127.0.0.1";
const PORT = Number(process.env.TIANGZ_LOGIN_PORT ?? 7_000);
const ACCOUNT_A = requireEnvironment("TIANGZ_TRADE_ACCOUNT_A");
const ACCOUNT_B = requireEnvironment("TIANGZ_TRADE_ACCOUNT_B");
const PASSWORD = process.env.TIANGZ_TRADE_PASSWORD ?? "trade_persistence_password";
const MODE = process.argv[2] ?? "commit";
const MAP_ID = 100;
const SHOP_NPC_CONFIG_ID = 9002;
const SMALL_HEALTH_POTION = 1001;
const SMALL_MANA_POTION = 1003;
const READY_MARKER = "PLAYER_TRADE_READY_FOR_COMMIT";

interface ConnectedPlayer {
  readonly flow: LoginFlow;
  readonly gate: ReturnType<LoginFlow["enterGame"]> extends Promise<infer TResult>
    ? TResult["gateSocket"]
    : never;
  readonly map: MapClient;
  readonly unitId: number;
  readonly gold: bigint;
  readonly items: readonly ItemSnapshot[];
  readonly entities: readonly MapEntitySnapshot[];
}

async function main(): Promise<void> {
  if (MODE === "commit") {
    await commitTrade();
    return;
  }
  if (MODE === "verify") {
    await verifyPersistedTrade();
    return;
  }
  throw new Error(`unknown player trade persistence probe mode: ${MODE}`);
}

/**
 * 使用正式商店事务制造铜币，再通过双记录事务交换铜币和两种药品。
 * Uses the real shop transaction to create currency, then exchanges currency
 * and two potion types through one durable two-record player trade.
 */
async function commitTrade(): Promise<void> {
  const flowA = createFlow();
  const flowB = createFlow();
  const updates = startUpdates(flowA, flowB);
  try {
    const [registeredA, registeredB] = await Promise.all([
      flowA.register(ACCOUNT_A, PASSWORD),
      flowB.register(ACCOUNT_B, PASSWORD),
    ]);
    if (!registeredA.character || !registeredB.character) {
      throw new Error("persistent trade registration did not create both characters");
    }
    const playerA = await connect(
      flowA,
      ACCOUNT_A,
      registeredA.character.characterId,
    );
    const playerB = await connect(
      flowB,
      ACCOUNT_B,
      registeredB.character.characterId,
    );
    const shopNpc = playerA.entities.find((entity) => (
      entity.configId === SHOP_NPC_CONFIG_ID && entity.shopEnabled
    ));
    if (!shopNpc) throw new Error(`shop NPC ${SHOP_NPC_CONFIG_ID} is absent from the AOI snapshot`);

    await Promise.all([
      playerA.map.navigateTo(destination(shopNpc, 1)),
      playerB.map.navigateTo(destination(shopNpc, 1)),
    ]);
    await sleep(7_000);

    const inventoryA = inventoryMap(playerA.items);
    const inventoryB = inventoryMap(playerB.items);
    const redA = requireItem(inventoryA, SMALL_HEALTH_POTION);
    const sold = await playerA.map.sellItem({
      npcUnitId: shopNpc.unitId,
      itemId: redA.itemId,
      count: 1,
      operationId: CreateOperationId("trade-persistence-sell"),
    });
    applyItem(inventoryA, sold.item);
    if (sold.gold !== 20n) throw new Error(`selling one small health potion yielded ${sold.gold}, expected 20`);

    const requested = await playerA.map.requestPlayerTrade({ targetUnitId: playerB.unitId });
    const accepted = await playerB.map.respondPlayerTrade({
      tradeId: requested.trade.tradeId,
      accept: true,
    });
    if (accepted.trade.phase !== 2) throw new Error("persistent trade did not enter the open phase");

    const offeredRed = requireItem(inventoryA, SMALL_HEALTH_POTION);
    const offeredMana = requireItem(inventoryB, SMALL_MANA_POTION);
    await playerA.map.updatePlayerTradeOffer({
      tradeId: requested.trade.tradeId,
      gold: 10n,
      items: [{ itemId: offeredRed.itemId, itemConfigId: offeredRed.configId, count: 1 }],
    });
    await playerB.map.updatePlayerTradeOffer({
      tradeId: requested.trade.tradeId,
      gold: 0n,
      items: [{ itemId: offeredMana.itemId, itemConfigId: offeredMana.configId, count: 1 }],
    });
    const firstConfirmation = await playerA.map.confirmPlayerTrade({ tradeId: requested.trade.tradeId });
    if (firstConfirmation.committed) throw new Error("first player confirmation committed before the other player confirmed");

    if (process.env.TIANGZ_TRADE_PAUSE_BEFORE_COMMIT === "1") {
      console.log(READY_MARKER);
      await waitForParentContinue();
    }

    const closeA = playerA.gate.waitForMessage<G2C_PlayerTradeClosed>(
      ClientMessages.PlayerTradeClosed,
      { timeoutMs: 20_000 },
    );
    const closeB = playerB.gate.waitForMessage<G2C_PlayerTradeClosed>(
      ClientMessages.PlayerTradeClosed,
      { timeoutMs: 20_000 },
    );
    const secondConfirmation = await playerB.map.confirmPlayerTrade(
      { tradeId: requested.trade.tradeId },
      { timeoutMs: 20_000 },
    );
    const [committedA, committedB] = await Promise.all([closeA, closeB]);
    if (!secondConfirmation.committed || !committedA.committed || !committedB.committed) {
      throw new Error("second player confirmation did not durably commit the trade");
    }
    assertExpected(ACCOUNT_A, committedA.gold, committedA.inventory.items, expectedA());
    assertExpected(ACCOUNT_B, committedB.gold, committedB.inventory.items, expectedB());
    console.log("Player trade durable commit passed", {
      accountA: ACCOUNT_A,
      accountB: ACCOUNT_B,
      tradeId: requested.trade.tradeId,
    });
  } finally {
    clearInterval(updates);
    flowA.close();
    flowB.close();
  }
}

/** 重登只读取权威快照，不依赖交易关闭Push留下的客户端状态。 / Relogin reads only authoritative snapshots and never relies on the previous close push. */
async function verifyPersistedTrade(): Promise<void> {
  const flowA = createFlow();
  const flowB = createFlow();
  const updates = startUpdates(flowA, flowB);
  try {
    const playerA = await connect(flowA, ACCOUNT_A);
    const playerB = await connect(flowB, ACCOUNT_B);
    assertExpected(ACCOUNT_A, playerA.gold, playerA.items, expectedA());
    assertExpected(ACCOUNT_B, playerB.gold, playerB.items, expectedB());
    console.log("Player trade restart recovery passed", {
      accountA: ACCOUNT_A,
      accountB: ACCOUNT_B,
    });
  } finally {
    clearInterval(updates);
    flowA.close();
    flowB.close();
  }
}

async function connect(flow: LoginFlow, account: string, characterId?: bigint): Promise<ConnectedPlayer> {
  const result = await flow.enterGame(account, PASSWORD, MAP_ID, undefined, characterId);
  // 探针只断言交易与快照，但仍消费地图的其他合法Push，避免把表现层未注册误报为业务失败。
  // The probe asserts only trade and snapshots while consuming unrelated valid map pushes to keep diagnostics focused.
  for (const descriptor of Object.values(ClientMessages)) {
    result.gateSocket.on(descriptor, () => {});
  }
  const entities = [...result.enterMap.entities];
  const initial = entities.length === 0
    ? result.gateSocket.waitForMessage<G2C_AoiDelta>(ClientMessages.AoiDelta, { timeoutMs: 5_000 })
    : undefined;
  await new GateClient(result.gateSocket).mapSnapshotReady({ unitId: result.enterMap.unitId });
  if (initial) entities.push(...(await initial).enters);
  return {
    flow,
    gate: result.gateSocket,
    map: new MapClient(result.gateSocket),
    unitId: result.enterMap.unitId,
    gold: result.enterMap.gold,
    items: result.enterMap.items,
    entities,
  };
}

function expectedA(): ExpectedSnapshot {
  return { gold: 10n, counts: new Map([[SMALL_HEALTH_POTION, 1], [SMALL_MANA_POTION, 4]]) };
}

function expectedB(): ExpectedSnapshot {
  return { gold: 10n, counts: new Map([[SMALL_HEALTH_POTION, 4], [SMALL_MANA_POTION, 2]]) };
}

interface ExpectedSnapshot {
  readonly gold: bigint;
  readonly counts: ReadonlyMap<number, number>;
}

function assertExpected(
  account: string,
  gold: bigint,
  items: readonly ItemSnapshot[],
  expected: ExpectedSnapshot,
): void {
  if (gold !== expected.gold) throw new Error(`${account} gold=${gold}, expected=${expected.gold}`);
  const actual = aggregateItems(items);
  for (const [configId, count] of expected.counts) {
    if ((actual.get(configId) ?? 0) !== count) {
      throw new Error(`${account} item ${configId} count=${actual.get(configId) ?? 0}, expected=${count}`);
    }
  }
  const unexpected = [...actual].filter(([configId, count]) => count > 0 && !expected.counts.has(configId));
  if (unexpected.length > 0) {
    throw new Error(`${account} has unexpected inventory entries: ${JSON.stringify(unexpected)}`);
  }
}

function aggregateItems(items: readonly ItemSnapshot[]): Map<number, number> {
  const result = new Map<number, number>();
  for (const item of items) {
    if (item.count <= 0) continue;
    result.set(item.configId, (result.get(item.configId) ?? 0) + item.count);
  }
  return result;
}

function inventoryMap(items: readonly ItemSnapshot[]): Map<string, ItemSnapshot> {
  return new Map(items.map((item) => [item.itemId.toString(), { ...item }]));
}

function requireItem(items: ReadonlyMap<string, ItemSnapshot>, configId: number): ItemSnapshot {
  const item = [...items.values()].find((candidate) => candidate.configId === configId && candidate.count > 0);
  if (!item) throw new Error(`inventory does not contain item config ${configId}`);
  return item;
}

function applyItem(items: Map<string, ItemSnapshot>, item: ItemSnapshot): void {
  if (item.count <= 0) items.delete(item.itemId.toString());
  else items.set(item.itemId.toString(), { ...item });
}

function destination(entity: MapEntitySnapshot, sequence: number) {
  return {
    targetX: entity.x,
    targetY: entity.y,
    targetZ: entity.z,
    sequence,
  };
}

function createFlow(): LoginFlow {
  return new LoginFlow({ transport: "websocket", host: HOST, port: PORT });
}

function startUpdates(...flows: readonly LoginFlow[]): ReturnType<typeof setInterval> {
  return setInterval(() => {
    for (const flow of flows) flow.update();
  }, 1);
}

function waitForParentContinue(): Promise<void> {
  process.stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
    process.stdin.once("error", reject);
  });
}

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
