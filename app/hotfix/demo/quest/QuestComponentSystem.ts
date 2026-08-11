import {
  ActionType,
  GameConfigs,
  GameErrCode,
  ItemComponent,
  M2C_CompleteQuestCodec,
  NumericComponent,
  NumericType,
  PlayerUnit,
  PlayerPersistenceComponent,
  Quest,
  QuestComponent,
  QuestEvents,
  QuestStatus,
  SystemErrCode,
  type QuestProgressEvent,
  type QuestRewardResult,
  type QuestState,
  type QuestTransferState,
  RpcError,
  type ITransfer,
  systemFor,
} from "#tiangz/model";
import { ActionFromConfig } from "../action/ActionExecutor";
import { PlanTransactionalReward } from "../reward/RewardExecutor";

@systemFor(QuestComponent)
export class QuestComponentSystem extends QuestComponent implements ITransfer<QuestTransferState> {
  /** 自动接取只用于Demo出生流程；正式项目可由NPC、剧情或GM调用AcceptQuest。 / Auto-accept is demo seeding only; production accepts from NPC, story, or GM flows. */
  protected override Awake(): void {
    for (const config of GameConfigs.QuestConfig.GetAll()) {
      if (config.autoAccept) this.AcceptQuest(config.id);
    }
  }

  AcceptQuest(questConfigId: number): QuestState {
    if (this.completedQuestConfigIds.has(questConfigId) || this.TryGetChild(Quest, BigInt(questConfigId))) {
      throw new RpcError(GameErrCode.QuestAlreadyAccepted, `quest already accepted or completed: ${questConfigId}`);
    }
    const config = GameConfigs.QuestConfig.Get(questConfigId);
    const player = this.GetParent() as PlayerUnit;
    const vetoReason = this.DomainScene().Events.Check(QuestEvents.BeforeAccept, {
      player,
      quests: this,
      config,
    });
    if (vetoReason !== SystemErrCode.Success) {
      throw new RpcError(vetoReason, `quest ${questConfigId} rejected by BeforeAccept`);
    }
    this.RequireConfigConditions(player, config);
    const objectives = config.objectiveIds.map((objectiveId) => {
      const objective = GameConfigs.QuestObjectiveConfig.Get(objectiveId);
      if (objective.questConfigId !== questConfigId) {
        throw new Error(`quest objective owner mismatch: ${objectiveId} -> ${objective.questConfigId}`);
      }
      return { objectiveId, current: 0, required: objective.requiredCount };
    });
    const quest = this.AddChild(Quest, BigInt(questConfigId), { configId: questConfigId, objectives });
    this.IndexQuest(quest);
    return quest.Snapshot();
  }

  /** 在不改变Entity的情况下计算拾取/击杀将产生的任务快照，供持久化事务预检使用。 / Plans quest progress without mutating Entities so the result can join a persistence transaction. */
  PlanProgress(event: QuestProgressEvent): readonly QuestState[] {
    const entries = this.objectiveIndex.get(objectiveIndexKey(event.objectiveType, event.targetConfigId));
    if (!entries || !Number.isSafeInteger(event.count) || event.count <= 0) return [];
    const planned = new Map<number, QuestState>();
    for (const entry of entries) {
      const quest = this.TryGetChild(Quest, BigInt(entry.questConfigId));
      if (!quest) throw new Error(`quest objective index points to missing quest ${entry.questConfigId}`);
      const current = planned.get(entry.questConfigId) ?? quest.Snapshot();
      if (current.status !== QuestStatus.InProgress) continue;
      const objectives = current.objectives.map((objective) => ({ ...objective }));
      const objective = objectives.find((value) => value.objectiveId === entry.objectiveId);
      if (!objective || objective.current >= objective.required) continue;
      objective.current = Math.min(objective.required, objective.current + event.count);
      planned.set(entry.questConfigId, {
        ...current,
        objectives,
        status: objectives.every((value) => value.current >= value.required)
          ? QuestStatus.ReadyToTurnIn
          : QuestStatus.InProgress,
        revision: current.revision + 1,
      });
    }
    return [...planned.values()].sort((left, right) => left.questConfigId - right.questConfigId);
  }

  /** 处理本Scene内的业务事实；只修改匹配目标，并把广播交给MapComponent。 / Applies a Scene-local fact to matching objectives and delegates owner sync to MapComponent. */
  ApplyProgress(event: QuestProgressEvent): readonly QuestState[] {
    const entries = this.objectiveIndex.get(objectiveIndexKey(event.objectiveType, event.targetConfigId));
    if (!entries) return [];
    const changedQuestIds = new Set<number>();
    for (const entry of entries) {
      const quest = this.TryGetChild(Quest, BigInt(entry.questConfigId));
      if (!quest) throw new Error(`quest objective index points to missing quest ${entry.questConfigId}`);
      if (quest.Advance(entry.objectiveId, event.count)) changedQuestIds.add(entry.questConfigId);
    }
    return [...changedQuestIds]
      .sort((a, b) => a - b)
      .map((id) => this.GetChild(Quest, BigInt(id)).Snapshot());
  }

  /** 将持久化回执中的任务状态应用到内存；业务回执只能前进，不能覆盖更高版本。 / Applies quest states from a durable receipt and never overwrites a newer local revision. */
  ApplyCommittedProgress(states: readonly QuestState[]): void {
    for (const state of states) {
      const quest = this.TryGetChild(Quest, BigInt(state.questConfigId));
      if (!quest) continue;
      quest.Restore(state);
    }
  }

  /**
   * 领取任务奖励使用稳定operationId提交完整玩家事务；DBProxy确认前不修改Quest或Item Entity。
   * 上一次ACK不确定时先查回执，并按首次持久化结果补齐内存，绝不重新计算或重复发奖。
   *
   * Claims a quest reward through one full-player transaction with a stable
   * operationId. Quest and Item Entities remain unchanged until DBProxy confirms
   * the commit. An uncertain retry recovers the original receipt and never grants twice.
   */
  async CompleteQuest(questConfigId: number): Promise<QuestRewardResult> {
    const player = this.GetParent() as PlayerUnit;
    const persistence = player.GetComponent(PlayerPersistenceComponent);
    const operationId = questRewardOperationId(player.Account, questConfigId);
    const quest = this.TryGetChild(Quest, BigInt(questConfigId));
    if (!quest || persistence.IsTransactionUncertain(operationId)) {
      const receipt = await persistence.LoadTransaction(operationId);
      if (receipt) {
        const recovered = decodeQuestReward(receipt.result, questConfigId);
        if (quest) {
          player.GetComponent(ItemComponent).ApplyCommittedGrantItems(recovered.rewardItems);
          this.RestoreTransfer(this.completionState(questConfigId));
        }
        return recovered;
      }
    }
    if (!quest) {
      throw new RpcError(GameErrCode.QuestNotFound, `active quest not found: ${questConfigId}`);
    }
    if (quest.Snapshot().status !== QuestStatus.ReadyToTurnIn) {
      throw new RpcError(GameErrCode.QuestNotComplete, `quest is not complete: ${questConfigId}`);
    }
    const config = GameConfigs.QuestConfig.Get(questConfigId);
    const inventoryPlan = PlanTransactionalReward(player, {
      actions: [ActionFromConfig(config.rewardActionType, config.rewardActionParams)],
    });
    const nextQuests = this.completionState(questConfigId);
    const proposed: QuestRewardResult = {
      questConfigId,
      rewardItems: [...inventoryPlan.affectedItems],
    };
    const encodedResult = M2C_CompleteQuestCodec.encode(proposed);
    const committed = await persistence.ApplyTransaction(
      operationId,
      persistence.Capture("quest-reward", {
        items: inventoryPlan.nextItems,
        quests: nextQuests,
      }),
      encodedResult,
    );
    const durable = decodeQuestReward(committed.result, questConfigId);
    if (bytesEqual(committed.result, encodedResult)) {
      player.GetComponent(ItemComponent).CommitGrantPlan(inventoryPlan);
    } else {
      player.GetComponent(ItemComponent).ApplyCommittedGrantItems(durable.rewardItems);
    }
    this.RestoreTransfer(nextQuests);
    return durable;
  }

  Snapshot(): readonly QuestState[] { return this.GetChildren(Quest).map((quest) => quest.Snapshot()); }
  CompletedQuestConfigIds(): readonly number[] { return [...this.completedQuestConfigIds].sort((a, b) => a - b); }
  HasCompletedQuest(questConfigId: number): boolean { return this.completedQuestConfigIds.has(questConfigId); }

  /** 返回当前所有已接取任务对同一目标还需要的最大数量；一件物品可同时推进多个相同目标。 / Returns the maximum remaining count across accepted matching objectives; one item can advance several matching quests. */
  RemainingProgress(objectiveType: number, targetConfigId: number): number {
    const entries = this.objectiveIndex.get(objectiveIndexKey(objectiveType, targetConfigId));
    if (!entries) return 0;
    let remaining = 0;
    for (const entry of entries) {
      const quest = this.TryGetChild(Quest, BigInt(entry.questConfigId));
      if (!quest) continue;
      const state = quest.Snapshot();
      if (state.status !== QuestStatus.InProgress) continue;
      const objective = state.objectives.find((value) => value.objectiveId === entry.objectiveId);
      if (objective) remaining = Math.max(remaining, objective.required - objective.current);
    }
    return Math.max(0, remaining);
  }

  CaptureTransfer(): QuestTransferState {
    return { active: this.Snapshot(), completedQuestConfigIds: this.CompletedQuestConfigIds() };
  }

  RestoreTransfer(state: QuestTransferState): void {
    for (const quest of this.GetChildren(Quest)) this.RemoveChild(Quest, quest.Id);
    this.objectiveIndex.clear();
    this.completedQuestConfigIds.clear();
    for (const id of state.completedQuestConfigIds) this.completedQuestConfigIds.add(id);
    for (const snapshot of state.active) {
      const quest = this.AddChild(Quest, BigInt(snapshot.questConfigId), {
        configId: snapshot.questConfigId,
        objectives: snapshot.objectives,
        status: snapshot.status,
        revision: snapshot.revision,
      });
      this.IndexQuest(quest);
    }
  }

  private completionState(questConfigId: number): QuestTransferState {
    if (!this.TryGetChild(Quest, BigInt(questConfigId))) {
      throw new Error(`cannot complete missing quest locally: ${questConfigId}`);
    }
    return {
      active: this.Snapshot().filter((state) => state.questConfigId !== questConfigId),
      completedQuestConfigIds: [...new Set([
        ...this.CompletedQuestConfigIds(),
        questConfigId,
      ])].sort((left, right) => left - right),
    };
  }

  Deserialize(): void {
    this.objectiveIndex.clear();
    for (const quest of this.GetChildren(Quest)) {
      GameConfigs.QuestConfig.Get(quest.ConfigId);
      this.IndexQuest(quest);
    }
  }

  /** 配置条件是接取提交前的最终不变量；即使Veto监听器漏注册也不能绕过。 / Config conditions are final acceptance invariants and cannot be bypassed when a Veto handler is missing. */
  private RequireConfigConditions(player: PlayerUnit, config: import("#tiangz/model").QuestConfigData): void {
    for (const requiredQuestId of config.requiredQuestIds) {
      if (!this.completedQuestConfigIds.has(requiredQuestId)) {
        throw new RpcError(GameErrCode.QuestPrerequisiteNotMet, `quest ${config.id} requires completed quest ${requiredQuestId}`);
      }
    }
    const level = player.GetComponent(NumericComponent)[NumericType.Level];
    if (level < BigInt(config.minimumLevel)) {
      throw new RpcError(GameErrCode.QuestLevelTooLow, `quest ${config.id} requires level ${config.minimumLevel}`);
    }
  }

  private IndexQuest(quest: Quest): void {
    for (const state of quest.Snapshot().objectives) {
      const objective = GameConfigs.QuestObjectiveConfig.Get(state.objectiveId);
      const key = objectiveIndexKey(objective.objectiveType, objective.targetConfigId);
      const entries = this.objectiveIndex.get(key) ?? [];
      entries.push({ questConfigId: quest.ConfigId, objectiveId: state.objectiveId });
      this.objectiveIndex.set(key, entries);
    }
  }

  private UnindexQuest(quest: Quest): void {
    for (const state of quest.Snapshot().objectives) {
      const objective = GameConfigs.QuestObjectiveConfig.Get(state.objectiveId);
      const key = objectiveIndexKey(objective.objectiveType, objective.targetConfigId);
      const entries = this.objectiveIndex.get(key);
      if (!entries) throw new Error(`quest ${quest.ConfigId} is missing objective index ${key}`);
      const remaining = entries.filter((entry) => entry.questConfigId !== quest.ConfigId || entry.objectiveId !== state.objectiveId);
      if (remaining.length === 0) this.objectiveIndex.delete(key);
      else this.objectiveIndex.set(key, remaining);
    }
  }
}

function objectiveIndexKey(objectiveType: number, targetConfigId: number): string {
  return `${objectiveType}:${targetConfigId}`;
}

function questRewardOperationId(account: string, questConfigId: number): string {
  return `quest-reward:${account}:${questConfigId}`;
}

function decodeQuestReward(payload: Uint8Array, questConfigId: number): QuestRewardResult {
  const result = M2C_CompleteQuestCodec.decode(payload);
  if (result.questConfigId !== questConfigId) {
    throw new Error(
      `quest reward receipt mismatch: ${result.questConfigId} != ${questConfigId}`,
    );
  }
  return { questConfigId, rewardItems: result.rewardItems.map((item) => ({ ...item })) };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
