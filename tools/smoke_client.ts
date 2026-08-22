import net from "node:net";
import {
  buildEnterMapPacket,
  buildEnterStarterDungeonPacket,
  buildAttackMonsterPacket,
  buildToggleAutoAttackPacket,
  buildCastSkillPacket,
  buildFindPathPacket,
  buildNavigateToPacket,
  buildNavigateInputPacket,
  buildToggleDemoDoorPacket,
  buildGetLoginServiceAddrPacket,
  buildLoginGatePacket,
  buildLoginPacket,
  buildRegisterPacket,
  buildMapSnapshotReadyPacket,
  buildMovePacket,
  buildUseItemPacket,
  buildInspectLootMonsterPacket,
  buildLootMonsterPacket,
  buildAcceptQuestPacket,
  buildCompleteQuestPacket,
  decodeAoiDeltaFrame,
  decodeAttackMonsterFrame,
  decodeAutoAttackStateFrame,
  decodeEntityMoveFrame,
  decodeEntityNavigateFrame,
  decodeEntityStateFrame,
  decodeEnterMapFrame,
  decodeEnterStarterDungeonFrame,
  decodeFindPathFrame,
  decodeNavigateToFrame,
  decodeNavigateInputFrame,
  decodeToggleDemoDoorFrame,
  decodeEntityNumericFrame,
  decodeItemChangedFrame,
  decodeUseItemFrame,
  decodeInspectLootMonsterFrame,
  decodeLootMonsterFrame,
  decodeAcceptQuestFrame,
  decodeCompleteQuestFrame,
  decodeGetLoginServiceAddrFrame,
  decodeLoginGateFrame,
  decodeLoginFrame,
  decodeRegisterFrame,
  decodeMapReadyFrame,
  decodeMapSnapshotReadyFrame,
  decodeToggleAutoAttackFrame,
  decodeCastSkillFrame,
  decodeCombatResultFrame,
  decodeSkillCastStateFrame,
  decodeSkillImpactFrame,
  decodeSkillProjectileFrame,
  decodePingFrame,
  decodeProgressionChangedFrame,
  buildPingPacket,
} from "./support/DemoClientProtocol";
import { BinaryReader, readU16BE } from "../app/core/protocol/binary";
import { LengthPrefixedFrameDecoder } from "../app/core/protocol/frame";
import { MsgCode } from "../client_sdk/typescript/Generated/Model/demo/protocol/msgcodes";
import type {
  CellMovementState,
  MapEntitySnapshot,
  QuestSnapshot,
} from "../client_sdk/typescript/Generated/Model/demo/protocol/messages";
import { GameConfigs, QuestStatus, SpatialMode } from "../client_sdk/typescript/Generated/Config";
import { GameErrCode } from "../app/model/game/protocol/GameErrCode";
import { NumericType } from "../app/model/mmorpg/numeric/NumericType";
import { encodePacket } from "../app/core/public";
import {
  M2S_CreateDynamicMapCodec,
  M2S_DisposeDynamicMapCodec,
  S2M_CreateDynamicMapCodec,
  S2M_DisposeDynamicMapCodec,
  type MapInstanceSnapshot,
} from "../app/generated/model/server/demo/protocol/messages";
import { G2C_SessionReplacedCodec } from "../app/generated/model/server/demo/protocol/messages";
import { MsgCode as ServerMsgCode } from "../app/generated/model/server/demo/protocol/msgcodes";

type TimedMovementState = CellMovementState & { serverTick: number };

async function main() {
  if (process.argv.includes("--dynamic-map-single-host-only")) {
    const managerPort = positiveIntegerArgument("--map-manager-port", 7100);
    // Ready只覆盖进程启动；MapHost注册由异步续租完成。 / Ready only covers process startup; MapHost registration is renewed asynchronously.
    await sleep(5_500);
    await verifySingleHostDynamicMapLifecycle(managerPort);
    return;
  }
  const loginAddr = await requestLoginServiceAddr("127.0.0.1", 7000);
  console.log("LoginMgr selected:", loginAddr);
  // Process Ready不代表跨进程MapHost注册已经完成；等待一个5秒续租周期覆盖并发启动顺序。
  // Process Ready does not imply cross-process MapHost registration; wait one renewal cycle.
  await sleep(5_500);
  const persistenceWriteAccount = namedArgument("--dbproxy-persistence-write");
  if (persistenceWriteAccount) {
    await writeDbProxyPersistenceFixture(loginAddr, persistenceWriteAccount);
    return;
  }
  const persistenceReadAccount = namedArgument("--dbproxy-persistence-read");
  if (persistenceReadAccount) {
    await verifyDbProxyPersistenceFixture(loginAddr, persistenceReadAccount);
    return;
  }
  const questRewardAccount = namedArgument("--dbproxy-quest-reward");
  if (questRewardAccount) {
    await verifyDbProxyQuestReward(loginAddr, questRewardAccount);
    return;
  }
  const questRewardReadAccount = namedArgument("--dbproxy-quest-reward-read");
  if (questRewardReadAccount) {
    await verifyDbProxyQuestRewardRecovery(loginAddr, questRewardReadAccount);
    return;
  }
  const itemUseAccount = namedArgument("--dbproxy-item-use");
  if (itemUseAccount) {
    await verifyDbProxyItemUse(loginAddr, itemUseAccount);
    return;
  }
  const itemUseReadAccount = namedArgument("--dbproxy-item-use-read");
  if (itemUseReadAccount) {
    await verifyDbProxyItemUseRecovery(loginAddr, itemUseReadAccount);
    return;
  }
  const starterBossWriteAccount = namedArgument("--dbproxy-starter-boss-write");
  if (starterBossWriteAccount) {
    await verifyStarterDungeonBossProgression(loginAddr, starterBossWriteAccount);
    return;
  }
  const starterBossReadAccount = namedArgument("--dbproxy-starter-boss-read");
  if (starterBossReadAccount) {
    await verifyStarterBossProgressionRecovery(loginAddr, starterBossReadAccount);
    return;
  }
  if (process.argv.includes("--map100-initial-only") || process.argv.includes("--skill-only")) {
    const login = await requestLogin(loginAddr.ip, loginAddr.port, `smoke_map100_${Date.now()}`);
    const client = await openGateAndEnterMap(
      login.gateIp,
      login.gatePort,
      { account: login.account, token: login.token, mapId: 100 },
    );
    try {
      const monsters = client.enterMap.entities.filter((entity) => entity.entityType === 2);
      console.log("Map100 initial snapshot:", {
        unitId: client.enterMap.unitId,
        entityCount: client.enterMap.entities.length,
        monsters: monsters.map((entity) => ({ unitId: entity.unitId, configId: entity.configId })),
      });
      if (monsters.length !== 5) {
        throw new Error(`Map100 initial snapshot expected 5 monsters, got ${monsters.length}`);
      }
      if (process.argv.includes("--skill-only")) {
        await verifyFiveSkillMechanics(client.gate, client.enterMap);
      }
    } finally {
      await client.gate.close();
    }
    return;
  }
  if (process.argv.includes("--starter-dungeon-only")) {
    await verifyStarterDungeonBossProgression(loginAddr);
    return;
  }
  if (process.argv.includes("--starter-quest-chain-only")) {
    await verifyStarterQuestChain(loginAddr);
    return;
  }
  const dynamicMap = await verifyDynamicMapLifecycle();
  if (process.argv.includes("--gate-timeout-only")) {
    await verifyGateFinalTimeout(loginAddr.ip, loginAddr.port);
    return;
  }

  const [login1, login2] = await Promise.all([
    requestLogin(loginAddr.ip, loginAddr.port, "smoke_user"),
    requestLogin(loginAddr.ip, loginAddr.port, "smoke_user"),
  ]);
  const counts = [login1.loginCount, login2.loginCount].sort((a, b) => a - b);
  if (counts[0] !== 1 || counts[1] !== 2) {
    throw new Error(`expected actor login counts 1,2; got ${counts.join(",")}`);
  }
  console.log("Login responses:", login1, login2);

  const enterMap = await verifyGateSessionLifecycle(
    login1.gateIp,
    login1.gatePort,
    {
      account: login1.account,
      token: login1.token,
      mapId: 1,
    },
    dynamicMap,
  );
  console.log("EnterMap response:", enterMap);

  const [mover, peer] = await Promise.all([
    requestLogin(loginAddr.ip, loginAddr.port, "smoke_mover"),
    requestLogin(loginAddr.ip, loginAddr.port, "smoke_peer"),
  ]);
  await verifySharedMapBroadcast(
    mover.gateIp,
    mover.gatePort,
    { account: mover.account, token: mover.token, mapId: 1 },
    { account: peer.account, token: peer.token, mapId: 1 },
  );
}

/**
 * 走真实Gate创建、动态Map传送、NavMesh接近、Boss击杀和progression事务回执。
 * Uses the real Gate creation, dynamic-map transfer, NavMesh approach, Boss
 * kill, and durable progression receipt instead of directly calling systems.
 */
async function verifyStarterDungeonBossProgression(
  loginAddr: { ip: string; port: number },
  account = `starter_boss_${Date.now()}`,
): Promise<void> {
  const login = await requestLogin(loginAddr.ip, loginAddr.port, account);
  const client = await openGateAndEnterMap(
    login.gateIp,
    login.gatePort,
    { account: login.account, token: login.token, mapId: 100 },
  );
  try {
    const mapReadyFrame = client.gate.waitForMessage(MsgCode.G2C_MapReady, 10_000);
    const entered = decodeEnterStarterDungeonFrame(await client.gate.request(
      buildEnterStarterDungeonPacket(nextRpcId++, {
        operationId: nextOperationId("starter-dungeon"),
      }),
    )).body;
    const mapReady = decodeMapReadyFrame(await mapReadyFrame).body;
    if (entered.error || entered.enterMap.mapId !== 200 || mapReady.mapId !== 200 ||
      mapReady.unitId !== entered.enterMap.unitId || entered.enterMap.mapInstanceId <= 0n) {
      throw new Error(`Starter dungeon entry failed: ${stringifyForError({ entered, mapReady })}`);
    }

    let entities = entered.enterMap.entities;
    const snapshotFrame = entities.length === 0
      ? client.gate.waitForMessage(MsgCode.G2C_AoiDelta, 10_000)
      : undefined;
    const snapshotReady = decodeMapSnapshotReadyFrame(await client.gate.request(
      buildMapSnapshotReadyPacket(nextRpcId++, { unitId: entered.enterMap.unitId }),
    )).body;
    if (snapshotReady.error) throw new Error(`Starter dungeon snapshot failed: ${stringifyForError(snapshotReady)}`);
    if (snapshotFrame) entities = decodeAoiDeltaFrame(await snapshotFrame).body.enters;
    const boss = entities.find((entity) => entity.entityType === 2 && entity.configId === 3 && entity.alive);
    if (!boss) throw new Error(`Starter dungeon Boss is missing: ${stringifyForError(entities)}`);

    const approach = pointNearTarget(entered.enterMap.x, entered.enterMap.z, boss.x, boss.z, 2);
    const navigate = decodeNavigateToFrame(await client.gate.request(buildNavigateToPacket(
      nextRpcId++,
      { targetX: approach.x, targetY: boss.y, targetZ: approach.z, sequence: 1 },
    ))).body;
    if (navigate.error || navigate.points.length === 0) {
      throw new Error(`Starter dungeon navigation failed: ${stringifyForError(navigate)}`);
    }
    await sleep(3_500);

    const progressionFrame = client.gate.waitForMessage(MsgCode.G2C_ProgressionChanged, 10_000);
    let killed = false;
    let attacks = 0;
    while (!killed && attacks < 100) {
      const attacked = decodeAttackMonsterFrame(await client.gate.request(
        buildAttackMonsterPacket(nextRpcId++, { monsterId: boss.unitId }),
      )).body;
      if (attacked.error) throw new Error(`Starter Boss attack failed: ${stringifyForError(attacked)}`);
      killed = attacked.killed;
      attacks += 1;
    }
    if (!killed) throw new Error(`Starter Boss survived ${attacks} attacks`);
    const progression = decodeProgressionChangedFrame(await progressionFrame).body;
    if (progression.level !== 2n || progression.experience !== 120n ||
      progression.gainedExperience !== 120n || !progression.leveledUp) {
      throw new Error(`Starter Boss progression mismatch: ${stringifyForError(progression)}`);
    }

    const inspected = decodeInspectLootMonsterFrame(await client.gate.request(
      buildInspectLootMonsterPacket(nextRpcId++, { monsterId: boss.unitId }),
    )).body;
    const itemDrops = inspected.drops
      .filter((drop) => drop.itemConfigId > 0)
      .map((drop) => [drop.itemConfigId, drop.count] as const)
      .sort(([left], [right]) => left - right);
    const currencyDrops = inspected.drops.filter((drop) => drop.gold > 0n);
    if (
      inspected.error ||
      JSON.stringify(itemDrops) !== JSON.stringify([[1001, 5], [1002, 5], [1003, 5]]) ||
      currencyDrops.length !== 1 || currencyDrops[0].gold !== 150n
    ) {
      throw new Error(`Starter Boss loot preview mismatch: ${stringifyForError(inspected)}`);
    }
    const looted = decodeLootMonsterFrame(await client.gate.request(buildLootMonsterPacket(
      nextRpcId++,
      {
        monsterId: boss.unitId,
        operationId: nextOperationId("starter-boss-loot"),
        dropId: 0,
        lootAll: true,
      },
    ))).body;
    const lootedItems = new Map(looted.items.map((item) => [item.configId, item.count]));
    if (
      looted.error || looted.gainedGold !== 150n || looted.gold !== 150n ||
      looted.remainingDrops.length !== 0 ||
      lootedItems.get(1001) !== 8 || lootedItems.get(1002) !== 5 || lootedItems.get(1003) !== 8
    ) {
      throw new Error(`Starter Boss loot commit mismatch: ${stringifyForError(looted)}`);
    }

    const returnReadyFrame = client.gate.waitForMessage(MsgCode.G2C_MapReady, 10_000);
    const returned = decodeEnterMapFrame(await client.gate.request(buildEnterMapPacket(
      nextRpcId++,
      { mapId: 100, mapInstanceId: 100n },
    ))).body;
    const returnReady = decodeMapReadyFrame(await returnReadyFrame).body;
    if (returned.error || returned.mapId !== 100 || returnReady.mapId !== 100) {
      throw new Error(`Starter dungeon return failed: ${stringifyForError({ returned, returnReady })}`);
    }
    const blocked = decodeEnterStarterDungeonFrame(await client.gate.request(
      buildEnterStarterDungeonPacket(nextRpcId++, {
        operationId: nextOperationId("starter-dungeon-cooldown"),
      }),
    )).body;
    if (blocked.error !== 10058) {
      throw new Error(`Starter dungeon cooldown was not enforced: ${stringifyForError(blocked)}`);
    }
    if (
      entered.cooldownEndAtMs !== entered.enterMap.starterDungeonCooldownEndAtMs ||
      entered.cooldownEndAtMs <= BigInt(Date.now() + 9 * 60 * 1_000)
    ) {
      throw new Error(`Starter dungeon cooldown snapshot mismatch: ${stringifyForError(entered)}`);
    }
    console.log("Starter dungeon Boss progression:", {
      mapInstanceId: entered.enterMap.mapInstanceId.toString(),
      bossUnitId: boss.unitId,
      attacks,
      level: progression.level.toString(),
      experience: progression.experience.toString(),
      gold: looted.gold.toString(),
      cooldownEndAtMs: entered.cooldownEndAtMs.toString(),
    });
  } finally {
    await client.gate.close();
  }
}

interface StarterQuestNavigationState {
  x: number;
  y: number;
  z: number;
  sequence: number;
}

/**
 * 通过正式NPC、战斗、尸体拾取和奖励事务跑完Starter三段任务链。
 * Runs the three-part Starter quest chain through the public NPC, combat,
 * corpse-loot, and reward transaction protocols.
 *
 * 禁止用法 / Forbidden: never shorten objective counts or mutate QuestComponent from this fixture.
 */
async function verifyStarterQuestChain(
  loginAddr: { ip: string; port: number },
  account = `starter_quest_${Date.now()}`,
): Promise<void> {
  const login = await requestLogin(loginAddr.ip, loginAddr.port, account);
  const client = await openGateAndEnterMap(
    login.gateIp,
    login.gatePort,
    { account: login.account, token: login.token, mapId: 100 },
  );
  try {
    const npc = client.enterMap.entities.find(
      (entity) => entity.entityType === 3 && entity.configId === 9001,
    );
    if (!npc) {
      throw new Error(`Starter quest chain did not see NPC 9001: ${stringifyForError(client.enterMap.entities)}`);
    }
    if (client.enterMap.quests.length !== 0 || client.enterMap.completedQuestConfigIds.length !== 0) {
      throw new Error(`Starter quest chain account was not fresh: ${stringifyForError(client.enterMap)}`);
    }
    const navigation: StarterQuestNavigationState = {
      x: client.enterMap.x,
      y: client.enterMap.y,
      z: client.enterMap.z,
      sequence: 0,
    };
    const entities = new Map(client.enterMap.entities.map((entity) => [entity.unitId, entity]));

    await navigateStarterQuestPlayer(client.gate, navigation, npc);
    await assertQuestAcceptanceBlocked(client.gate, 5005, npc.unitId);
    const quest5001 = await acceptStarterQuest(client.gate, 5001, npc.unitId, 5101);
    let firstQuest5001Corpse = 0;
    const killedA = await killStarterQuestMonsters(
      client.gate,
      navigation,
      entities,
      1,
      quest5001.objectives[0]?.required ?? 5,
      async (monster, killIndex) => {
        if (killIndex !== 1) return;
        firstQuest5001Corpse = monster.unitId;
        const preview = decodeInspectLootMonsterFrame(await client.gate.request(
          buildInspectLootMonsterPacket(nextRpcId++, { monsterId: monster.unitId }),
        )).body;
        if (preview.error || preview.drops.some((drop) => drop.itemConfigId === 1101)) {
          throw new Error(`inactive quest item was visible on corpse: ${stringifyForError(preview)}`);
        }
      },
    );
    await navigateStarterQuestPlayer(client.gate, navigation, npc);
    const reward5001 = await completeStarterQuest(client.gate, 5001, npc.unitId, 1001, 13);

    await assertQuestAcceptanceBlocked(client.gate, 5006, npc.unitId);
    const quest5005 = await acceptStarterQuest(client.gate, 5005, npc.unitId, 5105);
    const killedB = await killStarterQuestMonsters(
      client.gate,
      navigation,
      entities,
      2,
      quest5005.objectives[0]?.required ?? 5,
    );
    await navigateStarterQuestPlayer(client.gate, navigation, npc);
    const reward5005 = await completeStarterQuest(client.gate, 5005, npc.unitId, 1002, 10);

    const quest5006 = await acceptStarterQuest(client.gate, 5006, npc.unitId, 5106);
    const badgeGoal = quest5006.objectives[0]?.required ?? 5;
    let badgeCount = 0;
    const killedForBadges = await killStarterQuestMonsters(
      client.gate,
      navigation,
      entities,
      1,
      badgeGoal,
      async (monster, killIndex) => {
        const preview = decodeInspectLootMonsterFrame(await client.gate.request(
          buildInspectLootMonsterPacket(nextRpcId++, { monsterId: monster.unitId }),
        )).body;
        const badge = preview.drops.find((drop) => drop.itemConfigId === 1101);
        if (preview.error || !badge || badge.count !== 1) {
          throw new Error(`active quest badge was not available: ${stringifyForError(preview)}`);
        }
        const looted = decodeLootMonsterFrame(await client.gate.request(buildLootMonsterPacket(
          nextRpcId++,
          {
            monsterId: monster.unitId,
            operationId: nextOperationId(`starter-quest-badge-${killIndex}`),
            dropId: badge.dropId,
            lootAll: false,
          },
        ))).body;
        const item = looted.items.find((value) => value.configId === 1101);
        const progress = looted.quests.find((value) => value.questConfigId === 5006);
        badgeCount = item?.count ?? badgeCount;
        if (
          looted.error ||
          badgeCount !== killIndex ||
          !progress ||
          progress.objectives[0]?.current !== killIndex ||
          progress.objectives[0]?.required !== badgeGoal ||
          progress.status !== (killIndex === badgeGoal ? QuestStatus.ReadyToTurnIn : QuestStatus.InProgress)
        ) {
          throw new Error(`Starter quest badge progress mismatch: ${stringifyForError({ looted, killIndex })}`);
        }
      },
    );
    await navigateStarterQuestPlayer(client.gate, navigation, npc);
    const reward5006 = await completeStarterQuest(client.gate, 5006, npc.unitId, 1001, 18);

    // 跨图一次迫使Quest索引和Inventory由传送快照重建，不只验证原MapScene内存。
    // Cross maps once so Quest indices and Inventory rebuild from transfer state instead of passing only in the original MapScene.
    await transferConnectedPlayer(client.gate, 2);
    const restored = await transferConnectedPlayer(client.gate, 100);
    const inventory = new Map(restored.items.map((item) => [item.configId, item.count]));
    const completed = [5001, 5005, 5006].every((questId) => restored.completedQuestConfigIds.includes(questId));
    if (
      !completed ||
      restored.quests.some((quest) => [5001, 5005, 5006].includes(quest.questConfigId)) ||
      inventory.get(1001) !== 18 ||
      inventory.get(1002) !== 10 ||
      inventory.get(1003) !== 3 ||
      inventory.get(1101) !== 5
    ) {
      throw new Error(`Starter quest transfer snapshot mismatch: ${stringifyForError(restored)}`);
    }
    console.log("Starter quest chain:", {
      account,
      firstQuest5001Corpse,
      killedA,
      killedB,
      killedForBadges,
      badgeCount,
      rewards: [reward5001.questConfigId, reward5005.questConfigId, reward5006.questConfigId],
      completedQuestConfigIds: restored.completedQuestConfigIds,
      inventory: Object.fromEntries(inventory),
    });
  } finally {
    await client.gate.close();
  }
}

async function assertQuestAcceptanceBlocked(
  gate: TcpRpcConnection,
  questConfigId: number,
  npcUnitId: number,
): Promise<void> {
  const blocked = decodeAcceptQuestFrame(await gate.request(buildAcceptQuestPacket(
    nextRpcId++,
    { questConfigId, npcUnitId },
  ))).body;
  if (!blocked.error) {
    throw new Error(`quest ${questConfigId} ignored its prerequisite: ${stringifyForError(blocked)}`);
  }
}

async function acceptStarterQuest(
  gate: TcpRpcConnection,
  questConfigId: number,
  npcUnitId: number,
  objectiveId: number,
): Promise<QuestSnapshot> {
  const accepted = decodeAcceptQuestFrame(await gate.request(buildAcceptQuestPacket(
    nextRpcId++,
    { questConfigId, npcUnitId },
  ))).body;
  const objective = accepted.quest.objectives.find((value) => value.objectiveId === objectiveId);
  if (
    accepted.error ||
    accepted.quest.questConfigId !== questConfigId ||
    accepted.quest.status !== QuestStatus.InProgress ||
    !objective ||
    objective.current !== 0 ||
    objective.required !== 5
  ) {
    throw new Error(`quest ${questConfigId} acceptance mismatch: ${stringifyForError(accepted)}`);
  }
  return accepted.quest;
}

async function completeStarterQuest(
  gate: TcpRpcConnection,
  questConfigId: number,
  npcUnitId: number,
  rewardConfigId: number,
  expectedStackCount: number,
): Promise<ReturnType<typeof decodeCompleteQuestFrame>["body"]> {
  const completed = decodeCompleteQuestFrame(await gate.request(buildCompleteQuestPacket(
    nextRpcId++,
    { questConfigId, npcUnitId },
  ))).body;
  const reward = completed.rewardItems.find((item) => item.configId === rewardConfigId);
  if (
    completed.error ||
    completed.questConfigId !== questConfigId ||
    !reward ||
    reward.count !== expectedStackCount
  ) {
    throw new Error(`quest ${questConfigId} completion mismatch: ${stringifyForError(completed)}`);
  }
  return completed;
}

async function killStarterQuestMonsters(
  gate: TcpRpcConnection,
  navigation: StarterQuestNavigationState,
  entities: Map<number, MapEntitySnapshot>,
  monsterConfigId: number,
  count: number,
  afterKill?: (monster: MapEntitySnapshot, killIndex: number) => Promise<void>,
): Promise<number> {
  const consumed = new Set<number>();
  for (let killIndex = 1; killIndex <= count; killIndex += 1) {
    const monster = await nextStarterQuestMonster(gate, entities, consumed, monsterConfigId, 25_000);
    await navigateStarterQuestPlayer(gate, navigation, monster);
    let killed = false;
    for (let attack = 0; attack < 48; attack += 1) {
      const result = decodeAttackMonsterFrame(await gate.request(
        buildAttackMonsterPacket(nextRpcId++, { monsterId: monster.unitId }),
      )).body;
      if (result.error) {
        // 云Runner调度可能让移动完成Push略晚于估算时间；只对距离类错误做有界重试。
        // Cloud scheduling can delay movement completion slightly; retry only this bounded approach window.
        if (result.error === GameErrCode.MonsterTooFar && attack < 8) {
          await sleep(300);
          continue;
        }
        throw new Error(`monster ${monster.unitId} attack failed: ${stringifyForError(result)}`);
      }
      if (result.killed) {
        killed = true;
        break;
      }
    }
    if (!killed) throw new Error(`monster ${monster.unitId} survived the bounded Starter attack loop`);
    consumed.add(monster.unitId);
    entities.set(monster.unitId, { ...monster, alive: false });
    if (afterKill) await afterKill(monster, killIndex);
  }
  return count;
}

async function nextStarterQuestMonster(
  gate: TcpRpcConnection,
  entities: Map<number, MapEntitySnapshot>,
  consumed: ReadonlySet<number>,
  monsterConfigId: number,
  timeoutMs: number,
): Promise<MapEntitySnapshot> {
  const select = () => [...entities.values()]
    .filter((entity) =>
      entity.entityType === 2 &&
      entity.configId === monsterConfigId &&
      entity.alive &&
      !consumed.has(entity.unitId)
    )
    .sort((left, right) => left.unitId - right.unitId)[0];
  const immediate = select();
  if (immediate) return immediate;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const delta = decodeAoiDeltaFrame(await gate.waitForMessage(
      MsgCode.G2C_AoiDelta,
      Math.max(1, deadline - Date.now()),
    )).body;
    for (const unitId of delta.leaves) entities.delete(unitId);
    for (const entity of delta.enters) entities.set(entity.unitId, entity);
    const respawned = select();
    if (respawned) return respawned;
  }
  throw new Error(`monster config ${monsterConfigId} did not respawn within ${timeoutMs}ms`);
}

async function navigateStarterQuestPlayer(
  gate: TcpRpcConnection,
  navigation: StarterQuestNavigationState,
  target: Pick<MapEntitySnapshot, "x" | "y" | "z" | "unitId">,
): Promise<void> {
  const approach = pointNearTarget(navigation.x, navigation.z, target.x, target.z, 2);
  const deltaX = approach.x - navigation.x;
  const deltaZ = approach.z - navigation.z;
  if (deltaX * deltaX + deltaZ * deltaZ <= 0.25) return;
  navigation.sequence += 1;
  const response = decodeNavigateToFrame(await gate.request(buildNavigateToPacket(
    nextRpcId++,
    {
      targetX: approach.x,
      targetY: target.y,
      targetZ: approach.z,
      sequence: navigation.sequence,
    },
  ))).body;
  if (response.error || response.points.length === 0) {
    throw new Error(`navigation to ${target.unitId} failed: ${stringifyForError(response)}`);
  }
  let pathLength = 0;
  let previous = { x: navigation.x, z: navigation.z };
  for (const point of response.points) {
    pathLength += Math.hypot(point.x - previous.x, point.z - previous.z);
    previous = point;
  }
  const speed = GameConfigs.PlayerConfig.Get(1).moveSpeed;
  await sleep(Math.ceil(pathLength / speed * 1_000) + 800);
  navigation.x = approach.x;
  navigation.y = target.y;
  navigation.z = approach.z;
}

/** 重启后从progression记录恢复Boss奖励，不能依赖旧MapScene或离线Flush。 / Restores the Boss reward from the progression record after restart without relying on the old MapScene or offline flush. */
async function verifyStarterBossProgressionRecovery(
  loginAddr: { ip: string; port: number },
  account: string,
): Promise<void> {
  const login = await requestLogin(loginAddr.ip, loginAddr.port, account);
  const client = await openGateAndEnterMap(
    login.gateIp,
    login.gatePort,
    { account: login.account, token: login.token, mapId: 100 },
  );
  try {
    const player = client.enterMap.entities.find((entity) => entity.unitId === client.enterMap.unitId);
    const level = player?.numerics.find((numeric) => numeric.numericType === NumericType.Level)?.value;
    const experience = player?.numerics.find((numeric) => numeric.numericType === NumericType.Experience)?.value;
    if (level !== 2n || experience !== 120n) {
      throw new Error(`Starter Boss progression recovery mismatch: ${stringifyForError({ level, experience })}`);
    }
    const inventoryByConfig = new Map(client.enterMap.items.map((item) => [item.configId, item.count]));
    if (
      client.enterMap.gold !== 150n ||
      inventoryByConfig.get(1001) !== 8 ||
      inventoryByConfig.get(1002) !== 5 ||
      inventoryByConfig.get(1003) !== 8 ||
      client.enterMap.starterDungeonCooldownEndAtMs <= BigInt(Date.now())
    ) {
      throw new Error(`Starter Boss reward recovery mismatch: ${stringifyForError(client.enterMap)}`);
    }
    console.log("Starter Boss progression recovered:", {
      account,
      level: level.toString(),
      experience: experience.toString(),
      gold: client.enterMap.gold.toString(),
      cooldownEndAtMs: client.enterMap.starterDungeonCooldownEndAtMs.toString(),
    });
  } finally {
    await client.gate.close();
  }
}

function pointNearTarget(
  sourceX: number,
  sourceZ: number,
  targetX: number,
  targetZ: number,
  distance: number,
): { x: number; z: number } {
  const dx = sourceX - targetX;
  const dz = sourceZ - targetZ;
  const length = Math.hypot(dx, dz);
  if (length <= distance || length === 0) return { x: sourceX, z: sourceZ };
  return {
    x: targetX + dx / length * distance,
    z: targetZ + dz / length * distance,
  };
}

/** 先通过真实任务奖励获得道具，再消费并主动断开，等待Gate宽限期完成可靠下线保存。 / Grants the item through the real quest flow, consumes it, disconnects, and waits for the Gate grace period to save it durably. */
async function writeDbProxyPersistenceFixture(
  loginAddr: { ip: string; port: number },
  account: string,
): Promise<void> {
  const login = await requestLogin(loginAddr.ip, loginAddr.port, account);
  const client = await openGateAndEnterMap(
    login.gateIp,
    login.gatePort,
    { account: login.account, token: login.token, mapId: 100 },
  );
  const reward = await completeQuest5003ForPersistence(client.gate, client.enterMap);
  const initial = reward.rewardItems.find((item) => item.configId === 1001);
  if (!initial || initial.count <= 0) {
    throw new Error(`DBProxy write fixture expected quest 5003 to grant a positive small-potion stack, got ${initial?.count}`);
  }
  const expectedCount = initial.count - 1;
  console.log("DBProxy persistence player entered:", {
    account,
    unitId: client.enterMap.unitId,
    initialCount: initial.count,
    sourceQuestConfigId: reward.questConfigId,
  });
  let changed: ReturnType<typeof decodeUseItemFrame>["body"];
  try {
    changed = decodeUseItemFrame(await client.gate.request(
      buildUseItemPacket(nextRpcId++, {
        itemId: initial.itemId,
        operationId: nextOperationId("persistence"),
      }),
    )).body;
    if (changed.error || changed.item.count !== expectedCount) {
      throw new Error(`DBProxy write fixture item use failed: ${stringifyForError(changed)}`);
    }
  } finally {
    await client.gate.disconnect();
  }
  console.log("DBProxy persistence write staged:", {
    account,
    itemId: initial.itemId.toString(),
    count: changed.item.count,
    waitingForGateOfflineMs: 32_000,
  });
  await sleep(32_000);
}

/**
 * 用任务5003完成“接取 -> 进入地图2 -> 返回NPC -> 领奖”链路，为持久化测试提供真实奖励。
 * Completes quest 5003 through NPC interaction and map transfer so persistence tests receive a real reward.
 *
 * 副作用 / Side effect: the connected player ends on Map 100 with quest 5003 completed.
 * 禁止用法 / Forbidden: do not replace this with a direct inventory grant, otherwise the test skips the reward transaction.
 */
async function completeQuest5003ForPersistence(
  gate: TcpRpcConnection,
  initialMap: ReturnType<typeof decodeEnterMapFrame>["body"],
): Promise<ReturnType<typeof decodeCompleteQuestFrame>["body"]> {
  const initialPotion = initialMap.items.find((item) => item.configId === 1001);
  if (!initialPotion || initialPotion.count !== 3) {
    throw new Error(`persistence fixture expected the three starter potions, got ${stringifyForError(initialPotion)}`);
  }
  const starterNpc = initialMap.entities.find(
    (entity) => entity.entityType === 3 && entity.configId === 9001,
  );
  if (!starterNpc) {
    throw new Error(`persistence fixture did not see the Starter NPC: ${stringifyForError(initialMap.entities)}`);
  }
  const accepted = decodeAcceptQuestFrame(await gate.request(buildAcceptQuestPacket(
    nextRpcId++,
    { questConfigId: 5003, npcUnitId: starterNpc.unitId },
  ))).body;
  if (accepted.error || accepted.quest.questConfigId !== 5003) {
    throw new Error(`persistence fixture could not accept quest 5003: ${stringifyForError(accepted)}`);
  }

  const map2Ready = gate.waitForMessage(MsgCode.G2C_MapReady);
  const map2 = decodeEnterMapFrame(await gate.request(
    buildEnterMapPacket(nextRpcId++, { mapId: 2, mapInstanceId: 0n }),
  )).body;
  await map2Ready;
  const quest = map2.quests.find((value) => value.questConfigId === 5003);
  const potionBeforeReward = map2.items.find((item) => item.configId === 1001);
  if (
    potionBeforeReward?.itemId !== initialPotion.itemId ||
    potionBeforeReward.count !== initialPotion.count
  ) {
    throw new Error(
      `persistence fixture changed the starter inventory before quest reward: ${stringifyForError(potionBeforeReward)}`,
    );
  }
  if (!quest || quest.status !== QuestStatus.ReadyToTurnIn) {
    throw new Error(`persistence fixture expected quest 5003 ready, got ${quest?.status}`);
  }

  const map100 = await transferConnectedPlayer(gate, 100);
  const map100Npc = map100.entities.find(
    (entity) => entity.entityType === 3 && entity.configId === 9001,
  );
  if (!map100Npc) {
    throw new Error(`persistence fixture did not find the NPC after returning to Map 100: ${stringifyForError(map100.entities)}`);
  }
  const reward = decodeCompleteQuestFrame(await gate.request(
    buildCompleteQuestPacket(nextRpcId++, { questConfigId: 5003, npcUnitId: map100Npc.unitId }),
  )).body;
  if (reward.error) {
    throw new Error(`persistence fixture quest reward failed: ${stringifyForError(reward)}`);
  }
  return reward;
}

/** 验证任务奖励经PostgreSQL事务提交，并且客户端重复请求只得到首次结果。 / Verifies a quest reward commits through PostgreSQL and a repeated client request returns the original result once. */
async function verifyDbProxyQuestReward(
  loginAddr: { ip: string; port: number },
  account: string,
): Promise<void> {
  const login = await requestLogin(loginAddr.ip, loginAddr.port, account);
  const client = await openGateAndEnterMap(
    login.gateIp,
    login.gatePort,
    { account: login.account, token: login.token, mapId: 100 },
  );
  try {
    const initialPotion = client.enterMap.items.find((item) => item.configId === 1001);
    if (!initialPotion || initialPotion.count !== 3) {
      throw new Error(`quest transaction fixture expected the three starter potions, got ${stringifyForError(initialPotion)}`);
    }
    const starterNpc = client.enterMap.entities.find(
      (entity) => entity.entityType === 3 && entity.configId === 9001,
    );
    if (!starterNpc) {
      throw new Error(`quest transaction fixture did not see the Starter NPC: ${stringifyForError(client.enterMap.entities)}`);
    }
    const accepted = decodeAcceptQuestFrame(await client.gate.request(buildAcceptQuestPacket(
      nextRpcId++,
      { questConfigId: 5003, npcUnitId: starterNpc.unitId },
    ))).body;
    if (accepted.error || accepted.quest.questConfigId !== 5003) {
      throw new Error(`quest transaction fixture could not accept quest 5003 from NPC: ${stringifyForError(accepted)}`);
    }
    const mapReady = client.gate.waitForMessage(MsgCode.G2C_MapReady);
    const map2 = decodeEnterMapFrame(await client.gate.request(
      buildEnterMapPacket(nextRpcId++, { mapId: 2, mapInstanceId: 0n }),
    )).body;
    await mapReady;
    const quest = map2.quests.find((value) => value.questConfigId === 5003);
    const potionBeforeReward = map2.items.find((item) => item.configId === 1001);
    if (
      potionBeforeReward?.itemId !== initialPotion.itemId ||
      potionBeforeReward.count !== initialPotion.count
    ) {
      throw new Error(
        `quest transaction fixture changed starter inventory before reward: ${stringifyForError(potionBeforeReward)}`,
      );
    }
    if (!quest || quest.status !== QuestStatus.ReadyToTurnIn) {
      throw new Error(`quest transaction fixture expected quest 5003 ready, got ${quest?.status}`);
    }
    // 领奖必须回到任务使者处；任务完成状态可以跨地图传送，但奖励交付仍由NPC交互完成。
    // The quest state may become ready in Map 2, but reward delivery still happens at the NPC.
    const map100 = await transferConnectedPlayer(client.gate, 100);
    const map100Npc = map100.entities.find(
      (entity) => entity.entityType === 3 && entity.configId === 9001,
    );
    if (!map100Npc) {
      throw new Error(`quest transaction fixture did not find the NPC after returning to Map 100: ${stringifyForError(map100.entities)}`);
    }
    const first = decodeCompleteQuestFrame(await client.gate.request(
      buildCompleteQuestPacket(nextRpcId++, { questConfigId: 5003, npcUnitId: map100Npc.unitId }),
    )).body;
    const duplicate = decodeCompleteQuestFrame(await client.gate.request(
      buildCompleteQuestPacket(nextRpcId++, { questConfigId: 5003, npcUnitId: map100Npc.unitId }),
    )).body;
    if (first.error || duplicate.error) {
      throw new Error(
        `quest transaction fixture failed: ${stringifyForError({ first, duplicate })}`,
      );
    }
    const rewarded = first.rewardItems.find((item) => item.configId === 1001);
    const duplicateReward = duplicate.rewardItems.find((item) => item.configId === 1001);
    if (
      !rewarded ||
      rewarded.itemId !== initialPotion.itemId ||
      rewarded.count !== initialPotion.count + 3 ||
      first.questConfigId !== duplicate.questConfigId ||
      stringifyForError(first.rewardItems) !== stringifyForError(duplicate.rewardItems)
    ) {
      throw new Error(
        `quest transaction fixture was not idempotent: ${stringifyForError({ first, duplicate })}`,
      );
    }
    if (duplicateReward?.itemId !== rewarded.itemId) {
      throw new Error("quest transaction duplicate returned a different item identity");
    }
    console.log("DBProxy quest reward transaction passed:", {
      account,
      questConfigId: first.questConfigId,
      itemId: rewarded.itemId.toString(),
      count: rewarded.count,
    });
  } finally {
    await client.gate.close();
  }
}

/** 在TiangZ重启后只依赖事务后的持久快照恢复，并验证重复领奖仍读取原回执。 / Recovers only from the committed transaction snapshot after a TiangZ restart and verifies a repeated claim still reads the original receipt. */
async function verifyDbProxyQuestRewardRecovery(
  loginAddr: { ip: string; port: number },
  account: string,
): Promise<void> {
  const login = await requestLogin(loginAddr.ip, loginAddr.port, account);
  const client = await openGateAndEnterMap(
    login.gateIp,
    login.gatePort,
    { account: login.account, token: login.token, mapId: 2 },
  );
  try {
    const item = client.enterMap.items.find((value) => value.configId === 1001);
    if (
      !item ||
      item.count !== 6 ||
      !client.enterMap.completedQuestConfigIds.includes(5003) ||
      client.enterMap.quests.some((quest) => quest.questConfigId === 5003)
    ) {
      throw new Error(
        `quest transaction recovery snapshot mismatch: ${stringifyForError(client.enterMap)}`,
      );
    }
    const map100 = await transferConnectedPlayer(client.gate, 100);
    const map100Npc = map100.entities.find(
      (entity) => entity.entityType === 3 && entity.configId === 9001,
    );
    if (!map100Npc) {
      throw new Error(`quest transaction recovery did not find the NPC after returning to Map 100: ${stringifyForError(map100.entities)}`);
    }
    const receipt = decodeCompleteQuestFrame(await client.gate.request(
      buildCompleteQuestPacket(nextRpcId++, { questConfigId: 5003, npcUnitId: map100Npc.unitId }),
    )).body;
    const rewarded = receipt.rewardItems.find((value) => value.configId === 1001);
    if (receipt.error || rewarded?.itemId !== item.itemId || rewarded.count !== 6) {
      throw new Error(`quest transaction recovery receipt mismatch: ${stringifyForError(receipt)}`);
    }
    console.log("DBProxy quest reward restart recovery passed:", {
      account,
      questConfigId: receipt.questConfigId,
      itemId: item.itemId.toString(),
      count: item.count,
    });
  } finally {
    await client.gate.close();
  }
}

/** 验证道具扣除、治疗/CD效果和原始响应由同一玩家事务提交，同operationId重试不会再次扣除。 / Verifies item consumption, heal/cooldown effects, and the original response share one player transaction and the same operationId cannot consume twice. */
async function verifyDbProxyItemUse(
  loginAddr: { ip: string; port: number },
  account: string,
): Promise<void> {
  const login = await requestLogin(loginAddr.ip, loginAddr.port, account);
  const client = await openGateAndEnterMap(
    login.gateIp,
    login.gatePort,
    { account: login.account, token: login.token, mapId: 100 },
  );
  try {
    const initial = client.enterMap.items.find((item) => item.configId === 1001);
    if (!initial || initial.count <= 0) {
      throw new Error(`item transaction fixture requires a positive small-potion stack, got ${initial?.count}`);
    }
    const expectedCount = initial.count - 1;
    const request = {
      itemId: initial.itemId,
      operationId: "dbproxy-item-use-1",
    };
    const first = decodeUseItemFrame(await client.gate.request(
      buildUseItemPacket(nextRpcId++, request),
    )).body;
    const duplicate = decodeUseItemFrame(await client.gate.request(
      buildUseItemPacket(nextRpcId++, request),
    )).body;
    if (
      first.error || duplicate.error ||
      first.item.count !== expectedCount || duplicate.item.count !== expectedCount ||
      first.item.itemId !== duplicate.item.itemId ||
      first.item.version !== duplicate.item.version ||
      first.globalCooldownEndAtMs !== duplicate.globalCooldownEndAtMs ||
      first.itemCooldownEndAtMs !== duplicate.itemCooldownEndAtMs
    ) {
      throw new Error(`item transaction was not idempotent: ${stringifyForError({ first, duplicate })}`);
    }
    console.log("DBProxy item-use transaction passed:", {
      account,
      itemId: first.item.itemId.toString(),
      count: first.item.count,
      version: first.item.version,
    });
  } finally {
    await client.gate.close();
  }
}

/** TiangZ重启后从事务快照恢复背包，并用原operationId取回首次结果而不再次扣除。 / Restores inventory from the transaction snapshot after restart and returns the first result for the original operationId without consuming again. */
async function verifyDbProxyItemUseRecovery(
  loginAddr: { ip: string; port: number },
  account: string,
): Promise<void> {
  const login = await requestLogin(loginAddr.ip, loginAddr.port, account);
  const client = await openGateAndEnterMap(
    login.gateIp,
    login.gatePort,
    { account: login.account, token: login.token, mapId: 100 },
  );
  try {
    const restored = client.enterMap.items.find((item) => item.configId === 1001);
    if (!restored || restored.version < 2) {
      throw new Error(`item transaction recovery snapshot mismatch: ${stringifyForError(restored)}`);
    }
    const receipt = decodeUseItemFrame(await client.gate.request(buildUseItemPacket(
      nextRpcId++,
      { itemId: restored.itemId, operationId: "dbproxy-item-use-1" },
    ))).body;
    if (
      receipt.error || receipt.item.count !== restored.count ||
      receipt.item.itemId !== restored.itemId || receipt.item.version !== restored.version
    ) {
      throw new Error(`item transaction recovery receipt mismatch: ${stringifyForError(receipt)}`);
    }
    console.log("DBProxy item-use restart recovery passed:", {
      account,
      itemId: restored.itemId.toString(),
      count: restored.count,
      version: restored.version,
    });
  } finally {
    await client.gate.close();
  }
}

/** 服务重启后读取同账号，确认出生药品不会被重复发放。 / Reads the same account after a server restart and verifies starter items are not seeded again. */
async function verifyDbProxyPersistenceFixture(
  loginAddr: { ip: string; port: number },
  account: string,
): Promise<void> {
  const login = await requestLogin(loginAddr.ip, loginAddr.port, account);
  const client = await openGateAndEnterMap(
    login.gateIp,
    login.gatePort,
    { account: login.account, token: login.token, mapId: 100 },
  );
  try {
    const restored = client.enterMap.items.find((item) => item.configId === 1001);
    if (!restored || restored.version < 2) {
      throw new Error(
        `DBProxy restore expected the consumed item to remain with version>=2, got ${stringifyForError(restored)}`,
      );
    }
    console.log("DBProxy persistence restored:", {
      account,
      unitId: client.enterMap.unitId,
      itemId: restored.itemId.toString(),
      count: restored.count,
      version: restored.version,
    });
  } finally {
    await client.gate.disconnect();
  }
}

function namedArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined) return undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function positiveIntegerArgument(name: string, fallback: number): number {
  const value = namedArgument(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return parsed;
}

/** 验证七技能共用状态机的关键路径；复杂Buff冲突矩阵由buff-action自测覆盖。 / Verifies key paths of the shared seven-skill state machine; buff-action tests cover the detailed conflict matrix. */
async function verifyFiveSkillMechanics(
  gate: TcpRpcConnection,
  enterMap: ReturnType<typeof decodeEnterMapFrame>["body"],
): Promise<void> {
  const targets = enterMap.entities
    .filter((entity) => entity.entityType === 2)
    .sort((left, right) => {
      const leftDistance = Math.hypot(left.x - enterMap.x, left.y - enterMap.y, left.z - enterMap.z);
      const rightDistance = Math.hypot(right.x - enterMap.x, right.y - enterMap.y, right.z - enterMap.z);
      return leftDistance - rightDistance;
    });
  const target = targets[0];
  const smiteTarget = targets[1];
  if (!target || !smiteTarget) throw new Error("skill smoke requires two AOI-visible monsters");

  const approachPoint = (
    fromX: number,
    fromZ: number,
    destination: { x: number; z: number },
    stopDistance: number,
  ): { targetX: number; targetZ: number } => {
    const dx = destination.x - fromX;
    const dz = destination.z - fromZ;
    const distance = Math.hypot(dx, dz);
    if (distance <= stopDistance || distance === 0) return { targetX: fromX, targetZ: fromZ };
    const scale = (distance - stopDistance) / distance;
    return { targetX: fromX + dx * scale, targetZ: fromZ + dz * scale };
  };

  const shieldRpcId = nextRpcId++;
  const shield = decodeCastSkillFrame(await gate.request(buildCastSkillPacket(shieldRpcId, {
    skillId: 3004,
    targetUnitId: enterMap.unitId,
  })));
  if (shield.rpcId !== shieldRpcId || shield.body.error || shield.body.skillId !== 3004) {
    throw new Error(`Power Word: Shield failed: ${stringifyForError(shield.body)}`);
  }
  // 盾自身8秒CD先于15秒虚弱灵魂；等技能CD结束后才能验证Buff否决兜底。
  // Shield's 8-second cooldown precedes the 15-second Weakened Soul veto.
  await sleep(8_100);
  const blocked = decodeCastSkillFrame(await gate.request(buildCastSkillPacket(nextRpcId++, {
    skillId: 3004,
    targetUnitId: enterMap.unitId,
  })));
  if (blocked.body.error !== 10022) {
    throw new Error(`Weakened Soul did not veto a second shield: ${stringifyForError(blocked.body)}`);
  }

  const fortitude = decodeCastSkillFrame(await gate.request(buildCastSkillPacket(nextRpcId++, {
    skillId: 3005,
    targetUnitId: enterMap.unitId,
  })));
  if (fortitude.body.error || fortitude.body.skillId !== 3005) {
    throw new Error(`Power Word: Fortitude failed: ${stringifyForError(fortitude.body)}`);
  }
  await sleep(1_100);

  const projectilePush = gate.waitForMessage(MsgCode.G2C_SkillProjectile, 4_000);
  const combatResultPush = waitForCombatResult(gate, target.unitId, 3001, 4_000);
  const frostbolt = decodeCastSkillFrame(await gate.request(buildCastSkillPacket(nextRpcId++, {
    skillId: 3001,
    targetUnitId: target.unitId,
  })));
  if (frostbolt.body.error || frostbolt.body.phase !== 1) {
    throw new Error(`Frostbolt did not begin casting: ${stringifyForError(frostbolt.body)}`);
  }
  const projectile = decodeSkillProjectileFrame(await projectilePush).body;
  const impact = await waitForSkillImpact(gate, 3001, 4_000);
  const combatResult = await combatResultPush;
  if (
    projectile.skillId !== 3001 ||
    impact.skillId !== 3001 ||
    impact.damage !== 50n ||
    impact.damageSchool !== 2 ||
    combatResult.abilityId !== 3001 ||
    combatResult.targetUnitId !== target.unitId ||
    combatResult.effectiveAmount !== 50n ||
    combatResult.currentHp < 0n
  ) {
    throw new Error(`Frostbolt result mismatch: ${stringifyForError({ projectile, impact, combatResult })}`);
  }

  // 火焰冲击是10米技能；先把测试角色移动到目标5米内，避免用15米出生距离误测业务拒绝。
  // Fire Blast has a 10-meter range; approach within five meters so the smoke
  // test does not mistake the 15-meter spawn distance for a skill failure.
  const firePoint = approachPoint(enterMap.x, enterMap.z, target, 5);
  const fireApproach = decodeNavigateToFrame(await gate.request(buildNavigateToPacket(nextRpcId++, {
    ...firePoint,
    targetY: 0,
    sequence: 10,
  })));
  if (fireApproach.body.error) {
    throw new Error(`could not approach Fire Blast target: ${stringifyForError(fireApproach.body)}`);
  }
  await sleep(2_000);

  const fireBlast = decodeCastSkillFrame(await gate.request(buildCastSkillPacket(nextRpcId++, {
    skillId: 3002,
    targetUnitId: target.unitId,
  })));
  if (fireBlast.body.error) {
    throw new Error(`Fire Blast failed: ${stringifyForError(fireBlast.body)}`);
  }
  const fireCombatResultPush = waitForCombatResult(gate, target.unitId, 3002, 3_000);
  const fireImpact = await waitForSkillImpact(gate, 3002, 3_000);
  const fireCombatResult = await fireCombatResultPush;
  if (
    fireImpact.damage <= 0n ||
    fireImpact.damage > 100n ||
    fireImpact.damageSchool !== 3 ||
    fireCombatResult.abilityId !== 3002 ||
    fireCombatResult.targetUnitId !== target.unitId ||
    fireCombatResult.requestedAmount !== 100n ||
    fireCombatResult.effectiveAmount !== fireImpact.damage ||
    fireCombatResult.effectiveAmount <= 0n ||
    fireCombatResult.effectiveAmount > fireCombatResult.requestedAmount
  ) {
    throw new Error(`Fire Blast result mismatch: ${stringifyForError({ fireImpact, fireCombatResult })}`);
  }
  const smitePoint = approachPoint(firePoint.targetX, firePoint.targetZ, smiteTarget, 5);
  const smiteApproach = decodeNavigateToFrame(await gate.request(buildNavigateToPacket(nextRpcId++, {
    ...smitePoint,
    targetY: 0,
    sequence: 11,
  })));
  if (smiteApproach.body.error) {
    throw new Error(`could not approach Smite target: ${stringifyForError(smiteApproach.body)}`);
  }
  await sleep(5_000);
  await sleep(1_100);

  const castStatePush = gate.waitForMessage(MsgCode.G2C_SkillCastState, 3_000);
  const smite = decodeCastSkillFrame(await gate.request(buildCastSkillPacket(nextRpcId++, {
    skillId: 3003,
    targetUnitId: smiteTarget.unitId,
  })));
  if (smite.body.error || smite.body.phase !== 1) {
    throw new Error(`Smite did not begin casting: ${stringifyForError(smite.body)}`);
  }
  await gate.request(buildNavigateInputPacket(nextRpcId++, {
    forward: 1,
    strafe: 0,
    yaw: 0,
    sequence: 99,
  }));
  let interrupted = decodeSkillCastStateFrame(await castStatePush).body;
  const interruptDeadline = Date.now() + 3_000;
  while (interrupted.interruptReason !== "movement" && Date.now() < interruptDeadline) {
    interrupted = decodeSkillCastStateFrame(await gate.waitForMessage(
      MsgCode.G2C_SkillCastState,
      Math.max(1, interruptDeadline - Date.now()),
    )).body;
  }
  if (interrupted.phase !== 0 || interrupted.interruptReason !== "movement") {
    throw new Error(`movement did not interrupt Smite: ${stringifyForError(interrupted)}`);
  }
  await gate.request(buildNavigateInputPacket(nextRpcId++, {
    forward: 0,
    strafe: 0,
    yaw: 0,
    sequence: 100,
  }));

  // 精神鞭笞先验证真实引导Tick，再用移动验证引导中断；客户端收到的状态同样来自这条协议链。
  // Mind Flay first verifies a real channel tick, then movement interruption;
  // the client-visible state comes from the same protocol path.
  await sleep(1_100);
  const channel = decodeCastSkillFrame(await gate.request(buildCastSkillPacket(nextRpcId++, {
    skillId: 3007,
    targetUnitId: smiteTarget.unitId,
  })));
  if (channel.body.error || channel.body.phase !== 1) {
    throw new Error(`Mind Flay did not begin channeling: ${stringifyForError(channel.body)}`);
  }
  const channelCombatResultPush = waitForCombatResult(gate, smiteTarget.unitId, 3007, 2_500);
  const channelImpact = await waitForSkillImpact(gate, 3007, 2_500);
  const channelCombatResult = await channelCombatResultPush;
  if (
    channelImpact.damage !== 30n ||
    channelImpact.damageSchool !== 5 ||
    channelCombatResult.abilityId !== 3007 ||
    channelCombatResult.targetUnitId !== smiteTarget.unitId ||
    channelCombatResult.effectiveAmount !== 30n
  ) {
    throw new Error(`Mind Flay tick mismatch: ${stringifyForError({ channelImpact, channelCombatResult })}`);
  }
  const channelStatePush = gate.waitForMessage(MsgCode.G2C_SkillCastState, 3_000);
  await gate.request(buildNavigateInputPacket(nextRpcId++, {
    forward: 1,
    strafe: 0,
    yaw: 0,
    sequence: 101,
  }));
  let channelInterrupted = decodeSkillCastStateFrame(await channelStatePush).body;
  const channelInterruptDeadline = Date.now() + 3_000;
  while (channelInterrupted.interruptReason !== "movement" && Date.now() < channelInterruptDeadline) {
    channelInterrupted = decodeSkillCastStateFrame(await gate.waitForMessage(
      MsgCode.G2C_SkillCastState,
      Math.max(1, channelInterruptDeadline - Date.now()),
    )).body;
  }
  if (channelInterrupted.phase !== 0 || channelInterrupted.interruptReason !== "movement") {
    throw new Error(`movement did not interrupt Mind Flay: ${stringifyForError(channelInterrupted)}`);
  }
  await gate.request(buildNavigateInputPacket(nextRpcId++, {
    forward: 0,
    strafe: 0,
    yaw: 0,
    sequence: 102,
  }));

  console.log("Seven-skill mechanics:", {
    shield: "accepted",
    weakenedSoul: "vetoed",
    fortitude: "accepted",
    frostboltDamage: impact.damage,
    frostboltSchool: impact.damageSchool,
    frostboltPrivateCurrentHp: combatResult.currentHp,
    fireBlastFinalDamage: fireImpact.damage,
    fireBlastSchool: fireImpact.damageSchool,
    fireBlastPrivateCurrentHp: fireCombatResult.currentHp,
    smiteInterrupt: interrupted.interruptReason,
    mindFlayTickDamage: channelImpact.damage,
    mindFlaySchool: channelImpact.damageSchool,
    mindFlayPrivateCurrentHp: channelCombatResult.currentHp,
    mindFlayInterrupt: channelInterrupted.interruptReason,
  });
}

async function waitForSkillImpact(
  gate: TcpRpcConnection,
  skillId: number,
  timeoutMs: number,
): Promise<ReturnType<typeof decodeSkillImpactFrame>["body"]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const impact = decodeSkillImpactFrame(await gate.waitForMessage(
      MsgCode.G2C_SkillImpact,
      Math.max(1, deadline - Date.now()),
    )).body;
    if (impact.skillId === skillId) return impact;
  }
  throw new Error(`skill ${skillId} impact timed out`);
}

/** 过滤同一时间窗内的怪物反击等其他CombatResult，只返回指定技能对指定目标的私有结果。 / Filters unrelated private combat results such as monster retaliation and returns one skill-target match. */
async function waitForCombatResult(
  gate: TcpRpcConnection,
  targetUnitId: number,
  abilityId: number,
  timeoutMs: number,
): Promise<ReturnType<typeof decodeCombatResultFrame>["body"]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = decodeCombatResultFrame(await gate.waitForMessage(
      MsgCode.G2C_CombatResult,
      Math.max(1, deadline - Date.now()),
    )).body;
    if (result.targetUnitId === targetUnitId && result.abilityId === abilityId) return result;
  }
  throw new Error(`combat result for ability ${abilityId} target ${targetUnitId} timed out`);
}

/** 通过正式Inner握手验证动态副本创建和空地图销毁。 / Verifies dynamic-map creation and empty-map disposal through the real Inner handshake. */
async function verifyDynamicMapLifecycle(): Promise<MapInstanceSnapshot> {
  const requestId = `runtime-smoke:${Date.now()}`;
  const createRpcId = nextRpcId++;
  const createFrame = await requestOneInternal(
    "127.0.0.1",
    7100,
    encodePacket(
      ServerMsgCode.S2M_CreateDynamicMap,
      S2M_CreateDynamicMapCodec.encode({ rpcId: createRpcId, mapConfigId: 1, requestId }),
    ),
  );
  if (readU16BE(createFrame, 0) !== ServerMsgCode.M2S_CreateDynamicMap) {
    throw new Error("dynamic map create returned an unexpected msgcode");
  }
  const created = M2S_CreateDynamicMapCodec.decode(createFrame.subarray(2));
  if (created.error || created.instance.mapInstanceId === 1n) {
    throw new Error(`dynamic map create failed: ${created.error} ${created.message}`);
  }

  const retriedFrame = await requestOneInternal(
    "127.0.0.1",
    7100,
    encodePacket(
      ServerMsgCode.S2M_CreateDynamicMap,
      S2M_CreateDynamicMapCodec.encode({
        rpcId: nextRpcId++,
        mapConfigId: 1,
        requestId,
      }),
    ),
  );
  const retried = M2S_CreateDynamicMapCodec.decode(retriedFrame.subarray(2));
  if (retried.instance.mapInstanceId !== created.instance.mapInstanceId) {
    throw new Error("dynamic map idempotent retry returned another instance");
  }

  const secondFrame = await requestOneInternal(
    "127.0.0.1",
    7100,
    encodePacket(
      ServerMsgCode.S2M_CreateDynamicMap,
      S2M_CreateDynamicMapCodec.encode({
        rpcId: nextRpcId++,
        mapConfigId: 1,
        requestId: `${requestId}:second`,
      }),
    ),
  );
  const second = M2S_CreateDynamicMapCodec.decode(secondFrame.subarray(2));
  if (second.error || second.instance.mapHostName === created.instance.mapHostName) {
    throw new Error("dynamic map placement did not spread two instances across idle MapHosts");
  }

  const disposed = await disposeDynamicMap(second.instance.mapHost.port, second.instance.mapInstanceId);
  await waitForDisposedRequest(`${requestId}:second`, 7100);
  console.log("Dynamic map lifecycle:", {
    mapConfigId: created.instance.mapConfigId,
    mapInstanceId: created.instance.mapInstanceId,
    mapHostName: created.instance.mapHostName,
    secondDisposed: disposed.disposed,
  });
  return created.instance;
}

/** 验证只有一个动态地图宿主时的创建、幂等和销毁闭环。 / Verifies create, idempotency, and disposal with one dynamic MapHost. */
async function verifySingleHostDynamicMapLifecycle(managerPort: number): Promise<void> {
  const requestId = `single-host-smoke:${Date.now()}`;
  const create = async () => {
    const frame = await requestOneInternal(
      "127.0.0.1",
      managerPort,
      encodePacket(
        ServerMsgCode.S2M_CreateDynamicMap,
        S2M_CreateDynamicMapCodec.encode({
          rpcId: nextRpcId++,
          mapConfigId: 1,
          requestId,
        }),
      ),
    );
    if (readU16BE(frame, 0) !== ServerMsgCode.M2S_CreateDynamicMap) {
      throw new Error("single-host dynamic map create returned an unexpected msgcode");
    }
    return M2S_CreateDynamicMapCodec.decode(frame.subarray(2));
  };

  const created = await create();
  if (created.error || created.instance.mapInstanceId === 1n) {
    throw new Error(`single-host dynamic map create failed: ${created.error} ${created.message}`);
  }
  const retried = await create();
  if (retried.error || retried.instance.mapInstanceId !== created.instance.mapInstanceId) {
    throw new Error("single-host dynamic map idempotent retry returned another instance");
  }

  const disposed = await disposeDynamicMap(created.instance.mapHost.port, created.instance.mapInstanceId);
  if (!disposed.disposed) throw new Error("single-host dynamic map was not disposed");
  await waitForDisposedRequest(requestId, managerPort);
  console.log("Single-host dynamic map lifecycle:", {
    managerPort,
    mapConfigId: created.instance.mapConfigId,
    mapInstanceId: created.instance.mapInstanceId,
    mapHostName: created.instance.mapHostName,
    mapHostPort: created.instance.mapHost.port,
    disposed: disposed.disposed,
  });
}

/** 销毁完成后重试旧requestId，确认MapManager已经收到最终通知并拒绝复用。 / Retries a disposed request ID to verify MapManager received the final notification and rejects reuse. */
async function waitForDisposedRequest(requestId: string, managerPort: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const frame = await requestOneInternal(
      "127.0.0.1",
      managerPort,
      encodePacket(
        ServerMsgCode.S2M_CreateDynamicMap,
        S2M_CreateDynamicMapCodec.encode({
          rpcId: nextRpcId++,
          mapConfigId: 1,
          requestId,
        }),
      ),
    );
    const response = M2S_CreateDynamicMapCodec.decode(frame.subarray(2));
    if (response.error) return;
    await sleep(100);
  }
  throw new Error(`MapManager did not acknowledge disposed dynamic map: ${requestId}`);
}

async function disposeDynamicMap(mapHostPort: number, mapInstanceId: bigint) {
  const frame = await requestOneInternal(
    "127.0.0.1",
    mapHostPort,
    encodePacket(
      ServerMsgCode.S2M_DisposeDynamicMap,
      S2M_DisposeDynamicMapCodec.encode({ rpcId: nextRpcId++, mapInstanceId }),
    ),
  );
  if (readU16BE(frame, 0) !== ServerMsgCode.M2S_DisposeDynamicMap) {
    throw new Error("dynamic map dispose returned an unexpected msgcode");
  }
  const disposed = M2S_DisposeDynamicMapCodec.decode(frame.subarray(2));
  if (disposed.error || !disposed.disposed) {
    throw new Error(`dynamic map dispose failed: ${disposed.error} ${disposed.message}`);
  }
  return disposed;
}

/** 等待真实30秒宽限结束，验证Gate驱动Map最终下线并让下次进入创建新Unit。 / Waits for the real grace deadline and verifies Gate-driven Map offline causes the next entry to create a new Unit. */
async function verifyGateFinalTimeout(loginIp: string, loginPort: number): Promise<void> {
  const account = `smoke_timeout_${Date.now()}`;
  const firstLogin = await requestLogin(loginIp, loginPort, account);
  const first = await openGateAndEnterMap(firstLogin.gateIp, firstLogin.gatePort, {
    account,
    token: firstLogin.token,
    mapId: 1,
  });
  const firstUnitId = first.enterMap.unitId;
  await first.gate.close();

  // 30秒宽限加两个1秒扫描周期，避免把调度边界误判为业务失败。
  await sleep(32_000);
  const secondLogin = await requestLogin(loginIp, loginPort, account);
  const second = await openGateAndEnterMap(secondLogin.gateIp, secondLogin.gatePort, {
    account,
    token: secondLogin.token,
    mapId: 1,
  });
  try {
    if (second.enterMap.unitId === firstUnitId) {
      throw new Error(`Gate timeout retained expired Unit ${firstUnitId}`);
    }
    console.log("Gate final timeout:", {
      account,
      removedUnitId: firstUnitId,
      recreatedUnitId: second.enterMap.unitId,
    });
  } finally {
    await second.gate.close();
  }
}

let nextRpcId = 1;
let nextOperationSequence = 1;

function nextOperationId(scope: string): string {
  return `smoke-${scope}-${Date.now().toString(36)}-${nextOperationSequence++}`;
}

function requestLoginServiceAddr(ip: string, port: number) {
  const rpcId = nextRpcId++;
  return requestOne(ip, port, buildGetLoginServiceAddrPacket(rpcId)).then((frame) => {
    const response = decodeGetLoginServiceAddrFrame(frame);
    if (response.rpcId !== rpcId) {
      throw new Error(`GetLoginServiceAddr rpcId mismatch: ${response.rpcId}`);
    }
    if (response.body.error) {
      throw new Error(`GetLoginServiceAddr failed: ${response.body.error} ${response.body.message ?? ""}`);
    }
    return response.body;
  });
}

function requestLogin(ip: string, port: number, account: string) {
  const password = `smoke_password_${account}`;
  return requestRegister(ip, port, account, password).then((registered) => {
    if (registered.body.error && registered.body.error !== 10037) {
      throw new Error(`Register failed: ${registered.body.error} ${registered.body.message ?? ""}`);
    }
    const rpcId = nextRpcId++;
    return requestOne(ip, port, buildLoginPacket(rpcId, { account, password })).then((frame) => {
    const response = decodeLoginFrame(frame);
    if (response.rpcId !== rpcId) {
      throw new Error(`Login rpcId mismatch: ${response.rpcId}`);
    }
    if (response.body.error) {
      throw new Error(`Login failed: ${response.body.error} ${response.body.message ?? ""}`);
    }
    return response.body;
  });
  });
}

function requestRegister(ip: string, port: number, account: string, password: string) {
  const rpcId = nextRpcId++;
  return requestOne(ip, port, buildRegisterPacket(rpcId, { account, password })).then((frame) => {
    const response = decodeRegisterFrame(frame);
    if (response.rpcId !== rpcId) {
      throw new Error(`Register rpcId mismatch: ${response.rpcId}`);
    }
    return response;
  });
}

async function verifyGateSessionLifecycle(
  ip: string,
  port: number,
  request: { account: string; token: string; mapId: number },
  dynamicMap: MapInstanceSnapshot,
) {
  const first = await openGateAndEnterMap(ip, port, request);
  const replacementFrame = first.gate.waitForMessage(MsgCode.G2C_SessionReplaced, 5_000);
  const second = await openGateAndEnterMap(ip, port, request);
  const replacement = G2C_SessionReplacedCodec.decode((await replacementFrame).subarray(2));
  if (
    replacement.reasonCode !== 10040 ||
    replacement.reason !== "账号已在其他设备登录"
  ) {
    throw new Error(`account takeover notice mismatch: ${stringifyForError(replacement)}`);
  }
  if (second.enterMap.unitId !== first.enterMap.unitId) {
    throw new Error("reconnected account did not reuse its existing map unit");
  }
  console.log("Gate account takeover:", {
    oldUnitId: first.enterMap.unitId,
    replacementReasonCode: replacement.reasonCode,
    replacementReason: replacement.reason,
    newUnitId: second.enterMap.unitId,
  });

  await first.gate.close();
  await sleep(150);
  const third = await openGateAndEnterMap(ip, port, request);
  if (third.enterMap.unitId !== first.enterMap.unitId) {
    throw new Error("stale Gate disconnect removed the newly rebound map unit");
  }

  await second.gate.close();
  await sleep(150);
  await third.gate.close();
  await sleep(150);

    const afterDisconnect = await openGateAndEnterMap(ip, port, request);
  try {
    if (afterDisconnect.enterMap.unitId !== first.enterMap.unitId) {
      throw new Error("reconnect grace did not preserve the existing map unit");
    }
    console.log("GateSession lifecycle:", {
      reboundUnitId: first.enterMap.unitId,
      resumedUnitId: afterDisconnect.enterMap.unitId,
    });
    const currentHp = verifyNumericDefaults(
      afterDisconnect.gate,
      afterDisconnect.enterMap.unitId,
      afterDisconnect.enterMap.entities.find(
        (entity) => entity.unitId === afterDisconnect.enterMap.unitId,
      )?.numerics ?? [],
    );
    const currentState = await verifyItemChange(
      afterDisconnect.gate,
      afterDisconnect.enterMap,
      currentHp,
    );
    await verifyAuthoritativeMovement(afterDisconnect.gate, afterDisconnect.enterMap);
    return await verifyMapTransfer(
      afterDisconnect.gate,
      afterDisconnect.enterMap,
      currentState.item,
      currentState.currentHp,
      dynamicMap,
    );
  } finally {
    await afterDisconnect.gate.close();
  }
}

/** 验证同一 Gate Session 跨图后保持 UnitId 与业务状态，并使用目标地图出生点。 / Verifies that a map transfer preserves UnitId and gameplay state while applying the target-map spawn. */
async function verifyMapTransfer(
  gate: TcpRpcConnection,
  previous: ReturnType<typeof decodeEnterMapFrame>["body"],
  expectedItem: { itemId: bigint; count: number; version: number } | undefined,
  expectedMinimumHp: bigint,
  dynamicMap: MapInstanceSnapshot,
): Promise<ReturnType<typeof decodeEnterMapFrame>["body"]> {
  const queuedItem = previous.items.find((item) => item.configId === 1003);
  // 新角色出生自带小蓝，继续覆盖跨图并发UseItem；已有旧账号没有该物品时，
  // 只验证地图状态迁移，不伪造业务道具。
  // Fresh characters receive the starter mana potion, while old accounts without
  // that item still verify map-state transfer without inventing inventory state.
  if (queuedItem && expectedItem) await sleep(1_100);
  const rpcId = nextRpcId++;
  const readyFrame = gate.waitForMessage(MsgCode.G2C_MapReady);
  const responsePromise = gate.request(buildEnterMapPacket(rpcId, { mapId: 2, mapInstanceId: 0n }));
  const queuedItemRpcId = queuedItem && expectedItem ? nextRpcId++ : undefined;
  const queuedItemEvent = queuedItemRpcId === undefined
    ? undefined
    : gate.waitForMessage(MsgCode.G2C_ItemChanged);
  const queuedItemResponse = queuedItemRpcId === undefined || !queuedItem
    ? undefined
    : gate.request(buildUseItemPacket(queuedItemRpcId, {
      itemId: queuedItem.itemId,
      operationId: nextOperationId("transfer"),
    }));
  const responseFrame = await responsePromise;
  const response = decodeEnterMapFrame(responseFrame);
  const ready = decodeMapReadyFrame(await readyFrame);
  if (response.rpcId !== rpcId || response.body.error) {
    throw new Error(`Map transfer failed: ${stringifyForError(response.body)}`);
  }
  const transferred = response.body;
  const mapConfig = GameConfigs.MapConfig.Get(2);
  const itemAfter = expectedItem
    ? transferred.items.find((item) => item.itemId === expectedItem.itemId)
    : undefined;
  if (
    transferred.mapId !== 2 ||
    transferred.unitId !== previous.unitId ||
    ready.body.mapId !== 2 ||
    ready.body.unitId !== previous.unitId ||
    transferred.x !== mapConfig.spawnX ||
    transferred.y !== mapConfig.spawnY ||
    transferred.z !== mapConfig.spawnZ ||
    (expectedItem !== undefined && (
      !itemAfter ||
      itemAfter.count !== expectedItem.count ||
      itemAfter.version !== expectedItem.version
    ))
  ) {
    throw new Error(`map transfer did not preserve player state: ${stringifyForError({ previous, transferred, ready: ready.body })}`);
  }

  const afterHp = transferred.entities
    .find((entity) => entity.unitId === transferred.unitId)
    ?.numerics.find((numeric) => numeric.numericType === NumericType.CurrentHp)?.value;
  if (afterHp === undefined || afterHp < expectedMinimumHp) {
    throw new Error(
      `map transfer lost Numeric state: expected>=${expectedMinimumHp}, after=${afterHp}`,
    );
  }
  const itemResponse = queuedItemResponse ? decodeUseItemFrame(await queuedItemResponse) : undefined;
  const itemEvent = queuedItemEvent ? decodeItemChangedFrame(await queuedItemEvent) : undefined;
  if (itemResponse && queuedItem && queuedItemRpcId !== undefined && itemEvent && (
    itemResponse.rpcId !== queuedItemRpcId ||
    itemResponse.body.error ||
    itemResponse.body.item.count !== queuedItem.count - 1 ||
    itemResponse.body.globalCooldownEndAtMs <= 0n ||
    itemResponse.body.itemCooldownEndAtMs <= itemResponse.body.globalCooldownEndAtMs ||
    itemEvent.body.item.version !== itemResponse.body.item.version
  )) {
    throw new Error("queued transfer-time UseItem was not executed exactly once on the target Unit");
  }
  // 背包事件和Numeric增量是两个独立Push；只有实际恢复了HP才等待Numeric，避免把满血不变
  // 的合法行为误判成超时。
  // Inventory and Numeric are independent pushes; wait for Numeric only when the heal can
  // actually change HP, so a valid full-health use is not treated as a timeout.
  const useConfig = queuedItem ? GameConfigs.ItemConfig.Get(queuedItem.configId) : undefined;
  const restoreHp = useConfig?.useEffect === 2
    ? BigInt(useConfig.useParams[1] ?? 0)
    : 0n;
  const maxHp = BigInt(GameConfigs.PlayerConfig.Get(1).maxHp);
  const expectedQueuedHp = expectedMinimumHp + restoreHp < maxHp
    ? expectedMinimumHp + restoreHp
    : maxHp;
  const playerHpAfterQueuedItem = !itemResponse || expectedMinimumHp >= maxHp || expectedQueuedHp === expectedMinimumHp
    ? expectedMinimumHp
    : await waitForPlayerHpAtLeast(
      gate,
      transferred.unitId,
      expectedQueuedHp,
      2_000,
    );
  console.log("Map transfer:", {
    unitId: transferred.unitId,
    fromMapId: previous.mapId,
    toMapId: transferred.mapId,
    x: transferred.x,
    y: transferred.y,
    z: transferred.z,
    itemCount: itemAfter?.count,
    queuedItemCount: itemResponse?.body.item.count ?? "not-seeded",
    currentHp: playerHpAfterQueuedItem,
  });
  await verifyMonsterLifecycle(gate, transferred, playerHpAfterQueuedItem);
  const navigation = await verifyNavMeshTransfer(gate, transferred);
  return await verifyDynamicMapTransfer(gate, navigation, dynamicMap);
}

/** 验证固定刷点怪物的攻击、尸体状态和短窗口内的AOI保留。 / Verifies fixed-spawn combat, corpse state, and AOI retention during the short smoke window. */
async function verifyMonsterLifecycle(
  gate: TcpRpcConnection,
  enterMap: ReturnType<typeof decodeEnterMapFrame>["body"],
  playerCurrentHp?: bigint,
): Promise<void> {
  const monster = enterMap.entities.find(
    (entity) => entity.entityType === 2 && entity.configId === 1,
  );
  if (!monster) {
    throw new Error(`map2 snapshot did not include the training dummy: ${stringifyForError(enterMap.entities)}`);
  }
  const initialHp = monster.numerics.find((numeric) => numeric.numericType === NumericType.CurrentHp)?.value;
  const authoritativeMaxHp = monster.numerics.find((numeric) => numeric.numericType === NumericType.MaxHp)?.value;
  // 怪物Attack属于服务端/Owner私有数值，AOI旁观快照不应要求它出现。
  // Monster Attack is private to the server/owner; an AOI observer snapshot must not require it.
  const trainingDummyMaxHp = authoritativeMaxHp ?? initialHp;
  if (
    initialHp === undefined ||
    trainingDummyMaxHp === undefined ||
    initialHp !== trainingDummyMaxHp
  ) {
    throw new Error(`training dummy snapshot mismatch: ${stringifyForError({
      initialHp,
      maxHp: trainingDummyMaxHp,
    })}`);
  }
  const playerHpBeforeThreat = playerCurrentHp ?? enterMap.entities
    .find((entity) => entity.unitId === enterMap.unitId)
    ?.numerics.find((numeric) => numeric.numericType === NumericType.CurrentHp)?.value;
  const playerAttack = enterMap.entities
    .find((entity) => entity.unitId === enterMap.unitId)
    ?.numerics.find((numeric) => numeric.numericType === NumericType.Attack)?.value;
  if (playerHpBeforeThreat === undefined) {
    throw new Error("map2 snapshot did not include the player's CurrentHp");
  }
  if (playerAttack === undefined || playerAttack <= 0n) {
    throw new Error(`map2 snapshot did not include a positive player's Attack: ${playerAttack}`);
  }
  // 被动怪在没有仇恨时必须保持待机；不能因为收到一次攻击事件就直接扣玩家血。
  // A passive monster must stay idle without threat; receiving an attack event alone
  // must not make it damage the player.
  await assertNoPlayerHpChange(gate, enterMap.unitId, playerHpBeforeThreat, 700);

  // 先在同一具活怪上验证10Hz平A，再用直接攻击完成击杀；不让普通烟测等待五分钟尸体窗口。
  // Verify the 10 Hz auto attack on the same live monster first, then finish the kill
  // with direct attacks; the regular smoke test never waits for the five-minute corpse window.
  const monsterHpAfterAutoAttack = await verifyAutoAttackTimer(gate, enterMap.unitId, monster.unitId);

  if (monsterHpAfterAutoAttack <= 0n) {
    throw new Error(`training dummy HP after auto attack must be positive: ${monsterHpAfterAutoAttack}`);
  }
  const expectedHits = Number((monsterHpAfterAutoAttack + playerAttack - 1n) / playerAttack);
  let deathStateFrame: Promise<Uint8Array> | undefined;
  for (let hit = 1; hit <= expectedHits; hit += 1) {
    // 最后一击前监听死亡状态；收到alive=false后再观察尸体的短窗口保留。
    // Arm the death-state listener before the final hit, then observe the corpse
    // window after the authoritative alive=false state arrives.
    if (hit === expectedHits) {
      deathStateFrame = gate.waitForMessage(MsgCode.G2C_EntityState, 5_000);
    }
    const response = decodeAttackMonsterFrame(await gate.request(
      buildAttackMonsterPacket(nextRpcId++, { monsterId: monster.unitId }),
    ));
    const previousRemainingHp = monsterHpAfterAutoAttack - BigInt(hit - 1) * playerAttack;
    const expectedDamage = previousRemainingHp > playerAttack ? playerAttack : previousRemainingHp;
    const expectedRemainingHp = previousRemainingHp - expectedDamage > 0n
      ? previousRemainingHp - expectedDamage
      : 0n;
    if (
      response.body.error ||
      response.body.monsterId !== monster.unitId ||
      response.body.damage !== expectedDamage ||
      response.body.remainingHp !== expectedRemainingHp ||
      response.body.killed !== (hit === expectedHits)
    ) {
      throw new Error(`monster attack result mismatch: ${stringifyForError(response.body)}`);
    }
    if (hit === 1) {
      // 第一次实际伤害写入1:1仇恨后，被动怪才可以在5Hz桶攻击当前仇恨目标。
      // After the first resolved damage adds 1:1 threat, the passive monster may
      // attack its threat target on the 5Hz bucket.
      await waitForPlayerHpDecrease(gate, enterMap.unitId, playerHpBeforeThreat, 3_000);
    }
  }

  if (!deathStateFrame) {
    throw new Error("monster death listeners were not armed");
  }

  let deathState = decodeEntityStateFrame(await deathStateFrame);
  const stateDeadline = Date.now() + 5_000;
  let corpseState = deathState.body.states.find((state) => state.unitId === monster.unitId);
  while ((!corpseState || corpseState.alive) && Date.now() < stateDeadline) {
    deathState = decodeEntityStateFrame(await gate.waitForMessage(
      MsgCode.G2C_EntityState,
      Math.max(1, stateDeadline - Date.now()),
    ));
    corpseState = deathState.body.states.find((state) => state.unitId === monster.unitId);
  }
  if (!corpseState || corpseState.alive) {
    throw new Error(`monster death did not retain an alive=false corpse: ${stringifyForError(deathState.body)}`);
  }

  // 有掉落的尸体默认保留五分钟；普通烟测只需确认2秒内没有错误的AOI Leave。
  // A corpse with loot stays for five minutes; the regular smoke test only needs
  // to prove that no premature AOI Leave is emitted within two seconds.
  const earlyLeaveDeadline = Date.now() + 2_000;
  while (Date.now() < earlyLeaveDeadline) {
    try {
      const deathDelta = decodeAoiDeltaFrame(await gate.waitForMessage(
        MsgCode.G2C_AoiDelta,
        Math.max(1, earlyLeaveDeadline - Date.now()),
      ));
      if (deathDelta.body.leaves.includes(monster.unitId)) {
        throw new Error(`monster corpse left AOI before its loot window: ${stringifyForError(deathDelta.body)}`);
      }
    } catch (error) {
      if (error instanceof Error && /timed out/i.test(error.message)) break;
      throw error;
    }
  }
  console.log("Monster lifecycle:", {
    initialMonsterId: monster.unitId,
    killedMonsterId: monster.unitId,
    corpseAlive: corpseState.alive,
    corpseWindow: "5m-with-loot",
    earlyLeave: false,
  });
}

/** 确认一段时间内指定玩家的HP没有被被动怪误扣。 / Confirms that a player's HP is not changed by a passive monster during a quiet window. */
async function assertNoPlayerHpChange(
  gate: TcpRpcConnection,
  playerUnitId: number,
  currentHp: bigint,
  durationMs: number,
): Promise<void> {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    try {
      const frame = decodeEntityNumericFrame(await gate.waitForMessage(
        MsgCode.G2C_EntityNumeric,
        Math.max(1, deadline - Date.now()),
      ));
      const changed = frame.body.numerics.find(
        (numeric) => numeric.unitId === playerUnitId &&
          numeric.numericType === NumericType.CurrentHp &&
          numeric.value !== currentHp,
      );
      if (changed) {
        throw new Error(`passive monster changed player HP without threat: ${changed.value}`);
      }
    } catch (error) {
      if (error instanceof Error && /timed out/i.test(error.message)) return;
      throw error;
    }
  }
}

/** 等待实际仇恨产生后的玩家掉血；只接受服务端Numeric增量，不猜测AI内部状态。 / Waits for player damage after real threat is created, using only authoritative Numeric deltas. */
async function waitForPlayerHpDecrease(
  gate: TcpRpcConnection,
  playerUnitId: number,
  previousHp: bigint,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = decodeEntityNumericFrame(await gate.waitForMessage(
      MsgCode.G2C_EntityNumeric,
      Math.max(1, deadline - Date.now()),
    ));
    const changed = frame.body.numerics.find(
      (numeric) => numeric.unitId === playerUnitId &&
        numeric.numericType === NumericType.CurrentHp &&
        numeric.value < previousHp,
    );
    if (changed) return;
  }
  throw new Error("passive monster did not attack after threat was added");
}

/** 等待玩家收到至少目标HP的权威增量；用于先排空传送期间排队的恢复道具。 / Waits for an authoritative player HP delta at or above a target, draining queued transfer-time heals first. */
async function waitForPlayerHpAtLeast(
  gate: TcpRpcConnection,
  playerUnitId: number,
  minimumHp: bigint,
  timeoutMs: number,
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = decodeEntityNumericFrame(await gate.waitForMessage(
      MsgCode.G2C_EntityNumeric,
      Math.max(1, deadline - Date.now()),
    ));
    const changed = frame.body.numerics.find(
      (numeric) => numeric.unitId === playerUnitId &&
        numeric.numericType === NumericType.CurrentHp &&
        numeric.value >= minimumHp,
    );
    if (changed) return changed.value;
  }
  throw new Error(`player HP update did not reach ${minimumHp}`);
}

/** 真实推进多轮平A；验证不是只收到一次状态，而是10Hz桶持续结算到Numeric。 / Advances several real auto-attack swings and verifies that the 10Hz bucket keeps resolving Numeric damage instead of stopping after one state. */
async function verifyAutoAttackTimer(
  gate: TcpRpcConnection,
  playerUnitId: number,
  monsterUnitId: number,
): Promise<bigint> {
  // Map 2的训练木桩在玩家出生点正东；先用Grid移动让权威Yaw转向+X，再停在1米距离。
  // The map-2 dummy is one cell east after one step; turn the authoritative yaw to +X first.
  await gate.send(buildMovePacket({ inputX: 1, inputZ: 0, sequence: 4 }));
  // 等一个固定Tick再停，避免等待确认包时已经自动跨过第二个Cell。
  // Stop after one fixed tick instead of waiting for an acknowledgement that
  // may arrive after the movement loop has already started the next cell.
  await sleep(60);
  await gate.send(buildMovePacket({ inputX: 0, inputZ: 0, sequence: 5 }));
  await waitForMovementStopped(gate, playerUnitId, 5);

  const statePush = gate.waitForMessage(MsgCode.G2C_AutoAttackState, 5_000);
  const enabledRpcId = nextRpcId++;
  const enabled = decodeToggleAutoAttackFrame(await gate.request(
    buildToggleAutoAttackPacket(enabledRpcId, {
      enabled: true,
      targetUnitId: monsterUnitId,
    }),
  ));
  const pushedState = decodeAutoAttackStateFrame(await statePush);
  if (
    enabled.rpcId !== enabledRpcId ||
    enabled.body.error ||
    !enabled.body.enabled ||
    !pushedState.body.enabled ||
    pushedState.body.targetUnitId !== monsterUnitId
  ) {
    throw new Error(`auto attack did not activate: ${stringifyForError({ enabled: enabled.body, pushed: pushedState.body })}`);
  }
  const expectedSwings = 6;
  const hpValues: bigint[] = [];
  let previousHp: bigint | undefined;
  // 默认玩家平A间隔为2秒，10Hz战斗桶还会带来最多一个桶的调度误差；
  // 伤害结果走目标/攻击者私有CombatResult，不再等待旁观者1Hz CurrentHp。
  // The default player swing interval is two seconds and the 10Hz combat bucket
  // adds one scheduling step. Damage is observed through the private
  // target/attacker CombatResult rather than the bystander 1 Hz CurrentHp stream.
  const deadline = Date.now() + 20_000;
  while (hpValues.length < expectedSwings && Date.now() < deadline) {
    const result = decodeCombatResultFrame(await gate.waitForMessage(
      MsgCode.G2C_CombatResult,
      Math.max(1, deadline - Date.now()),
    )).body;
    if (result.resultType !== 1 || result.targetUnitId !== monsterUnitId || result.abilityId !== 0) continue;
    const hp = result.currentHp;
    if (hp !== undefined && previousHp !== undefined && hp < previousHp) {
      hpValues.push(hp);
    }
    previousHp = hp;
  }

  const disabledState = gate.waitForMessage(MsgCode.G2C_AutoAttackState, 5_000);
  const disabledRpcId = nextRpcId++;
  const disabled = decodeToggleAutoAttackFrame(await gate.request(
    buildToggleAutoAttackPacket(disabledRpcId, {
      enabled: false,
      targetUnitId: monsterUnitId,
    }),
  ));
  await disabledState;
  if (hpValues.length < expectedSwings || disabled.rpcId !== disabledRpcId || disabled.body.error || disabled.body.enabled) {
    throw new Error(`auto attack timer stopped before ${expectedSwings} swings: ${stringifyForError({ hpValues, disabled: disabled.body })}`);
  }
  console.log("Auto-attack timer:", { playerUnitId, monsterUnitId, hpValues });
  return hpValues[hpValues.length - 1];
}

/** 验证真实玩家可进入NavMesh3D地图，并收到与冷配置一致的空间资源契约。 / Verifies that a real player can enter a NavMesh3D map with the cold-configured spatial asset contract. */
async function verifyNavMeshTransfer(
  gate: TcpRpcConnection,
  previous: ReturnType<typeof decodeEnterMapFrame>["body"],
): Promise<ReturnType<typeof decodeEnterMapFrame>["body"]> {
  const mapConfig = GameConfigs.MapConfig.Get(100);
  const rpcId = nextRpcId++;
  const readyFrame = gate.waitForMessage(MsgCode.G2C_MapReady);
  const responseFrame = await gate.request(
    buildEnterMapPacket(rpcId, { mapId: mapConfig.id, mapInstanceId: 0n }),
  );
  const response = decodeEnterMapFrame(responseFrame);
  const ready = decodeMapReadyFrame(await readyFrame);
  const transferred = response.body;
  const navMeshMonsters = transferred.entities
    .filter((entity) => entity.entityType === 2)
    .map((entity) => ({ unitId: entity.unitId, configId: entity.configId }));
  const starterNpcs = transferred.entities
    .filter((entity) => entity.entityType === 3)
    .map((entity) => ({ unitId: entity.unitId, configId: entity.configId }));
  console.log("NavMesh3D monsters:", navMeshMonsters);
  console.log("Starter NPCs:", starterNpcs);
  // Demo地图100使用宽视野，出生点会收到五个初始怪物；配置完整性仍由game_config_self_test校验。
  // Demo Map 100 uses the wider view and receives all five initial monsters; game_config_self_test verifies the slots.
  if (
    navMeshMonsters.length === 0 ||
    navMeshMonsters.some((monster) => monster.configId !== 1 && monster.configId !== 2)
  ) {
    throw new Error(`Map 100 monster snapshot mismatch: ${stringifyForError(navMeshMonsters)}`);
  }
  const starterNpc = starterNpcs.find((npc) => npc.configId === 9001);
  const starterNpcConfigIds = starterNpcs
    .map((npc) => npc.configId)
    .sort((left, right) => left - right);
  if (
    !starterNpc ||
    starterNpcConfigIds.length !== 2 ||
    starterNpcConfigIds[0] !== 9001 ||
    starterNpcConfigIds[1] !== 9002
  ) {
    throw new Error(`Map 100 Starter NPC snapshot mismatch: ${stringifyForError(starterNpcs)}`);
  }
  if (transferred.quests.length !== 0) {
    throw new Error(`Map 100 player should have no default quests before NPC interaction: ${stringifyForError(transferred.quests)}`);
  }
  const acceptQuestRpcId = nextRpcId++;
  const acceptedQuest = decodeAcceptQuestFrame(await gate.request(buildAcceptQuestPacket(
    acceptQuestRpcId,
    { questConfigId: 5001, npcUnitId: starterNpc.unitId },
  )));
  if (
    acceptedQuest.rpcId !== acceptQuestRpcId ||
    acceptedQuest.body.error ||
    acceptedQuest.body.quest.questConfigId !== 5001
  ) {
    throw new Error(`Starter NPC quest acceptance failed: ${stringifyForError(acceptedQuest.body)}`);
  }
  const finitePosition = [transferred.x, transferred.y, transferred.z].every(Number.isFinite);
  const nearConfiguredSpawn =
    Math.abs(transferred.x - mapConfig.spawnX) <= 0.5 &&
    Math.abs(transferred.z - mapConfig.spawnZ) <= 0.5;
  const insideGrayboxObstacle =
    Math.abs(transferred.x) <= 3 &&
    Math.abs(transferred.z) <= 5 &&
    transferred.y < 3;
  if (
    response.rpcId !== rpcId ||
    transferred.error ||
    transferred.mapId !== mapConfig.id ||
    transferred.unitId !== previous.unitId ||
    transferred.spatialMode !== SpatialMode.NavMesh3D ||
    transferred.navigationVersion !== mapConfig.navigationVersion ||
    transferred.navigationHash !== mapConfig.navigationHash ||
    ready.body.mapId !== mapConfig.id ||
    ready.body.unitId !== previous.unitId ||
    !finitePosition ||
    !nearConfiguredSpawn ||
    insideGrayboxObstacle
  ) {
    throw new Error(
      `NavMesh3D transfer contract mismatch: ${stringifyForError({ transferred, ready: ready.body, mapConfig })}`,
    );
  }
  const pathRpcId = nextRpcId++;
  const pathResponse = decodeFindPathFrame(await gate.request(buildFindPathPacket(pathRpcId, {
    startX: transferred.x,
    startY: transferred.y,
    startZ: transferred.z,
    targetX: 10,
    targetY: 0,
    targetZ: 10,
  })));
  if (
    pathResponse.rpcId !== pathRpcId ||
    pathResponse.body.error ||
    pathResponse.body.points.length < 2 ||
    pathResponse.body.points.some((point) => ![point.x, point.y, point.z].every(Number.isFinite))
  ) {
    throw new Error(`NavMesh3D path query failed: ${stringifyForError(pathResponse.body)}`);
  }
  await verifyDynamicNavigationDoor(gate);
  const navigationPush = waitForNavigationProgress(
    gate,
    transferred.unitId,
    1,
    transferred.x,
    transferred.z,
  );
  const navigateRpcId = nextRpcId++;
  const navigateResponse = decodeNavigateToFrame(await gate.request(buildNavigateToPacket(
    navigateRpcId,
    { targetX: 10, targetY: 0, targetZ: 10, sequence: 1 },
  )));
  const movement = await navigationPush;
  if (
    navigateResponse.rpcId !== navigateRpcId ||
    navigateResponse.body.error ||
    navigateResponse.body.acknowledgedSequence !== 1 ||
    navigateResponse.body.points.length < 2 ||
    movement.acknowledgedSequence !== 1 ||
    !movement.moving ||
    (movement.x === transferred.x && movement.z === transferred.z)
  ) {
    throw new Error(`NavMesh3D authoritative movement failed: ${stringifyForError({
      navigate: navigateResponse.body,
      movement,
    })}`);
  }
  const directionRpcId = nextRpcId++;
  const directionPush = waitForNavigationState(gate, transferred.unitId, 2, true);
  const direction = decodeNavigateInputFrame(await gate.request(buildNavigateInputPacket(
    directionRpcId,
    { forward: 1, strafe: 0, yaw: Math.PI / 2, sequence: 2 },
  )));
  const directionMovement = await directionPush;
  const stopRpcId = nextRpcId++;
  const stopPush = waitForNavigationState(gate, transferred.unitId, 3, false);
  const stop = decodeNavigateInputFrame(await gate.request(buildNavigateInputPacket(
    stopRpcId,
    { forward: 0, strafe: 0, yaw: Math.PI / 2, sequence: 3 },
  )));
  const stoppedMovement = await stopPush;
  if (
    direction.rpcId !== directionRpcId ||
    direction.body.error ||
    direction.body.acknowledgedSequence !== 2 ||
    direction.body.points.length !== 0 ||
    directionMovement.x <= movement.x ||
    Math.abs(directionMovement.yaw - Math.PI / 2) > 0.001 ||
    stop.rpcId !== stopRpcId ||
    stop.body.error ||
    stop.body.acknowledgedSequence !== 3 ||
    stoppedMovement.x < directionMovement.x
  ) {
    throw new Error(`NavMesh3D direction input failed: ${stringifyForError({
      direction: direction.body,
      directionMovement,
      stop: stop.body,
      stoppedMovement,
    })}`);
  }
  console.log("NavMesh3D transfer:", {
    unitId: transferred.unitId,
    mapId: transferred.mapId,
    position: [transferred.x, transferred.y, transferred.z],
    navigationVersion: transferred.navigationVersion,
    navigationHash: transferred.navigationHash,
    pathPoints: pathResponse.body.points.length,
    authoritativePosition: [movement.x, movement.y, movement.z],
  });
  return transferred;
}

/** 通过正式Map Actor RPC验证开关门会改变Rust TileCache路径，并在开门后恢复。 / Verifies through the real Map Actor RPC that a door changes and then restores the Rust TileCache path. */
async function verifyDynamicNavigationDoor(gate: TcpRpcConnection): Promise<void> {
  const queryDoorPath = async () => {
    const rpcId = nextRpcId++;
    return decodeFindPathFrame(await gate.request(buildFindPathPacket(rpcId, {
      startX: -12,
      startY: 0,
      startZ: -12,
      targetX: -12,
      targetY: 0,
      targetZ: 12,
    }))).body.points;
  };
  const openPath = await queryDoorPath();
  const closeRpcId = nextRpcId++;
  const closed = decodeToggleDemoDoorFrame(await gate.request(
    buildToggleDemoDoorPacket(closeRpcId, { closed: true }),
  ));
  if (closed.body.error || !closed.body.closed) {
    throw new Error(`dynamic door close failed: ${stringifyForError(closed.body)}`);
  }
  let closedPath = openPath;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(50);
    closedPath = await queryDoorPath();
    if (closedPath.some((point) => Math.abs(point.x + 12) > 4)) break;
  }
  if (!closedPath.some((point) => Math.abs(point.x + 12) > 4)) {
    throw new Error(`dynamic door did not force a detour: ${stringifyForError(closedPath)}`);
  }

  const openRpcId = nextRpcId++;
  const opened = decodeToggleDemoDoorFrame(await gate.request(
    buildToggleDemoDoorPacket(openRpcId, { closed: false }),
  ));
  if (opened.body.error || opened.body.closed) {
    throw new Error(`dynamic door open failed: ${stringifyForError(opened.body)}`);
  }
  let restoredPath = closedPath;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(50);
    restoredPath = await queryDoorPath();
    if (!restoredPath.some((point) => Math.abs(point.x + 12) > 4)) break;
  }
  if (restoredPath.some((point) => Math.abs(point.x + 12) > 4)) {
    throw new Error(`dynamic door did not restore the open path: ${stringifyForError(restoredPath)}`);
  }
  console.log("NavMesh3D dynamic door:", {
    openPoints: openPath.length,
    closedPoints: closedPath.length,
    restoredPoints: restoredPath.length,
  });
}

/** 跳过刚接受路径时仍位于起点的合法Push，等待权威位置真正沿路径推进。 / Skips the valid path-start push and waits for authoritative position progress. */
async function waitForNavigationProgress(
  gate: TcpRpcConnection,
  unitId: number,
  sequence: number,
  startX: number,
  startZ: number,
): Promise<ReturnType<typeof decodeEntityNavigateFrame>["body"]["movements"][number]> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const message = decodeEntityNavigateFrame(await gate.waitForMessage(MsgCode.G2C_EntityNavigate));
    const movement = message.body.movements.find((candidate) =>
      candidate.unitId === unitId &&
      candidate.acknowledgedSequence >= sequence &&
      candidate.moving &&
      (Math.abs(candidate.x - startX) > 0.001 || Math.abs(candidate.z - startZ) > 0.001)
    );
    if (movement) return movement;
  }
  throw new Error(`navigation progress not observed: unit=${unitId} sequence=${sequence}`);
}

async function waitForNavigationState(
  gate: TcpRpcConnection,
  unitId: number,
  sequence: number,
  moving: boolean,
): Promise<ReturnType<typeof decodeEntityNavigateFrame>["body"]["movements"][number]> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const message = decodeEntityNavigateFrame(await gate.waitForMessage(MsgCode.G2C_EntityNavigate));
    const movement = message.body.movements.find((candidate) =>
      candidate.unitId === unitId &&
      candidate.acknowledgedSequence >= sequence &&
      candidate.moving === moving
    );
    if (movement) return movement;
  }
  throw new Error(`navigation state not observed: unit=${unitId} sequence=${sequence} moving=${moving}`);
}

/** 仅供测试错误输出安全显示bigint协议字段。 / Safely renders bigint protocol fields for test failures only. */
function stringifyForError(value: unknown): string {
  return JSON.stringify(value, (_key, field) =>
    typeof field === "bigint" ? field.toString() : field
  );
}

/** 验证目标MapHost完全不在Gate静态目录时，仍可通过Location携带的Endpoint完成传送。 / Verifies transfer through a Location endpoint when the target MapHost is absent from Gate's static directory. */
async function verifyDynamicMapTransfer(
  gate: TcpRpcConnection,
  previous: ReturnType<typeof decodeEnterMapFrame>["body"],
  dynamicMap: MapInstanceSnapshot,
): Promise<ReturnType<typeof decodeEnterMapFrame>["body"]> {
  const rpcId = nextRpcId++;
  const readyFrame = gate.waitForMessage(MsgCode.G2C_MapReady);
  const responseFrame = await gate.request(buildEnterMapPacket(rpcId, {
    mapId: 0,
    mapInstanceId: dynamicMap.mapInstanceId,
  }));
  const response = decodeEnterMapFrame(responseFrame);
  const ready = decodeMapReadyFrame(await readyFrame);
  if (
    response.rpcId !== rpcId ||
    response.body.error ||
    response.body.mapInstanceId !== dynamicMap.mapInstanceId ||
    response.body.mapId !== dynamicMap.mapConfigId ||
    response.body.unitId !== previous.unitId ||
    ready.body.unitId !== previous.unitId
  ) {
    throw new Error(`dynamic MapHost transfer failed: ${JSON.stringify(response.body)}`);
  }
  console.log("Dynamic MapHost transfer:", {
    unitId: response.body.unitId,
    mapInstanceId: response.body.mapInstanceId,
    mapHostName: dynamicMap.mapHostName,
    mapHostPort: dynamicMap.mapHost.port,
  });
  return response.body;
}

async function verifyItemChange(
  gate: TcpRpcConnection,
  enterMap: {
    unitId: number;
    items: readonly { itemId: bigint; configId: number; count: number; version: number }[];
  },
  previousHp: bigint,
) {
  const initial = enterMap.items.find((item) => item.configId === 1001);
  if (!initial) {
    console.log("Immediate item event: skipped (account has no positive small-potion stack)");
    return { item: undefined, currentHp: previousHp };
  }
  const itemConfig = GameConfigs.ItemConfig.Get(initial.configId);
  const maxHp = BigInt(GameConfigs.PlayerConfig.Get(1).maxHp);
  const restoredHp = itemConfig.useEffect === 2
    ? previousHp + BigInt(itemConfig.useParams[1] ?? 0)
    : previousHp;
  const expectedHp = restoredHp < maxHp ? restoredHp : maxHp;
  const pushed = gate.waitForMessage(MsgCode.G2C_ItemChanged);
  const responseFrame = await gate.request(
    buildUseItemPacket(nextRpcId++, {
      itemId: initial.itemId,
      operationId: nextOperationId("buff"),
    }),
  );
  const useItemResponse = decodeUseItemFrame(responseFrame).body;
  const response = useItemResponse.item;
  const event = decodeItemChangedFrame(await pushed).body.item;
  const expectedCount = initial.count - 1;
  if (response.count !== expectedCount || event.count !== expectedCount || response.version !== event.version) {
    throw new Error("immediate item response and event are inconsistent");
  }
  if (
    useItemResponse.globalCooldownEndAtMs <= 0n ||
    useItemResponse.itemCooldownEndAtMs <= useItemResponse.globalCooldownEndAtMs
  ) {
    throw new Error("item use response did not return authoritative GCD/CD deadlines");
  }

  // 满血使用恢复道具不会修改 Numeric，也就不会产生 G2C_EntityNumeric。
  // A full-health item use does not dirty Numeric, so no G2C_EntityNumeric is expected.
  if (previousHp >= maxHp) {
    console.log("Immediate item event:", {
      itemId: event.itemId,
      count: event.count,
      version: event.version,
      currentHp: previousHp,
      numericChanged: false,
    });
    return { item: response, currentHp: previousHp };
  }

  let numericPushed = gate.waitForMessage(MsgCode.G2C_EntityNumeric);
  const deadline = Date.now() + 2_000;
  let currentHp: bigint | undefined;
  while (Date.now() < deadline) {
    const frame = await numericPushed;
    currentHp = decodeEntityNumericFrame(frame).body.numerics.find(
      (numeric) => numeric.unitId === enterMap.unitId && numeric.numericType === NumericType.CurrentHp,
    )?.value;
    if (currentHp !== undefined && currentHp >= expectedHp) break;
    numericPushed = gate.waitForMessage(
      MsgCode.G2C_EntityNumeric,
      Math.max(1, deadline - Date.now()),
    );
  }
  if (currentHp === undefined || currentHp < expectedHp || currentHp > maxHp) {
    throw new Error(
      `health potion did not produce the expected Numeric delta: expected>=${expectedHp}, actual=${currentHp}`,
    );
  }
  console.log("Immediate item event:", {
    itemId: event.itemId,
    count: event.count,
    version: event.version,
    currentHp,
  });
  return { item: response, currentHp };
}

function verifyNumericDefaults(
  _gate: TcpRpcConnection,
  unitId: number,
  initialNumerics: readonly { numericType: number; value: bigint }[],
  _initialFrame?: Uint8Array,
): bigint {
  const playerConfig = GameConfigs.PlayerConfig.Get(1);
  const currentHp = initialNumerics.find((numeric) => numeric.numericType === NumericType.CurrentHp)?.value;
  const maxHp = initialNumerics.find((numeric) => numeric.numericType === NumericType.MaxHp)?.value;
  const currentMp = initialNumerics.find((numeric) => numeric.numericType === NumericType.CurrentMp)?.value;
  const maxMp = initialNumerics.find((numeric) => numeric.numericType === NumericType.MaxMp)?.value;
  const attack = initialNumerics.find((numeric) => numeric.numericType === NumericType.Attack)?.value;
  if (
    currentHp !== BigInt(playerConfig.initialHp) ||
    maxHp !== BigInt(playerConfig.maxHp) ||
    currentMp !== BigInt(playerConfig.initialMp) ||
    maxMp !== BigInt(playerConfig.maxMp) ||
    attack !== 10n
  ) {
    throw new Error(
      `enter-map snapshot is missing Numeric defaults: unit ${unitId}, numerics=${initialNumerics.map((numeric) => `${numeric.numericType}=${numeric.value}`).join(",")}`,
    );
  }
  console.log("Numeric defaults:", { unitId, currentHp, maxHp, currentMp, maxMp, attack });
  return currentHp;
}

async function verifyAuthoritativeMovement(
  gate: TcpRpcConnection,
  player: { unitId: number; x: number; y: number; z: number },
): Promise<void> {
  await gate.send(buildMovePacket({ inputX: 1, inputZ: 0, sequence: 1 }));
  const first = await waitForMovementSequence(gate, player.unitId, 1);
  if (
    first.unitId !== player.unitId ||
    first.acknowledgedSequence !== 1 ||
    !first.moving ||
    first.toCellX !== first.fromCellX + 1 ||
    first.toCellZ !== first.fromCellZ
  ) {
    throw new Error(`unexpected first authoritative move: ${JSON.stringify(first)}`);
  }

  await sleep(60);
  await gate.send(buildMovePacket({ inputX: 1, inputZ: 0, sequence: 2 }));
  const second = await waitForMovementSequence(gate, player.unitId, 2);
  if (
    second.acknowledgedSequence !== 2 ||
    !second.moving ||
    second.toCellX !== second.fromCellX + 1 ||
    second.toCellZ !== second.fromCellZ ||
    second.fromCellX < first.fromCellX
  ) {
    throw new Error(`unexpected second authoritative move: ${JSON.stringify(second)}`);
  }

  await gate.send(buildMovePacket({ inputX: 0, inputZ: 0, sequence: 3 }));
  const stopped = await waitForMovementSequence(gate, player.unitId, 3);
  if (
    stopped.acknowledgedSequence !== 3 ||
    (stopped.moving && stopped.toCellX !== stopped.fromCellX + 1)
  ) {
    throw new Error(`unexpected authoritative stop: ${JSON.stringify(stopped)}`);
  }

  // 重复序号不会改变输入；移动中的周期快照仍可能正常到达，不能用“无下行包”判断。
  await gate.send(buildMovePacket({ inputX: 0, inputZ: 0, sequence: 3 }));
  console.log("Authoritative Cell movement:", { first, second, stopped });
}

async function waitForMovementSequence(
  gate: TcpRpcConnection,
  unitId: number,
  sequence: number,
): Promise<TimedMovementState> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const body = decodeEntityMoveFrame(
      await gate.waitForMessage(MsgCode.G2C_EntityMove, remaining),
    ).body;
    const movement = body.movements.find((candidate) => candidate.unitId === unitId);
    if (!movement) continue;
    // 移动中会夹杂周期权威快照，测试应等待目标输入被确认，而不是假定下一包必然对应它。
    if (movement.acknowledgedSequence === sequence) {
      return { ...movement, serverTick: body.serverTick };
    }
    if (movement.acknowledgedSequence > sequence) {
      throw new Error(
        `movement sequence skipped ${sequence}: ${JSON.stringify(movement)}`,
      );
    }
  }
  throw new Error(`timed out waiting for movement sequence ${sequence}`);
}

/** 等待当前Cell移动完成；停止输入只阻止下一格，不会取消已经开始的这一格。 / Waits for the current Cell step to finish; a stop input prevents the next step but does not cancel the current one. */
async function waitForMovementStopped(
  gate: TcpRpcConnection,
  unitId: number,
  sequence: number,
): Promise<TimedMovementState> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const body = decodeEntityMoveFrame(
      await gate.waitForMessage(MsgCode.G2C_EntityMove, remaining),
    ).body;
    const movement = body.movements.find((candidate) => candidate.unitId === unitId);
    if (!movement || movement.acknowledgedSequence < sequence) continue;
    if (!movement.moving) return { ...movement, serverTick: body.serverTick };
  }
  throw new Error(`timed out waiting for movement to stop at sequence ${sequence}`);
}

async function verifySharedMapBroadcast(
  ip: string,
  port: number,
  moverRequest: { account: string; token: string; mapId: number },
  observerRequest: { account: string; token: string; mapId: number },
): Promise<void> {
  const mover = await openGateAndEnterMap(ip, port, moverRequest);
  const enterFrame = mover.gate.waitForMessage(MsgCode.G2C_AoiDelta);
  const observer = await openGateAndEnterMap(ip, port, observerRequest);
  let observerClosed = false;
  try {
    const entered = decodeAoiDeltaFrame(await enterFrame).body.enters.find(
      (entity) => entity.unitId === observer.enterMap.unitId,
    );
    const snapshotIds = observer.enterMap.entities
      .map((entity) => entity.unitId)
      .sort((left, right) => left - right);
    const monsterIds = mover.enterMap.entities
      .filter((entity) => entity.entityType === 2)
      .map((entity) => entity.unitId);
    const expectedIds = [mover.enterMap.unitId, observer.enterMap.unitId, ...monsterIds].sort(
      (left, right) => left - right,
    );
    if (
      !entered ||
      entered.account !== observerRequest.account ||
      snapshotIds.length !== expectedIds.length ||
      snapshotIds.some((unitId, index) => unitId !== expectedIds[index])
    ) {
      throw new Error(
        `entity enter/snapshot mismatch: ${stringifyForError({ entered, snapshotIds, expectedIds })}`,
      );
    }

    const moverFrame = mover.gate.waitForMessage(MsgCode.G2C_EntityMove);
    const observerFrame = observer.gate.waitForMessage(MsgCode.G2C_EntityMove);
    await mover.gate.send(
      buildMovePacket({ inputX: 0, inputZ: 1, sequence: 1 }),
    );
    const [moverPush, observerPush] = await Promise.all([
      moverFrame.then(decodeEntityMoveFrame),
      observerFrame.then(decodeEntityMoveFrame),
    ]);
    const moverState = moverPush.body.movements.find(
      (movement) => movement.unitId === mover.enterMap.unitId,
    );
    const observerState = observerPush.body.movements.find(
      (movement) => movement.unitId === mover.enterMap.unitId,
    );
    if (
      !moverState ||
      !observerState ||
      JSON.stringify(moverState) !== JSON.stringify(observerState)
    ) {
      throw new Error(
        `shared map broadcast mismatch: ${JSON.stringify({ moverPush, observerPush })}`,
      );
    }
    console.log("Shared map movement broadcast:", {
      moverUnitId: mover.enterMap.unitId,
      observerUnitId: observer.enterMap.unitId,
      movement: observerState,
    });

    // Demo使用15米AOI Grid和5x5 Detach；持续移动直到真正越过迟滞外圈。
    const leaveFrame = observer.gate.waitForMessage(MsgCode.G2C_AoiDelta, 8000);
    await mover.gate.send(
      buildMovePacket({ inputX: 0, inputZ: 1, sequence: 2 }),
    );
    const left = decodeAoiDeltaFrame(await leaveFrame).body;
    if (!left.leaves.includes(mover.enterMap.unitId)) {
      throw new Error(`AOI leave contains the wrong Unit: ${JSON.stringify(left)}`);
    }
    await mover.gate.send(
      buildMovePacket({ inputX: 0, inputZ: 0, sequence: 3 }),
    );
    await waitForMovementSequence(mover.gate, mover.enterMap.unitId, 3);
    await assertNoMovementSequenceAtLeast(
      observer.gate,
      mover.enterMap.unitId,
      3,
      500,
    );

    // 返回时只有进入3x3 Enter范围才重新建立关系，不能在Detach外圈提前Enter。
    const reenterFrame = observer.gate.waitForMessage(MsgCode.G2C_AoiDelta, 5000);
    await mover.gate.send(
      buildMovePacket({ inputX: 0, inputZ: -1, sequence: 4 }),
    );
    const reentered = decodeAoiDeltaFrame(await reenterFrame).body.enters.find(
      (entity) => entity.unitId === mover.enterMap.unitId,
    );
    if (!reentered) {
      throw new Error(`AOI reenter contains the wrong Unit: ${JSON.stringify(reentered)}`);
    }
    await mover.gate.send(
      buildMovePacket({ inputX: 0, inputZ: 0, sequence: 5 }),
    );
    console.log("Shared map AOI boundary:", {
      leftUnitId: mover.enterMap.unitId,
      reenteredUnitId: reentered.unitId,
    });

    const moverNav = await transferConnectedPlayer(mover.gate, 100);
    const observerNav = await transferConnectedPlayer(observer.gate, 100);
    // Map 100中的怪物也会广播导航状态，不能假设下一帧一定属于测试玩家。
    // Monsters on Map 100 also publish navigation, so select by player and sequence.
    const moverNavigationState = waitForNavigationState(
      mover.gate,
      moverNav.unitId,
      1,
      true,
    );
    const observerNavigationState = waitForNavigationState(
      observer.gate,
      moverNav.unitId,
      1,
      true,
    );
    const navigateRpcId = nextRpcId++;
    const navigate = decodeNavigateToFrame(await mover.gate.request(buildNavigateToPacket(
      navigateRpcId,
      { targetX: 10, targetY: 0, targetZ: 10, sequence: 1 },
    )));
    const [moverNavState, observerNavState] = await Promise.all([
      moverNavigationState,
      observerNavigationState,
    ]);
    if (
      navigate.body.error ||
      navigate.body.acknowledgedSequence !== 1 ||
      !moverNavState ||
      !observerNavState ||
      JSON.stringify(moverNavState) !== JSON.stringify(observerNavState)
    ) {
      throw new Error(`shared NavMesh movement mismatch: ${stringifyForError({
        navigate: navigate.body,
        moverNavState,
        observerNavState,
      })}`);
    }
    console.log("Shared NavMesh movement broadcast:", {
      moverUnitId: moverNav.unitId,
      observerUnitId: observerNav.unitId,
      movement: observerNavState,
    });

    await observer.gate.close();
    observerClosed = true;
    console.log("Shared map reconnect grace:", {
      snapshotIds,
      enteredUnitId: entered.unitId,
      retainedUnitId: observer.enterMap.unitId,
    });
  } finally {
    await Promise.all([
      mover.gate.close(),
      observerClosed ? Promise.resolve() : observer.gate.close(),
    ]);
  }
}

async function transferConnectedPlayer(
  gate: TcpRpcConnection,
  mapId: number,
): Promise<ReturnType<typeof decodeEnterMapFrame>["body"]> {
  const rpcId = nextRpcId++;
  const readyFrame = gate.waitForMessage(MsgCode.G2C_MapReady);
  const response = decodeEnterMapFrame(await gate.request(
    buildEnterMapPacket(rpcId, { mapId, mapInstanceId: 0n }),
  ));
  const ready = decodeMapReadyFrame(await readyFrame);
  if (
    response.body.error ||
    response.body.mapId !== mapId ||
    ready.body.mapId !== mapId ||
    ready.body.unitId !== response.body.unitId
  ) {
    throw new Error(`connected transfer failed: ${stringifyForError({ response, ready })}`);
  }
  const snapshotRpcId = nextRpcId++;
  const snapshot = decodeMapSnapshotReadyFrame(await gate.request(
    buildMapSnapshotReadyPacket(snapshotRpcId, { unitId: response.body.unitId }),
  ));
  if (snapshot.body.error) {
    throw new Error(`connected snapshot ready failed: ${stringifyForError(snapshot.body)}`);
  }
  return response.body;
}

async function assertNoMovementSequenceAtLeast(
  gate: TcpRpcConnection,
  unitId: number,
  minimumSequence: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = Math.max(1, deadline - Date.now());
    try {
      const frame = await gate.waitForMessage(MsgCode.G2C_EntityMove, remaining);
      const movement = decodeEntityMoveFrame(frame).body.movements.find(
        (candidate) => candidate.unitId === unitId,
      );
      if (movement && movement.acknowledgedSequence >= minimumSequence) {
        throw new Error(
          `observer outside AOI received mover sequence ${movement.acknowledgedSequence}`,
        );
      }
    } catch (error) {
      if (error instanceof Error && /timed out/i.test(error.message)) return;
      throw error;
    }
    if (Date.now() >= deadline) return;
  }
}

async function openGateAndEnterMap(
  ip: string,
  port: number,
  request: { account: string; token: string; mapId: number },
): Promise<{
  gate: TcpRpcConnection;
  enterMap: ReturnType<typeof decodeEnterMapFrame>["body"];
}> {
  const gate = new TcpRpcConnection(ip, port);
  try {
    const loginGateRpcId = nextRpcId++;
    const loginGateFrame = await gate.request(
      buildLoginGatePacket(loginGateRpcId, {
        account: request.account,
        token: request.token,
      }),
    );
    const loginGate = decodeLoginGateFrame(loginGateFrame);
    if (loginGate.rpcId !== loginGateRpcId || loginGate.body.error) {
      throw new Error(`LoginGate failed: ${JSON.stringify(loginGate.body)}`);
    }

    const pingRpcId = nextRpcId++;
    const pingStartedAt = Date.now();
    const ping = decodePingFrame(await gate.request(buildPingPacket(pingRpcId)));
    const pingFinishedAt = Date.now();
    const serverTime = Number(ping.body.serverTime);
    if (
      ping.rpcId !== pingRpcId ||
      ping.body.error ||
      serverTime < pingStartedAt - 1_000 ||
      serverTime > pingFinishedAt + 1_000
    ) {
      throw new Error(`Gate Ping returned an invalid server time: ${serverTime}`);
    }

    const enterMapRpcId = nextRpcId++;
    const mapReadyFrame = gate.waitForMessage(MsgCode.G2C_MapReady);
    // 先注册推送监听，再立即检查RPC结果；否则Promise.all会用MapReady超时遮住真正的业务错误。
    // Subscribe first, then inspect the RPC immediately so a MapReady timeout cannot hide its error.
    void mapReadyFrame.catch(() => undefined);
    const enterMap = decodeEnterMapFrame(await gate.request(
      buildEnterMapPacket(enterMapRpcId, { mapId: request.mapId, mapInstanceId: 0n }),
    ));
    if (enterMap.rpcId !== enterMapRpcId || enterMap.body.error) {
      throw new Error(`EnterMap failed: ${JSON.stringify(enterMap.body)}`);
    }
    const mapReady = decodeMapReadyFrame(await mapReadyFrame);
    if (enterMap.body.entities.length === 0) {
      const snapshotReadyRpcId = nextRpcId++;
      const snapshotFrame = gate.waitForMessage(MsgCode.G2C_AoiDelta);
      const snapshotReady = decodeMapSnapshotReadyFrame(
        await gate.request(buildMapSnapshotReadyPacket(snapshotReadyRpcId, {
          unitId: enterMap.body.unitId,
        })),
      );
      if (snapshotReady.rpcId !== snapshotReadyRpcId || snapshotReady.body.error) {
        throw new Error(`MapSnapshotReady failed: ${JSON.stringify(snapshotReady.body)}`);
      }
      const initialSnapshot = decodeAoiDeltaFrame(await snapshotFrame).body;
      enterMap.body = {
        ...enterMap.body,
        entities: initialSnapshot.enters,
      };
    }
    if (
      enterMap.body.unitId === 0 ||
      enterMap.body.mapId !== request.mapId ||
      mapReady.rpcId !== undefined ||
      mapReady.body.unitId !== enterMap.body.unitId
      || !enterMap.body.entities.some(
        (entity) => entity.unitId === enterMap.body.unitId,
      )
    ) {
      throw new Error(`unexpected enter map result: ${JSON.stringify(enterMap.body)}`);
    }
    return {
      gate,
      enterMap: enterMap.body,
    };
  } catch (error) {
    await gate.close();
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestOne(ip: string, port: number, packet: Uint8Array): Promise<Uint8Array> {
  return requestOneWithPreamble(ip, port, packet);
}

/** 发送Rust Inner Transport要求的ETSI+token握手，不把内部RPC伪装成外部客户端消息。 / Sends the ETSI plus token preamble required by Rust Inner Transport instead of disguising internal RPC as client traffic. */
function requestOneInternal(ip: string, port: number, packet: Uint8Array): Promise<Uint8Array> {
  const token = Buffer.from(process.env.ETS_INNER_TOKEN ?? "ets-local-inner-token", "utf8");
  const length = Buffer.allocUnsafe(2);
  length.writeUInt16BE(token.length);
  return requestOneWithPreamble(
    ip,
    port,
    packet,
    Buffer.concat([Buffer.from("ETSI", "ascii"), length, token]),
  );
}

function requestOneWithPreamble(
  ip: string,
  port: number,
  packet: Uint8Array,
  preamble?: Buffer,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: ip, port });
    const decoder = new LengthPrefixedFrameDecoder();
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`request ${ip}:${port} timed out`));
    }, 5_000);

    socket.on("connect", () => {
      if (preamble) socket.write(preamble);
      socket.write(Buffer.from(packet));
    });

    socket.on("data", (chunk: Buffer) => {
      try {
        const frames = decoder.push(chunk);
        if (frames.length > 0) {
          socket.end();
          settled = true;
          clearTimeout(timeout);
          resolve(frames[0]);
        }
      } catch (error) {
        clearTimeout(timeout);
        socket.destroy();
        reject(error);
      }
    });

    socket.on("error", reject);
    socket.on("close", () => {
      clearTimeout(timeout);
      if (!settled) reject(new Error(`connection ${ip}:${port} closed before response`));
    });
  });
}

class TcpRpcConnection {
  private readonly socket: net.Socket;
  private readonly decoder = new LengthPrefixedFrameDecoder();
  private readonly connected: Promise<void>;
  private readonly closed: Promise<void>;
  private readonly pending = new Map<number, {
    resolve: (frame: Uint8Array) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly messageWaiters = new Map<
    number,
    Array<{
      resolve: (frame: Uint8Array) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }>
  >();
  private readonly bufferedMessages = new Map<number, Uint8Array[]>();

  constructor(ip: string, port: number) {
    this.socket = net.createConnection({ host: ip, port });
    this.connected = new Promise((resolve, reject) => {
      this.socket.on("connect", resolve);
      this.socket.on("error", reject);
    });
    this.closed = new Promise((resolve) => this.socket.once("close", resolve));

    this.socket.on("data", (chunk: Buffer) => {
      try {
        this.decoder.pushEach(chunk, (frame) => {
          const rpcId = extractRpcId(frame);
          if (rpcId !== undefined) {
            const pending = this.pending.get(rpcId);
            this.pending.delete(rpcId);
            if (pending) clearTimeout(pending.timer);
            pending?.resolve(frame);
            return;
          }
          this.dispatchMessage(readU16BE(frame), frame);
        });
      } catch (error) {
        this.rejectAll(error instanceof Error ? error : new Error(String(error)));
      }
    });

    this.socket.on("close", () => {
      this.rejectAll(new Error("gate connection closed"));
    });
  }

  async request(packet: Uint8Array, timeoutMs = 5000): Promise<Uint8Array> {
    await this.connected;
    // request()接收的是带4字节length-prefix的网络包，响应分帧后则不带前缀。
    // request() receives a four-byte length-prefixed packet, while decoded responses do not.
    const rpcId = extractRpcId(packet.subarray(4));
    if (rpcId === undefined) throw new Error("RPC request packet has no rpcId");
    if (this.pending.has(rpcId)) throw new Error(`duplicate pending rpcId: ${rpcId}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(rpcId)) return;
        reject(new Error(`RPC ${rpcId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(rpcId, { resolve, reject, timer });
      this.socket.write(Buffer.from(packet), (error) => {
        if (!error) return;
        const pending = this.pending.get(rpcId);
        if (!pending) return;
        this.pending.delete(rpcId);
        clearTimeout(pending.timer);
        reject(error);
      });
    });
  }

  async send(packet: Uint8Array): Promise<void> {
    await this.connected;
    await new Promise<void>((resolve, reject) => {
      this.socket.write(Buffer.from(packet), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  waitForMessage(msgcode: number, timeoutMs = 5000): Promise<Uint8Array> {
    const buffered = this.bufferedMessages.get(msgcode);
    const frame = buffered?.shift();
    if (frame) return Promise.resolve(frame);

    return new Promise((resolve, reject) => {
      const waiters = this.messageWaiters.get(msgcode) ?? [];
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const current = this.messageWaiters.get(msgcode);
          const index = current?.indexOf(waiter) ?? -1;
          if (index >= 0) current!.splice(index, 1);
          if (current?.length === 0) this.messageWaiters.delete(msgcode);
          reject(new Error(`message ${msgcode} timed out after ${timeoutMs}ms`));
        }, timeoutMs),
      };
      waiters.push(waiter);
      this.messageWaiters.set(msgcode, waiters);
    });
  }

  async close(): Promise<void> {
    if (this.socket.destroyed) return;
    this.socket.end();
    await this.closed;
  }

  /** 立即模拟客户端进程消失，供Gate断线宽限与恢复测试使用。 / Immediately simulates a vanished client process for Gate grace and recovery tests. */
  async disconnect(): Promise<void> {
    if (this.socket.destroyed) return;
    this.socket.destroy();
    await this.closed;
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiters of this.messageWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.messageWaiters.clear();
  }

  private dispatchMessage(msgcode: number, frame: Uint8Array): void {
    const waiters = this.messageWaiters.get(msgcode);
    const waiter = waiters?.shift();
    if (waiter) {
      if (waiters!.length === 0) this.messageWaiters.delete(msgcode);
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
      return;
    }
    const buffered = this.bufferedMessages.get(msgcode) ?? [];
    buffered.push(frame);
    this.bufferedMessages.set(msgcode, buffered);
  }
}

function extractRpcId(frame: Uint8Array): number | undefined {
  try {
    const reader = new BinaryReader(frame.subarray(2));
    while (!reader.eof()) {
      const tag = reader.tag();
      if (tag.fieldNo === 90 && tag.wireType === 0) return reader.uint32();
      reader.skip(tag.wireType);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
