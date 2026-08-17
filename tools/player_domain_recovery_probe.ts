import { readFileSync, writeFileSync } from "node:fs";

import "../client_sdk/typescript/Core/Net/BrowserWebSocketTransport";
import { LoginFlow } from "../client_sdk/typescript/Demo/LoginFlow";
import { ClientMessages } from "../client_sdk/typescript/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_AoiDelta } from "../client_sdk/typescript/Generated/Model/demo/protocol/messages";
import { GateClient, MapClient } from "../client_sdk/typescript/Generated/Model/demo/protocol/clients";

const HOST = process.env.TIANGZ_LOGIN_HOST ?? "127.0.0.1";
const PORT = Number(process.env.TIANGZ_LOGIN_PORT ?? 7_000);
const ACCOUNT = requireEnvironment("TIANGZ_RECOVERY_ACCOUNT");
const STATE_FILE = requireEnvironment("TIANGZ_RECOVERY_STATE_FILE");
const PASSWORD = process.env.TIANGZ_RECOVERY_PASSWORD ?? "player_recovery_password";
const MODE = process.argv[2] ?? "mutate";
const MAP_ID = 100;
const QUEST_NPC_CONFIG_ID = 9001;
const QUEST_CONFIG_ID = 5001;
const SMALL_HEALTH_POTION = 1001;
const SMALL_MANA_POTION = 1003;
const TARGET = { x: 5, y: 1, z: -12 };
const READY_MARKER = "PLAYER_DOMAIN_RECOVERY_MUTATED";

interface RecoveryExpectation {
  readonly account: string;
  readonly questConfigId: number;
  readonly x: number;
  readonly z: number;
  readonly gold: string;
  readonly itemCounts: Readonly<Record<string, number>>;
}

async function main(): Promise<void> {
  if (MODE === "mutate") {
    await mutateAndHold();
    return;
  }
  if (MODE === "verify") {
    await verifyRecoveredDomains();
    return;
  }
  throw new Error(`unknown player domain recovery probe mode: ${MODE}`);
}

/**
 * 注册玩家、接任务并移动，然后保持连接，确保父验收器可以选择优雅停机或直接强杀。
 * Registers a player, accepts a quest, moves, and holds the connection so the
 * parent acceptance test can choose either graceful shutdown or a hard kill.
 */
async function mutateAndHold(): Promise<void> {
  const flow = createFlow();
  const updates = setInterval(() => flow.update(), 1);
  try {
    const registered = await flow.register(ACCOUNT, PASSWORD);
    if (!registered.character) throw new Error("recovery registration did not create a character");
    const connected = await connect(flow, registered.character.characterId);
    const questNpc = connected.entities.find((entity) => entity.configId === QUEST_NPC_CONFIG_ID);
    if (!questNpc) throw new Error(`quest NPC ${QUEST_NPC_CONFIG_ID} is absent from the AOI snapshot`);
    const accepted = await connected.map.acceptQuest({
      questConfigId: QUEST_CONFIG_ID,
      npcUnitId: questNpc.unitId,
    });
    if (accepted.quest.questConfigId !== QUEST_CONFIG_ID) {
      throw new Error(`accepted quest ${accepted.quest.questConfigId}, expected ${QUEST_CONFIG_ID}`);
    }

    const navigation = await connected.map.navigateTo({
      targetX: TARGET.x,
      targetY: TARGET.y,
      targetZ: TARGET.z,
      sequence: 1,
    });
    const destination = navigation.points.at(-1);
    if (!destination) throw new Error("recovery navigation returned no path");
    await sleep(navigationWaitMs(connected.enterX, connected.enterY, connected.enterZ, navigation.points));

    const expectation: RecoveryExpectation = {
      account: ACCOUNT,
      questConfigId: QUEST_CONFIG_ID,
      x: destination.x,
      z: destination.z,
      gold: connected.gold.toString(),
      itemCounts: Object.fromEntries(aggregateItems(connected.items)),
    };
    writeFileSync(STATE_FILE, `${JSON.stringify(expectation, null, 2)}\n`, "utf8");
    console.log(READY_MARKER);
    await waitForParentContinue();
  } finally {
    clearInterval(updates);
    flow.close();
  }
}

/** 从全新连接读取权威快照，分别验证wallet、inventory、quest和runtime。 / Reads a fresh authoritative snapshot and verifies wallet, inventory, quest, and runtime independently. */
async function verifyRecoveredDomains(): Promise<void> {
  const expected = JSON.parse(readFileSync(STATE_FILE, "utf8")) as RecoveryExpectation;
  if (expected.account !== ACCOUNT) throw new Error(`recovery state belongs to ${expected.account}, not ${ACCOUNT}`);
  const flow = createFlow();
  const updates = setInterval(() => flow.update(), 1);
  try {
    const connected = await connect(flow);
    if (!connected.quests.includes(expected.questConfigId)) {
      throw new Error(`progression recovery lost quest ${expected.questConfigId}: ${JSON.stringify(connected.quests)}`);
    }
    const distance = Math.hypot(connected.enterX - expected.x, connected.enterZ - expected.z);
    if (distance > 1.25) {
      throw new Error(`runtime recovery position drifted ${distance.toFixed(2)}m: actual=${connected.enterX},${connected.enterZ} expected=${expected.x},${expected.z}`);
    }
    if (connected.gold.toString() !== expected.gold) {
      throw new Error(`wallet recovery gold=${connected.gold}, expected=${expected.gold}`);
    }
    const actualItems = Object.fromEntries(aggregateItems(connected.items));
    if (JSON.stringify(actualItems) !== JSON.stringify(expected.itemCounts)) {
      throw new Error(`inventory recovery items=${JSON.stringify(actualItems)}, expected=${JSON.stringify(expected.itemCounts)}`);
    }
    console.log("Player domain recovery passed", {
      account: ACCOUNT,
      position: [connected.enterX, connected.enterZ],
      questConfigId: expected.questConfigId,
      itemCounts: actualItems,
    });
  } finally {
    clearInterval(updates);
    flow.close();
  }
}

async function connect(flow: LoginFlow, characterId?: bigint) {
  const result = await flow.enterGame(ACCOUNT, PASSWORD, MAP_ID, undefined, characterId);
  for (const descriptor of Object.values(ClientMessages)) result.gateSocket.on(descriptor, () => {});
  const entities = [...result.enterMap.entities];
  const initial = entities.length === 0
    ? result.gateSocket.waitForMessage<G2C_AoiDelta>(ClientMessages.AoiDelta, { timeoutMs: 5_000 })
    : undefined;
  await new GateClient(result.gateSocket).mapSnapshotReady({ unitId: result.enterMap.unitId });
  if (initial) entities.push(...(await initial).enters);
  return {
    map: new MapClient(result.gateSocket),
    entities,
    enterX: result.enterMap.x,
    enterY: result.enterMap.y,
    enterZ: result.enterMap.z,
    quests: result.enterMap.quests.map((quest) => quest.questConfigId),
    gold: result.enterMap.gold,
    items: result.enterMap.items,
  };
}

function aggregateItems(items: readonly { configId: number; count: number }[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const item of items) {
    if (item.count <= 0) continue;
    const key = String(item.configId);
    result.set(key, (result.get(key) ?? 0) + item.count);
  }
  for (const required of [SMALL_HEALTH_POTION, SMALL_MANA_POTION]) {
    if ((result.get(String(required)) ?? 0) <= 0) throw new Error(`initial inventory is missing item ${required}`);
  }
  return new Map([...result].sort(([left], [right]) => Number(left) - Number(right)));
}

function navigationWaitMs(startX: number, startY: number, startZ: number, points: readonly { x: number; y: number; z: number }[]): number {
  let distance = 0;
  let previous = { x: startX, y: startY, z: startZ };
  for (const point of points) {
    distance += Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z);
    previous = point;
  }
  return Math.max(1_500, Math.ceil(distance / 10 * 1_000) + 1_000);
}

function createFlow(): LoginFlow {
  return new LoginFlow({ transport: "websocket", host: HOST, port: PORT });
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
