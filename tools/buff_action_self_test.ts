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
import { ActionType } from "../app/model/demo/action/ActionType";
import { ExecuteAction } from "../app/hotfix/demo/action/ActionExecutor";
import { GetSkillDefinition } from "../app/hotfix/demo/skill/SkillCatalog";
import { BuffApplyStatus, BuffComponent } from "../app/model/demo/buff/BuffComponent";
import { CombatComponent } from "../app/model/demo/combat/CombatComponent";
import { NumericComponent } from "../app/model/demo/numeric/NumericComponent";
import { IsDerivedNumericType, NumericType } from "../app/model/demo/numeric/NumericType";
import { SkillCastPhase, SkillComponent } from "../app/model/demo/skill/SkillComponent";
import { ItemComponent } from "../app/model/demo/item/ItemComponent";
import { QuestComponent } from "../app/model/demo/quest/QuestComponent";
import { QuestObjectiveType, QuestStatus } from "../app/generated/model/config";
import { ActorUnit } from "../app/core/runtime/Unit";

@scene({ sceneType: "BuffTest" })
class BuffTestScene extends Scene {}

@actor({ mailbox: "ordered" })
class BuffTestUnit extends ActorUnit {}

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
  await import("../app/hotfix/demo/numeric/NumericComponentSystem");
  await import("../app/hotfix/demo/combat/CombatComponentSystem");
  await import("../app/hotfix/demo/buff/BuffSystem");
  await import("../app/hotfix/demo/buff/BuffComponentSystem");
  await import("../app/hotfix/demo/skill/SkillComponentSystem");
  await import("../app/hotfix/demo/item/ItemSystem");
  await import("../app/hotfix/demo/item/ItemComponentSystem");
  await import("../app/hotfix/demo/quest/QuestSystem");
  await import("../app/hotfix/demo/quest/QuestComponentSystem");
  HotfixSystem.Commit();

  const host = new ProcessHost("buff-action-self-test");
  const scene = host.spawnScene("buff", BuffTestScene);
  const unit = scene.SpawnActor(1, BuffTestUnit);
  installNativeHostOps();
  unit.AddComponent(NativeUnitRef, { id: 1, instanceId: unit.InstanceId, mapId: 1 });
  unit.AddComponent(NumericComponent, {
    [NumericType.CurrentHp]: 1n,
    [NumericType.MaxHpBase]: 200n,
    [NumericType.CurrentMp]: 0n,
    [NumericType.MaxMpBase]: 100n,
    [NumericType.Level]: 1n,
  });
  unit.AddComponent(CombatComponent);
  const buffs = unit.AddComponent(BuffComponent);
  unit.AddComponent(ItemComponent);
  const quests = unit.AddComponent(QuestComponent);

  assert.deepEqual(quests.Snapshot().map((quest) => quest.questConfigId), [5001, 5002, 5003]);
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
    count: 1,
  });
  assert.equal(killProgress[0]?.status, QuestStatus.ReadyToTurnIn);
  const reward = quests.CompleteQuest(5001);
  assert.equal(reward.rewardItems[0]?.configId, 1001);
  assert.equal(reward.rewardItems[0]?.count, 2);
  assert.throws(() => quests.CompleteQuest(5001));
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
  const target = scene.SpawnActor(2, BuffTestUnit);
  target.AddComponent(NativeUnitRef, { id: 2, instanceId: target.InstanceId, mapId: 1 });
  target.AddComponent(NumericComponent, {
    [NumericType.CurrentHp]: 1n,
    [NumericType.MaxHpBase]: 200n,
    [NumericType.CurrentMp]: 0n,
    [NumericType.MaxMpBase]: 100n,
    [NumericType.Level]: 1n,
  });
  target.AddComponent(CombatComponent);
  const targetBuffs = target.AddComponent(BuffComponent);
  target.AddComponent(ItemComponent);
  const targetQuests = target.AddComponent(QuestComponent);
  target.RestoreTransfer(transfer);
  assert.equal(target.GetComponent(NumericComponent)[NumericType.CurrentHp], 51n);
  assert.equal(targetBuffs.GetBuff(buff.Id as bigint)?.Id, buff.Id);
  assert.deepEqual(targetQuests.CompletedQuestConfigIds(), [5001]);
  assert.deepEqual(targetQuests.Snapshot().map((quest) => quest.questConfigId), [5002, 5003, 5004]);
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
  const sourceSkill = unit.AddComponent(SkillComponent);
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
    definition: GetSkillDefinition(3002),
  }, 12_000, 1_000);
  const skillTransfer = sourceSkill.CaptureTransfer();
  const targetSkill = target.AddComponent(SkillComponent);
  targetSkill.RestoreTransfer(skillTransfer);
  assert.equal(targetSkill.State(3002).phase, SkillCastPhase.Idle);
  assert.equal(targetSkill.ReadyAt(3002), skillNow + 12_000);
  assert.equal(targetSkill.ItemReadyAt(1001), itemCooldown.itemCooldownEndAtMs);

  host.Dispose();
  SingletonRegistry.DestroyAll();
  console.log("buff action self-test passed", { actionTypes: ActionType });
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
