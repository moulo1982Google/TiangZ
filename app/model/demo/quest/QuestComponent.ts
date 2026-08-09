import { Component, component, lifecycle, transferable } from "../../../core/public";
import type { QuestState } from "./Quest";

export interface QuestObjectiveIndexEntry {
  readonly questConfigId: number;
  readonly objectiveId: number;
}

export interface QuestTransferState {
  readonly active: readonly QuestState[];
  readonly completedQuestConfigIds: readonly number[];
}

export interface QuestRewardResult {
  readonly questConfigId: number;
  readonly rewardItems: readonly import("../../../generated/model/server/demo/protocol/messages").ItemSnapshot[];
}

export interface QuestComponent {
  AcceptQuest(questConfigId: number): QuestState;
  CompleteQuest(questConfigId: number): Promise<QuestRewardResult>;
  Snapshot(): readonly QuestState[];
  CompletedQuestConfigIds(): readonly number[];
  HasCompletedQuest(questConfigId: number): boolean;
  ApplyProgress(event: import("./QuestEvents").QuestProgressEvent): readonly QuestState[];
}

/** 玩家任务集合；活动任务为ChildEntity，完成记录只保存配置ID。 / Player quest collection: active quests are ChildEntities and completed history stores config IDs only. */
@component()
@transferable()
@lifecycle({ awake: true, deserialize: true })
export class QuestComponent extends Component {
  protected readonly completedQuestConfigIds = new Set<number>();
  /** 由活动Quest重建的运行时索引，不进入传送或持久化快照。 / Runtime index rebuilt from active quests and excluded from transfer/persistence snapshots. */
  protected readonly objectiveIndex = new Map<string, QuestObjectiveIndexEntry[]>();
}
