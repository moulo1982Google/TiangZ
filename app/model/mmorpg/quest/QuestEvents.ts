import { defineSyncEvent, defineVetoEvent, SystemErrCode } from "../../../core/public";
import type { PlayerUnit } from "../map/PlayerUnit";
import type { QuestComponent } from "./QuestComponent";
import type { QuestContentDefinition } from "./QuestContentProfileComponent";
import type { QuestState } from "./Quest";
import type { ItemState } from "../../domains/item/ItemTypes";

/** 接取提交前的同步只读上下文；监听器不得创建Quest、改Numeric或启动异步任务。 / Read-only context before quest acceptance; handlers must not create quests, mutate Numeric, or start async work. */
export interface BeforeAcceptQuestEvent {
  readonly player: PlayerUnit;
  readonly quests: QuestComponent;
  readonly config: Readonly<QuestContentDefinition>;
}

export interface QuestProgressEvent {
  readonly player: PlayerUnit;
  readonly objectiveType: number;
  readonly targetConfigId: number;
  readonly count: number;
}

/** 任务接取事务提交后的同步事实，供游戏模块和表现系统追加行为。 / Post-commit quest acceptance fact available to game modules and presentation systems. */
export interface QuestAcceptedEvent {
  readonly player: PlayerUnit;
  readonly quest: QuestState;
  /** 0表示自动接取或非NPC来源。 / Zero denotes an automatic or non-NPC source. */
  readonly sourceUnitId: number;
  readonly inventoryChanges: readonly ItemState[];
}

/**
 * 提交后的任务奖励事实；来源 NPC 只携带稳定的地图内 UnitId，供表现模块监听。
 * Post-commit quest reward fact; the source NPC is carried only as a stable
 * map-local UnitId so presentation modules can react without owning quest or
 * reward state. A zero source denotes an automatic, story, or GM reward.
 */
export interface QuestRewardedEvent {
  readonly player: PlayerUnit;
  readonly questConfigId: number;
  readonly sourceUnitId: number;
}

export const QuestEvents = {
  BeforeAccept: defineVetoEvent<BeforeAcceptQuestEvent, number>(
    "Quest.BeforeAccept",
    SystemErrCode.Success,
  ),
  Accepted: defineSyncEvent<QuestAcceptedEvent>("Quest.Accepted"),
  Rewarded: defineSyncEvent<QuestRewardedEvent>("Quest.Rewarded"),
  Progress: defineSyncEvent<QuestProgressEvent>("Quest.Progress"),
} as const;
