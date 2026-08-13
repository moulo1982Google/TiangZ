import { ChildEntity, lifecycle } from "../../../core/public";

export interface QuestObjectiveState {
  readonly objectiveId: number;
  current: number;
  readonly required: number;
}

export interface AwakeQuest {
  readonly configId: number;
  readonly objectives: readonly QuestObjectiveState[];
  readonly status?: number;
  readonly revision?: number;
}

export interface QuestState {
  readonly questConfigId: number;
  readonly objectives: readonly QuestObjectiveState[];
  readonly status: number;
  readonly revision: number;
}

export interface Quest {
  readonly ConfigId: number;
  Snapshot(): QuestState;
  Advance(objectiveId: number, count: number): boolean;
  Restore(state: QuestState): void;
}

/** 任务实体只保存冻结目标和进度，不读取地图或协议。 / Quest entities store frozen objectives and progress without map or protocol knowledge. */
@lifecycle({ awake: true })
export class Quest extends ChildEntity<[request: AwakeQuest]> {
  protected configId = 0;
  protected objectives: QuestObjectiveState[] = [];
  protected status = 1;
  protected revision = 0;
}
