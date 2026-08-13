import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { HotfixSystem } from "../app/core/hotReload/HotfixSystem";
import type { HotfixManifest } from "../app/core/hotReload/contracts";
import { InitializeGameSingletons } from "../app/core/runtime/Game";
import { ProcessHost } from "../app/core/runtime/host";
import { Scene } from "../app/core/runtime/entities";
import { SingletonRegistry } from "../app/core/runtime/Singleton";
import { TimeSystem } from "../app/core/runtime/TimeSystem";
import { TimerSystem } from "../app/core/runtime/TimerSystem";
import { actor, scene } from "../app/core/runtime/metadata";
import type { NativeHostOpsApi } from "../app/generated/model/native/NativeOps";
import { NativeUnitRef } from "../app/generated/model/native/NativeUnitRef";
import { GameConfigRegistry, GameConfigs } from "../app/generated/model/config";
import { ActionType } from "../app/model/mmorpg/action/ActionType";
import { ExecuteAction, ExecuteActionBatch } from "../app/hotfix/mmorpg/action/ActionExecutor";
import { GetSkillDefinition } from "../app/hotfix/mmorpg/skill/SkillCatalog";
import { BuffApplyStatus, BuffComponent } from "../app/model/mmorpg/buff/BuffComponent";
import { CombatComponent } from "../app/model/mmorpg/combat/CombatComponent";
import { NumericComponent } from "../app/model/mmorpg/numeric/NumericComponent";
import { IsDerivedNumericType, NumericType } from "../app/model/mmorpg/numeric/NumericType";
import { SkillCastPhase, SkillComponent } from "../app/model/mmorpg/skill/SkillComponent";
import { ItemComponent } from "../app/model/mmorpg/item/ItemComponent";
import {
  ApplyItemUseTransaction,
  DecodeItemUseReceipt,
  EncodeItemUseReceipt,
  PlanItemUseTransaction,
} from "../app/hotfix/mmorpg/item/ItemUseTransaction";
import { QuestComponent } from "../app/model/mmorpg/quest/QuestComponent";
import { QuestObjectiveType, QuestStatus } from "../app/generated/model/config";
import { PlayerUnit } from "../app/model/mmorpg/map/PlayerUnit";
import { PositionComponent } from "../app/model/mmorpg/map/PositionComponent";
import { UnitGateComponent } from "../app/model/mmorpg/map/UnitGateComponent";
import { PlayerPersistenceComponent } from "../app/model/mmorpg/persistence/PlayerPersistenceComponent";
import {
  InMemoryPlayerRepository,
  type PlayerTransactionResult,
  type PlayerTransactionWrite,
} from "../app/model/mmorpg/persistence/PlayerRepository";

@scene({ sceneType: "BuffTest" })
class BuffTestScene extends Scene {}

@actor({ mailbox: "ordered" })
class BuffTestUnit extends PlayerUnit {}

void main();

async function main(): Promise<void> {
  InitializeGameSingletons(
    { fixedUpdateMs: 50, maxCatchUpSteps: 2 },
    { originServerId: 11, workerId: 2 },
  );
  const manifestPath = path.resolve("game_config/generated/game-config.manifest.json");
  const dataPath = path.resolve("game_config/generated/server.json");
  const manifestJson = readFileSync(manifestPath, "utf8");
  const dataJson = readFileSync(dataPath, "utf8");
  GameConfigRegistry.Install(
    manifestJson,
    dataJson,
  );
  const frostboltDefinition = GetSkillDefinition(3001);
  assert.equal(frostboltDefinition.name, "寒冰箭");
  assert.equal(frostboltDefinition.effects.length, 2);
  assert.deepEqual(frostboltDefinition.effects[0].action.parameters, [50n, 2n]);
  assert.deepEqual(frostboltDefinition.effects[1].action.parameters, [4001n]);
  const channelHealDefinition = GetSkillDefinition(3006);
  assert.equal(channelHealDefinition.channelTickMs, 1_000);
  assert.equal(channelHealDefinition.channelTicks, 3);
  assert.equal(channelHealDefinition.queueWindowMs, 0);
  assert.equal(channelHealDefinition.effects[0]?.action.type, ActionType.Heal);
  assert.deepEqual(channelHealDefinition.effects[0]?.action.parameters, [30n]);
  const channelWhipDefinition = GetSkillDefinition(3007);
  assert.equal(channelWhipDefinition.name, "精神鞭笞");
  assert.equal(channelWhipDefinition.channelTickMs, 1_000);
  assert.equal(channelWhipDefinition.channelTicks, 5);
  assert.equal(channelWhipDefinition.effects[0]?.action.type, ActionType.DealDamage);
  assert.deepEqual(channelWhipDefinition.effects[0]?.action.parameters, [20n, 5n]);

  // Reload只替换之后查询到的定义；旧对象保持不可变，供已接受的Cast/Projectile安全完成。
  // Reload replaces definitions returned by later lookups only; the old immutable object remains safe for accepted casts/projectiles.
  const changedSkillData = JSON.parse(dataJson) as Record<string, Array<Record<string, unknown>>>;
  const frostboltDamage = changedSkillData.game_tbskilleffectconfig.find((row) => row.id === 300101);
  assert.ok(frostboltDamage);
  frostboltDamage.action_params = [75, 2];
  GameConfigRegistry.Install(
    JSON.stringify({ ...JSON.parse(manifestJson), dataFingerprint: "a".repeat(64) }),
    JSON.stringify(changedSkillData),
  );
  assert.deepEqual(GetSkillDefinition(3001).effects[0].action.parameters, [75n, 2n]);
  assert.deepEqual(frostboltDefinition.effects[0].action.parameters, [50n, 2n]);
  GameConfigRegistry.Install(
    JSON.stringify({ ...JSON.parse(manifestJson), dataFingerprint: "b".repeat(64) }),
    dataJson,
  );

  HotfixSystem.Begin(testHotfixManifest());
  await import("../app/hotfix/mmorpg/numeric/NumericComponentSystem");
  await import("../app/hotfix/mmorpg/combat/CombatComponentSystem");
  await import("../app/hotfix/mmorpg/buff/BuffSystem");
  await import("../app/hotfix/mmorpg/buff/BuffComponentSystem");
  await import("../app/hotfix/mmorpg/skill/SkillComponentSystem");
  await import("../app/hotfix/mmorpg/item/ItemSystem");
  await import("../app/hotfix/mmorpg/item/ItemComponentSystem");
  await import("../app/hotfix/mmorpg/quest/QuestSystem");
  await import("../app/hotfix/mmorpg/quest/QuestComponentSystem");
  await import("../app/hotfix/mmorpg/map/PlayerUnitSystem");
  HotfixSystem.Commit();

  const host = new ProcessHost("buff-action-self-test");
  const scene = host.spawnScene("buff", BuffTestScene);
  const unit = scene.SpawnActor(1, BuffTestUnit, {
    account: "buff-test-1",
    characterId: 1n,
    mapId: 1,
    mapInstanceId: 1n,
  });
  installNativeHostOps();
  const native = unit.AddComponent(NativeUnitRef, { id: 1, instanceId: unit.InstanceId, mapId: 1 });
  unit.AddComponent(PositionComponent, native, 100, 100, 1);
  unit.AddComponent(UnitGateComponent, "gate_test");
  unit.AddComponent(NumericComponent, {
    [NumericType.CurrentHp]: 1n,
    [NumericType.MaxHpBase]: 200n,
    [NumericType.CurrentMp]: 0n,
    [NumericType.MaxMpBase]: 100n,
    [NumericType.Level]: 1n,
    [NumericType.MoveSpeedBase]: 6_000n,
  });
  unit.AddComponent(CombatComponent);
  const buffs = unit.AddComponent(BuffComponent);
  const items = unit.AddComponent(ItemComponent);
  assert.deepEqual(items.Snapshot(), []);
  items.GrantItem(1001, 50);
  items.GrantItem(1002, 20);
  const sourceSkill = unit.AddComponent(SkillComponent);
  const quests = unit.AddComponent(QuestComponent);
  const repository = new ControllablePlayerRepository();
  const persistence = unit.AddComponent(PlayerPersistenceComponent, repository, 0n);

  // 道具关键事务在DBProxy确认前不修改背包、CD或效果；失败可以原样重试。
  // Critical item transactions do not mutate inventory, cooldowns, or effects before DBProxy confirms; failures remain retryable.
  const smallPotion = items.Snapshot().find((item) => item.configId === 1001)!;
  const failedPlan = PlanItemUseTransaction(unit, smallPotion.itemId, smallPotion.configId);
  repository.failTransactions = true;
  await assert.rejects(
    persistence.ApplyTransaction(
      "item-use:buff-test-1:failure",
      failedPlan.data,
      EncodeItemUseReceipt(failedPlan.receipt),
    ),
    /injected transaction failure/,
  );
  assert.equal(items.GetItem(smallPotion.itemId)?.count, 50);
  assert.equal(unit.GetComponent(NumericComponent)[NumericType.CurrentHp], 1n);
  assert.equal(sourceSkill.ItemReadyAt(1001), 0);

  // 模拟PostgreSQL已提交但ACK丢失：按operationId读取原回执后只补做一次内存效果。
  // Simulate a committed PostgreSQL transaction with a lost ACK: the original receipt reconciles in-memory state exactly once.
  repository.failTransactions = false;
  repository.loseNextTransactionAck = true;
  const lostAckPlan = PlanItemUseTransaction(unit, smallPotion.itemId, smallPotion.configId);
  const lostAckResult = EncodeItemUseReceipt(lostAckPlan.receipt);
  await assert.rejects(
    persistence.ApplyTransaction(
      "item-use:buff-test-1:lost-ack",
      lostAckPlan.data,
      lostAckResult,
    ),
    /injected lost transaction ack/,
  );
  assert.equal(items.GetItem(smallPotion.itemId)?.count, 50);
  const lostAckReceipt = await persistence.LoadTransaction("item-use:buff-test-1:lost-ack");
  assert.ok(lostAckReceipt);
  const durablePotion = DecodeItemUseReceipt(lostAckReceipt.result);
  const firstApply = ApplyItemUseTransaction(unit, durablePotion);
  assert.equal(firstApply.inventoryChanged, true);
  assert.equal(items.GetItem(smallPotion.itemId)?.count, 49);
  const healedHp = unit.GetComponent(NumericComponent)[NumericType.CurrentHp];
  assert.ok(healedHp > 1n);
  const duplicateApply = ApplyItemUseTransaction(unit, durablePotion);
  assert.equal(duplicateApply.inventoryChanged, false);
  assert.equal(items.GetItem(smallPotion.itemId)?.count, 49);
  assert.equal(unit.GetComponent(NumericComponent)[NumericType.CurrentHp], healedHp);

  // 后续背包写入已使version前进时，旧回执只能返回原结果，不能把当前堆叠回退。
  // Once a later inventory write advances version, an old receipt may return its original result but cannot roll the current stack backward.
  items.GrantItem(1001, 1);
  const countAfterLaterWrite = items.GetItem(smallPotion.itemId)!.count;
  ApplyItemUseTransaction(unit, durablePotion);
  assert.equal(items.GetItem(smallPotion.itemId)?.count, countAfterLaterWrite);

  // 等待共享GCD后验证Buff道具也使用确定实例回执，重复应用不会创建第二个Buff。
  // After shared GCD expires, verify a Buff item uses an exact instance receipt and replay cannot create a second Buff.
  const itemFrame = TimeSystem.Instance.FrameTime + 1_100;
  const itemServer = TimeSystem.Instance.ServerNow + 1_100;
  TimeSystem.Instance.__update(itemFrame, itemServer);
  TimerSystem.Instance.__update(itemFrame);
  const largePotion = items.Snapshot().find((item) => item.configId === 1002)!;
  const buffPlan = PlanItemUseTransaction(unit, largePotion.itemId, largePotion.configId);
  const buffReceiptBytes = EncodeItemUseReceipt(buffPlan.receipt);
  const buffTransaction = await persistence.ApplyTransaction(
    "item-use:buff-test-1:buff",
    buffPlan.data,
    buffReceiptBytes,
  );
  const durableBuff = DecodeItemUseReceipt(buffTransaction.result);
  const buffApply = ApplyItemUseTransaction(unit, durableBuff, buffPlan.inventory);
  assert.equal(buffApply.inventoryChanged, true);
  assert.equal(buffs.GetBuffs().filter((value) => value.ConfigId === 2001).length, 1);
  const transactionTickFrame = TimeSystem.Instance.FrameTime + 3_100;
  const transactionTickServer = TimeSystem.Instance.ServerNow + 3_100;
  TimeSystem.Instance.__update(transactionTickFrame, transactionTickServer);
  TimerSystem.Instance.__update(transactionTickFrame);
  await Promise.resolve();
  await Promise.resolve();
  ApplyItemUseTransaction(unit, durableBuff);
  assert.equal(buffs.GetBuffs().filter((value) => value.ConfigId === 2001).length, 1);
  const transactionBuff = buffs.GetBuffs().find((value) => value.ConfigId === 2001)!;
  buffs.RemoveBuff(transactionBuff.Id as bigint, "transaction-test-cleanup");
  items.GrantItem(1002, 1);
  unit.GetComponent(NumericComponent)[NumericType.CurrentHp] = 1n;
  sourceSkill.RestoreTransfer({ globalCooldownEndAtMs: 0, cooldowns: [], itemCooldowns: [] });

  // 5001是Starter的NPC接取任务；自测显式模拟玩家从任务使者处接取，不能再依赖自动接取。
  // Starter quest 5001 is accepted from the NPC; the self-test models that explicit step.
  assert.deepEqual(quests.Snapshot().map((quest) => quest.questConfigId), []);
  quests.AcceptQuest(5002);
  quests.AcceptQuest(5003);
  quests.AcceptQuest(5001);
  assert.deepEqual(quests.ApplyProgress({
    player: unit as never,
    objectiveType: QuestObjectiveType.KillMonster,
    targetConfigId: 999,
    count: 1,
  }), []);
  assert.throws(() => quests.AcceptQuest(5004), /requires completed quest 5001/);
  const killProgress = quests.ApplyProgress({
    player: unit as never,
    objectiveType: QuestObjectiveType.KillMonster,
    targetConfigId: 1,
    count: 5,
  });
  assert.equal(killProgress[0]?.status, QuestStatus.ReadyToTurnIn);
  repository.failTransactions = true;
  await assert.rejects(quests.CompleteQuest(5001), /injected transaction failure/);
  assert.equal(quests.Snapshot().find((quest) => quest.questConfigId === 5001)?.status, QuestStatus.ReadyToTurnIn);
  assert.equal(items.Snapshot().find((item) => item.configId === 1001)?.count, 50);
  repository.failTransactions = false;
  repository.loseNextTransactionAck = true;
  await assert.rejects(quests.CompleteQuest(5001), /injected lost transaction ack/);
  assert.equal(quests.Snapshot().find((quest) => quest.questConfigId === 5001)?.status, QuestStatus.ReadyToTurnIn);
  assert.equal(items.Snapshot().find((item) => item.configId === 1001)?.count, 50);
  const reward = await quests.CompleteQuest(5001);
  assert.equal(reward.rewardItems[0]?.configId, 1001);
  assert.equal(reward.rewardItems[0]?.count, 60);
  assert.equal(items.Snapshot().filter((item) => item.configId === 1001).length, 1);
  const followUpQuest = quests.AcceptQuest(5005);
  assert.equal(followUpQuest.status, QuestStatus.InProgress);
  const followUpProgress = quests.ApplyProgress({
    player: unit as never,
    objectiveType: QuestObjectiveType.KillMonster,
    targetConfigId: 2,
    count: 5,
  });
  assert.equal(followUpProgress[0]?.questConfigId, 5005);
  assert.equal(followUpProgress[0]?.status, QuestStatus.ReadyToTurnIn);
  const duplicateReward = await quests.CompleteQuest(5001);
  assert.deepEqual(duplicateReward, reward);
  assert.equal(items.Snapshot().find((item) => item.configId === 1001)?.count, 60);
  const splitStacks = items.GrantItem(1001, 60);
  assert.deepEqual(splitStacks.map((item) => item.count), [99, 21]);
  assert.throws(() => items.RemoveItem(splitStacks[0]!.itemId, -1), /positive safe integer/);
  const batchGrant = ExecuteActionBatch(unit, [
    { type: ActionType.GrantItem, parameters: [1002n, 1n] },
    { type: ActionType.GrantItem, parameters: [1002n, 2n] },
  ], { reason: "inventory-test" });
  assert.equal(batchGrant.grantedItems.length, 1);
  assert.equal(batchGrant.grantedItems[0]?.configId, 1002);
  assert.equal(batchGrant.grantedItems[0]?.count, 23);
  assert.throws(() => quests.AcceptQuest(5004), /requires level 2/);
  unit.GetComponent(NumericComponent)[NumericType.Level] = 2n;
  const advancedQuest = quests.AcceptQuest(5004);
  assert.equal(advancedQuest.status, QuestStatus.InProgress);
  const advancedProgress = quests.ApplyProgress({
    player: unit as never,
    objectiveType: QuestObjectiveType.UseItem,
    targetConfigId: 1002,
    count: 1,
  });
  assert.equal(advancedProgress[0]?.questConfigId, 5004);
  assert.equal(advancedProgress[0]?.status, QuestStatus.ReadyToTurnIn);

  assert.equal(GameConfigs.BuffConfig.Get(2001).tickIntervalMs, 3_000);
  assert.equal(GameConfigs.BuffConfig.Get(2001).tickActionType, ActionType.Heal);
  const buff = buffs.AddBuff(2001);
  assert.equal(buffs.GetBuff(buff.Id as bigint), buff);
  assert.equal(unit.GetComponent(NumericComponent)[NumericType.CurrentHp], 1n);

  // 触发一个3秒Tick；Actor Timer会经过Unit mailbox，因此每次推进后让出一次微任务。
  // Fire one three-second Tick. Actor timers pass through the Unit mailbox,
  // so yield once after each simulated update.
  const baseFrame = TimeSystem.Instance.FrameTime;
  const baseServer = TimeSystem.Instance.ServerNow;
  TimeSystem.Instance.__update(baseFrame + 3_000, baseServer + 3_000);
  TimerSystem.Instance.__update(baseFrame + 3_000);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(unit.GetComponent(NumericComponent)[NumericType.CurrentHp], 51n);

  // 传送只恢复纯值和时间戳，不重复执行Buff的AddAction；目标HP应从Numeric快照恢复为51，而不是再次加50。
  // Transfer restores value state and wall-clock deadlines without replaying AddAction; the target HP must be 51, not 101.
  const transfer = unit.CaptureTransfer();
  const target = scene.SpawnActor(2, BuffTestUnit, {
    account: "buff-test-2",
    characterId: 2n,
    mapId: 1,
    mapInstanceId: 1n,
  });
  const targetNative = target.AddComponent(NativeUnitRef, { id: 2, instanceId: target.InstanceId, mapId: 1 });
  target.AddComponent(PositionComponent, targetNative, 100, 100, 1);
  target.AddComponent(UnitGateComponent, "gate_test");
  target.AddComponent(NumericComponent, {
    [NumericType.CurrentHp]: 1n,
    [NumericType.MaxHpBase]: 200n,
    [NumericType.CurrentMp]: 0n,
    [NumericType.MaxMpBase]: 100n,
    [NumericType.Level]: 1n,
    [NumericType.MoveSpeedBase]: 6_000n,
  });
  target.AddComponent(CombatComponent);
  const targetBuffs = target.AddComponent(BuffComponent);
  target.AddComponent(ItemComponent);
  const targetSkill = target.AddComponent(SkillComponent);
  const targetQuests = target.AddComponent(QuestComponent);
  target.AddComponent(PlayerPersistenceComponent, repository, 0n);
  target.RestoreTransfer(transfer);
  assert.equal(target.GetComponent(NumericComponent)[NumericType.CurrentHp], 51n);
  assert.equal(targetBuffs.GetBuff(buff.Id as bigint)?.Id, buff.Id);
  assert.deepEqual(targetQuests.CompletedQuestConfigIds(), [5001]);
  assert.deepEqual(
    targetQuests.Snapshot().map((quest) => quest.questConfigId).sort((left, right) => left - right),
    [5002, 5003, 5004, 5005],
  );
  assert.equal(targetQuests.Snapshot().find((quest) => quest.questConfigId === 5004)?.status, QuestStatus.ReadyToTurnIn);

  assert.equal(buffs.RemoveBuff(buff.Id as bigint, "test"), true);
  assert.equal(buffs.GetBuff(buff.Id as bigint), undefined);
  assert.equal(buffs.RemoveBuff(buff.Id as bigint), false);
  assert.equal(targetBuffs.RemoveBuff(buff.Id as bigint, "target-test"), true);
  assert.equal(targetBuffs.RemoveBuff(buff.Id as bigint), false);

  // 冰冷按Target唯一：第二个施法者只刷新同一实例，不重复执行-40% AddAction。
  // Chilled is target-scoped: another caster refreshes the same instance without replaying -40%.
  const chilled = buffs.ApplyBuff(4001, { sourceUnitId: 10, sourceAbilityId: 3001 });
  const chilledRefresh = buffs.ApplyBuff(4001, { sourceUnitId: 11, sourceAbilityId: 3001 });
  assert.equal(chilled.status, BuffApplyStatus.Applied);
  assert.equal(chilledRefresh.status, BuffApplyStatus.Refreshed);
  assert.equal(chilledRefresh.buff?.Id, chilled.buff?.Id);
  assert.equal(unit.GetComponent(NumericComponent)[NumericType.MoveSpeedPct], -40n);
  assert.equal(buffs.RemoveBuff(chilled.buff!.Id as bigint, "test-chilled"), true);
  assert.equal(unit.GetComponent(NumericComponent)[NumericType.MoveSpeedPct], 0n);

  // 灼烧按Source唯一：同一施法者刷新，不同施法者创建独立实例。
  // Burn is source-scoped: one caster refreshes its instance while another owns a separate DoT.
  const burn1 = buffs.ApplyBuff(4002, { sourceUnitId: 10, sourceAbilityId: 3002 });
  const burn1Refresh = buffs.ApplyBuff(4002, { sourceUnitId: 10, sourceAbilityId: 3002 });
  const burn2 = buffs.ApplyBuff(4002, { sourceUnitId: 11, sourceAbilityId: 3002 });
  assert.equal(burn1Refresh.status, BuffApplyStatus.Refreshed);
  assert.equal(burn1Refresh.buff?.Id, burn1.buff?.Id);
  assert.equal(burn2.status, BuffApplyStatus.Applied);
  assert.equal(GameConfigs.BuffConfig.Get(4002).tickActionType, ActionType.DealDamage);
  assert.equal(buffs.GetBuffs().filter((value) => value.ConfigId === 4002).length, 2);
  const burnFrame = TimeSystem.Instance.FrameTime + 1_000;
  const burnServer = TimeSystem.Instance.ServerNow + 1_000;
  TimeSystem.Instance.__update(burnFrame, burnServer);
  TimerSystem.Instance.__update(burnFrame);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(unit.GetComponent(NumericComponent)[NumericType.CurrentHp], 41n);
  for (const value of buffs.GetBuffs().filter((item) => item.ConfigId === 4002)) {
    buffs.RemoveBuff(value.Id as bigint, "test-burn");
  }

  const healed = ExecuteAction(unit, { type: ActionType.Heal, parameters: [9n] }, {
    sourceAbilityId: 3005,
  });
  assert.equal(healed.changed, true);
  assert.equal(unit.GetComponent(NumericComponent)[NumericType.CurrentHp], 50n);

  const weakSoul = buffs.ApplyBuff(4004, { sourceUnitId: 10, sourceAbilityId: 3004 });
  const weakSoulRejected = buffs.ApplyBuff(4004, { sourceUnitId: 11, sourceAbilityId: 3004 });
  assert.equal(weakSoul.status, BuffApplyStatus.Applied);
  assert.equal(weakSoulRejected.status, BuffApplyStatus.Rejected);
  buffs.RemoveBuff(weakSoul.buff!.Id as bigint, "test-weak-soul");

  // 韧同等级刷新、低等级拒绝、高等级替换；MaxHpAdd始终只增加一次。
  // Fortitude refreshes equal rank, rejects lower rank, and replaces with higher rank without double-adding MaxHp.
  const fortitude = buffs.ApplyBuff(4005, { sourceUnitId: 10, sourceAbilityId: 3005, conflictPriority: 1 });
  assert.equal(unit.GetComponent(NumericComponent)[NumericType.MaxHp], 700n);
  assert.equal(buffs.ApplyBuff(4005, { sourceUnitId: 11, sourceAbilityId: 3005, conflictPriority: 1 }).status, BuffApplyStatus.Refreshed);
  assert.equal(buffs.ApplyBuff(4005, { sourceUnitId: 12, sourceAbilityId: 3005, conflictPriority: 0 }).status, BuffApplyStatus.Rejected);
  assert.equal(buffs.ApplyBuff(4005, { sourceUnitId: 13, sourceAbilityId: 3005, conflictPriority: 2 }).status, BuffApplyStatus.Replaced);
  assert.equal(unit.GetComponent(NumericComponent)[NumericType.MaxHp], 700n);
  const activeFortitude = buffs.GetBuffs().find((value) => value.ConfigId === 4005)!;
  buffs.RemoveBuff(activeFortitude.Id as bigint, "test-fortitude");
  assert.equal(unit.GetComponent(NumericComponent)[NumericType.MaxHp], 200n);

  // 盾向Combat注册吸收器，传送只恢复剩余150而不是重新填满200。
  // Shield registers a Combat absorber; transfer restores the remaining 150 instead of refilling 200.
  const shield = buffs.ApplyBuff(4003, {
    sourceUnitId: unit.UnitId,
    sourceAbilityId: 3004,
  });
  assert.equal(shield.status, BuffApplyStatus.Applied);
  assert.equal(GameConfigs.BuffConfig.Get(4003).addActionType, ActionType.RegisterDamageAbsorber);
  const absorbed = unit.GetComponent(CombatComponent).ApplyDamage({ amount: 50n, sourceUnitId: 99 });
  assert.equal(absorbed.absorbedDamage, 50n);
  const shieldTransfer = buffs.CaptureTransfer().find((value) => value.configId === 4003)!;
  assert.equal(shieldTransfer.damageAbsorberRemaining, 150n);
  targetBuffs.RestoreTransfer([shieldTransfer]);
  const restoredShield = targetBuffs.CaptureTransfer()[0];
  assert.equal(restoredShield.damageAbsorberRemaining, 150n);
  const fullyAbsorbed = target.GetComponent(CombatComponent).ApplyDamage({ amount: 150n, sourceUnitId: 99 });
  assert.equal(fullyAbsorbed.absorbedDamage, 150n);
  assert.equal(fullyAbsorbed.finalDamage, 0n);

  // 跨地图保留已提交GCD/CD，但不恢复源地图活动读条。
  // Cross-map transfer keeps committed GCD/CD without restoring the source-map active cast.
  const skillNow = TimeSystem.Instance.ServerNow;
  const itemCooldown = sourceSkill.TryCommitItemCooldown(1001, 30_000, 1_000);
  assert.equal(itemCooldown.accepted, true);
  assert.equal(sourceSkill.TryCommitItemCooldown(1002, 30_000, 1_000).accepted, false);
  sourceSkill.Accept({
    castId: 90001n,
    skillId: 3002,
    targetUnitId: 123,
    startedAtMs: skillNow,
    finishAtMs: skillNow + 1_500,
    nextTickAtMs: 0,
    channelTicksCompleted: 0,
    definition: GetSkillDefinition(3002),
  }, 12_000, 1_000);
  const skillTransfer = sourceSkill.CaptureTransfer();
  targetSkill.RestoreTransfer(skillTransfer);
  assert.equal(targetSkill.State(3002).phase, SkillCastPhase.Idle);
  assert.equal(targetSkill.ReadyAt(3002), skillNow + 12_000);
  assert.equal(targetSkill.ItemReadyAt(1001), itemCooldown.itemCooldownEndAtMs);
  sourceSkill.Interrupt("test-transfer");

  // 引导状态和单技能排队只保存纯值；推进/取出不保存目标Entity或闭包。
  // Channel progress and one-skill queue are pure values; no target Entity or closure is retained.
  const channelCastId = 90002n;
  sourceSkill.Accept({
    castId: channelCastId,
    skillId: 3006,
    targetUnitId: unit.UnitId,
    startedAtMs: skillNow,
    finishAtMs: skillNow + 3_000,
    nextTickAtMs: skillNow + 1_000,
    channelTicksCompleted: 0,
    definition: channelHealDefinition,
  }, 6_000, 1_000);
  assert.equal(sourceSkill.State(3006).channelTickCount, 3);
  sourceSkill.UpdateChannel(channelCastId, skillNow + 2_000, 2);
  assert.equal(sourceSkill.State(3006).channelTickIndex, 2);
  sourceSkill.Interrupt("test-channel");
  const whipCastId = 90004n;
  sourceSkill.Accept({
    castId: whipCastId,
    skillId: 3007,
    targetUnitId: 123,
    startedAtMs: skillNow,
    finishAtMs: skillNow + 5_000,
    nextTickAtMs: skillNow + 1_000,
    channelTicksCompleted: 0,
    definition: channelWhipDefinition,
  }, 0, 1_000);
  const shortened = sourceSkill.ReduceActiveCast(whipCastId, 800, skillNow + 500);
  assert.equal(shortened?.finishAtMs, skillNow + 4_200);
  assert.equal(shortened?.phase, SkillCastPhase.Casting);
  sourceSkill.Interrupt("test-channel-damage");
  const pushedCastId = 90005n;
  sourceSkill.Accept({
    castId: pushedCastId,
    skillId: 3001,
    targetUnitId: 123,
    startedAtMs: skillNow,
    finishAtMs: skillNow + 1_500,
    nextTickAtMs: 0,
    channelTicksCompleted: 0,
    definition: frostboltDefinition,
  }, 0, 1_000);
  const pushed = sourceSkill.ExtendActiveCast(pushedCastId, 800);
  assert.equal(pushed?.finishAtMs, skillNow + 2_300);
  sourceSkill.Interrupt("test-cast-pushback");
  const queueCastId = 90003n;
  sourceSkill.Accept({
    castId: queueCastId,
    skillId: 3001,
    targetUnitId: 123,
    startedAtMs: skillNow,
    finishAtMs: skillNow + 1_500,
    nextTickAtMs: 0,
    channelTicksCompleted: 0,
    definition: frostboltDefinition,
  }, 0, 1_000);
  sourceSkill.Queue({ skillId: 3001, targetUnitId: 123 }, skillNow + 1_500);
  assert.equal(sourceSkill.State(3001).queuedSkillId, 3001);
  assert.deepEqual(sourceSkill.TakeQueued(), { skillId: 3001, targetUnitId: 123 });
  sourceSkill.Interrupt("test-queue");

  host.Dispose();
  SingletonRegistry.DestroyAll();
  console.log("buff action self-test passed", { actionTypes: ActionType });
}

class ControllablePlayerRepository extends InMemoryPlayerRepository {
  failTransactions = false;
  loseNextTransactionAck = false;

  override ApplyTransaction(
    write: PlayerTransactionWrite,
    expectedRevision: bigint,
  ): PlayerTransactionResult {
    if (this.failTransactions) throw new Error("injected transaction failure");
    const result = super.ApplyTransaction(write, expectedRevision);
    if (this.loseNextTransactionAck) {
      this.loseNextTransactionAck = false;
      throw new Error("injected lost transaction ack");
    }
    return result;
  }
}

function installNativeHostOps(): void {
  let nextHandle = 1;
  const entities = new Map<number, Float64Array>();
  const numerics = new Map<number, Map<number, bigint>>();
  (globalThis as typeof globalThis & { __etsNativeOps?: NativeHostOpsApi }).__etsNativeOps = {
    entityCreate: (_type, values) => {
      const handle = nextHandle++;
      entities.set(handle, values.slice());
      return handle;
    },
    entityDestroy: (handle) => { entities.delete(handle); numerics.delete(handle); },
    entityGetNumber: (handle, field) => entities.get(handle)![field - 1],
    entitySetNumber: (handle, field, value) => { entities.get(handle)![field - 1] = value; },
    numericAttach: (handle) => { numerics.set(handle, new Map()); },
    numericDetach: (handle) => { numerics.delete(handle); },
    numericGet: (handle, type) => numerics.get(handle)?.get(type) ?? 0n,
    numericSet: (handle, type, value) => {
      const values = numerics.get(handle)!;
      if (IsDerivedNumericType(type)) throw new Error("derived Numeric is read-only");
      if (values.get(type) === value) return false;
      values.set(type, value);
      const target = Math.trunc(type / 10);
      const suffix = type % 10;
      if (IsDerivedNumericType(target) && suffix >= 1 && suffix <= 3) {
        const base = values.get(target * 10 + 1) ?? 0n;
        const addition = values.get(target * 10 + 2) ?? 0n;
        const pct = values.get(target * 10 + 3) ?? 0n;
        values.set(target, (base + addition) * (100n + pct) / 100n);
      }
      return true;
    },
  } as NativeHostOpsApi;
}

function testHotfixManifest(): HotfixManifest {
  return {
    formatVersion: 1,
    bundleVersion: "buff-action-self-test",
    modelFingerprint: "buff-action-self-test",
    modelSourceHash: "buff-action-self-test",
    protocolFingerprint: "buff-action-self-test",
    stableCoreApiHash: "buff-action-self-test",
    nativeSchemaHash: "buff-action-self-test",
    hotfixHash: "buff-action-self-test",
    buildMode: "demo",
  };
}
