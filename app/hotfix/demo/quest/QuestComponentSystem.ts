import {
  ActionType,
  GameConfigs,
  GameErrCode,
  ItemComponent,
  NumericComponent,
  NumericType,
  PlayerUnit,
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
import { ExecuteReward } from "../reward/RewardExecutor";

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

  CompleteQuest(questConfigId: number): QuestRewardResult {
    const quest = this.TryGetChild(Quest, BigInt(questConfigId));
    if (!quest) throw new RpcError(GameErrCode.QuestNotFound, `active quest not found: ${questConfigId}`);
    if (quest.Snapshot().status !== QuestStatus.ReadyToTurnIn) {
      throw new RpcError(GameErrCode.QuestNotComplete, `quest is not complete: ${questConfigId}`);
    }
    const config = GameConfigs.QuestConfig.Get(questConfigId);
    const result = ExecuteReward(this.GetParent(), {
      actions: [ActionFromConfig(config.rewardActionType, config.rewardActionParams)],
    }, { reason: "quest-reward" });
    this.completedQuestConfigIds.add(questConfigId);
    this.UnindexQuest(quest);
    this.RemoveChild(Quest, BigInt(questConfigId));
    return { questConfigId, rewardItems: [...result.items] };
  }

  Snapshot(): readonly QuestState[] { return this.GetChildren(Quest).map((quest) => quest.Snapshot()); }
  CompletedQuestConfigIds(): readonly number[] { return [...this.completedQuestConfigIds].sort((a, b) => a - b); }
  HasCompletedQuest(questConfigId: number): boolean { return this.completedQuestConfigIds.has(questConfigId); }

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
