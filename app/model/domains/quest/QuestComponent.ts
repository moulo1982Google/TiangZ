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

/**
 * QuestComponent只拥有活动Quest和完成记录；NPC、目标类型、奖励和协议由领域适配器决定。
 * QuestComponent owns active quests and completion history; NPCs, objective
 * types, rewards, and protocols belong to the domain adapter.
 */
@component()
@transferable()
@lifecycle({ awake: true, deserialize: true })
export class QuestComponent extends Component {
  protected readonly completedQuestConfigIds = new Set<number>();
  /** 目标索引仅用于当前进程的快速查询，不参与传送或持久化。 / Runtime objective index for fast local queries; excluded from transfer and persistence. */
  protected readonly objectiveIndex = new Map<string, QuestObjectiveIndexEntry[]>();
}
