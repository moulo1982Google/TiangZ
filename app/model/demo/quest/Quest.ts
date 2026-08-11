import { ChildEntity, lifecycle } from "../../../core/public";
import type { QuestStatus } from "../../../generated/model/config";

export interface QuestObjectiveState {
  readonly objectiveId: number;
  current: number;
  readonly required: number;
}

export interface AwakeQuest {
  readonly configId: number;
  readonly objectives: readonly QuestObjectiveState[];
  readonly status?: QuestStatus;
  readonly revision?: number;
}

export interface QuestState {
  readonly questConfigId: number;
  readonly objectives: readonly QuestObjectiveState[];
  readonly status: QuestStatus;
  readonly revision: number;
}

export interface Quest {
  readonly ConfigId: number;
  Snapshot(): QuestState;
  Advance(objectiveId: number, count: number): boolean;
  Restore(state: QuestState): void;
}

/**
 * 进行中的任务是QuestComponent拥有的ChildEntity；只保存接取时冻结的目标与进度。
 * 配置热更只影响新接取任务，不能追溯改写玩家已经进行中的目标。
 *
 * An active quest is a ChildEntity owned by QuestComponent and stores only
 * accepted objective snapshots and progress. Hot config reload affects newly
 * accepted quests and never rewrites in-flight player objectives.
 */
@lifecycle({ awake: true })
export class Quest extends ChildEntity<[request: AwakeQuest]> {
  protected configId = 0;
  protected objectives: QuestObjectiveState[] = [];
  protected status: QuestStatus = 1;
  protected revision = 0;
}
