import {
  ActionType,
  GameConfigs,
  GameErrCode,
  ItemComponent,
  Quest,
  QuestComponent,
  type QuestProgressEvent,
  type QuestRewardResult,
  type QuestState,
  type QuestTransferState,
  RpcError,
  type ITransfer,
  systemFor,
} from "#tiangz/model";
import { ActionFromConfig, ExecuteAction } from "../action/ActionExecutor";

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
    const objectives = config.objectiveIds.map((objectiveId) => {
      const objective = GameConfigs.QuestObjectiveConfig.Get(objectiveId);
      if (objective.questConfigId !== questConfigId) {
        throw new Error(`quest objective owner mismatch: ${objectiveId} -> ${objective.questConfigId}`);
      }
      return { objectiveId, current: 0, required: objective.requiredCount };
    });
    const quest = this.AddChild(Quest, BigInt(questConfigId), { configId: questConfigId, objectives });
    return quest.Snapshot();
  }

  /** 处理本Scene内的业务事实；只修改匹配目标，并把广播交给MapComponent。 / Applies a Scene-local fact to matching objectives and delegates owner sync to MapComponent. */
  ApplyProgress(event: QuestProgressEvent): readonly QuestState[] {
    const changed: QuestState[] = [];
    for (const quest of this.GetChildren(Quest)) {
      for (const state of quest.Snapshot().objectives) {
        const objective = GameConfigs.QuestObjectiveConfig.Get(state.objectiveId);
        if (objective.objectiveType !== event.objectiveType || objective.targetConfigId !== event.targetConfigId) continue;
        if (quest.Advance(state.objectiveId, event.count)) changed.push(quest.Snapshot());
      }
    }
    return changed;
  }

  CompleteQuest(questConfigId: number): QuestRewardResult {
    const quest = this.TryGetChild(Quest, BigInt(questConfigId));
    if (!quest) throw new RpcError(GameErrCode.QuestNotFound, `active quest not found: ${questConfigId}`);
    if (!quest.Snapshot().readyToComplete) {
      throw new RpcError(GameErrCode.QuestNotComplete, `quest is not complete: ${questConfigId}`);
    }
    const config = GameConfigs.QuestConfig.Get(questConfigId);
    const result = ExecuteAction(this.GetParent(), ActionFromConfig(config.rewardActionType, config.rewardActionParams), {
      reason: "quest-reward",
    });
    this.completedQuestConfigIds.add(questConfigId);
    this.RemoveChild(Quest, BigInt(questConfigId));
    return { questConfigId, rewardItems: result.grantedItem ? [result.grantedItem] : [] };
  }

  Snapshot(): readonly QuestState[] { return this.GetChildren(Quest).map((quest) => quest.Snapshot()); }
  CompletedQuestConfigIds(): readonly number[] { return [...this.completedQuestConfigIds].sort((a, b) => a - b); }

  CaptureTransfer(): QuestTransferState {
    return { active: this.Snapshot(), completedQuestConfigIds: this.CompletedQuestConfigIds() };
  }

  RestoreTransfer(state: QuestTransferState): void {
    for (const quest of this.GetChildren(Quest)) this.RemoveChild(Quest, quest.Id);
    this.completedQuestConfigIds.clear();
    for (const id of state.completedQuestConfigIds) this.completedQuestConfigIds.add(id);
    for (const snapshot of state.active) {
      this.AddChild(Quest, BigInt(snapshot.questConfigId), {
        configId: snapshot.questConfigId,
        objectives: snapshot.objectives,
        revision: snapshot.revision,
      });
    }
  }

  Deserialize(): void {
    for (const quest of this.GetChildren(Quest)) GameConfigs.QuestConfig.Get(quest.ConfigId);
  }
}
