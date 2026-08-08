import { defineSyncEvent, defineVetoEvent, SystemErrCode } from "../../../core/public";
import type { QuestConfig } from "../../../generated/model/config";
import type { PlayerUnit } from "../map/PlayerUnit";
import type { QuestComponent } from "./QuestComponent";

/** 接取提交前的同步只读上下文；监听器不得创建Quest、改Numeric或启动异步任务。 / Read-only context before quest acceptance; handlers must not create quests, mutate Numeric, or start async work. */
export interface BeforeAcceptQuestEvent {
  readonly player: PlayerUnit;
  readonly quests: QuestComponent;
  readonly config: QuestConfig;
}

export interface QuestProgressEvent {
  readonly player: PlayerUnit;
  readonly objectiveType: number;
  readonly targetConfigId: number;
  readonly count: number;
}

export const QuestEvents = {
  BeforeAccept: defineVetoEvent<BeforeAcceptQuestEvent, number>(
    "Quest.BeforeAccept",
    SystemErrCode.Success,
  ),
  Progress: defineSyncEvent<QuestProgressEvent>("Quest.Progress"),
} as const;
