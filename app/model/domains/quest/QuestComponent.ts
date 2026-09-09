import { Component, component, lifecycle, transferable } from "../../../core/public";
import type { QuestState } from "./Quest";

export interface QuestObjectiveIndexEntry {
  readonly questConfigId: number;
  readonly objectiveId: number;
}

export interface QuestTransferState {
  readonly active: readonly QuestState[];
  readonly completedQuestConfigIds: readonly number[];
  readonly rewardDeliveries?: readonly QuestRewardDelivery[];
}

/** 与奖励原子保存的模块消息；模块负责解释payload和确认目标端幂等提交。 / Opaque module messages committed with rewards; consumers own payload semantics and idempotent acknowledgement. */
export interface QuestRewardDelivery {
  readonly id: string;
  readonly ownerId: string;
  readonly payload: string;
}

/** 校验并复制有界投递队列；旧快照没有队列时按空集合读取。 / Validates and copies a bounded queue, treating legacy snapshots as empty. */
export function NormalizeQuestRewardDeliveries(value: unknown): QuestRewardDelivery[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128) throw new Error("quest reward delivery queue exceeds 128 records");
  const ids = new Set<string>();
  let bytes = 0;
  return value.map((entry) => {
    if (!entry || typeof entry !== "object"
      || typeof entry.id !== "string" || entry.id.length === 0 || entry.id.length > 256
      || typeof entry.ownerId !== "string" || !/^[a-zA-Z0-9_.-]{1,128}$/.test(entry.ownerId)
      || typeof entry.payload !== "string" || entry.payload.length > 8192
      || ids.has(entry.id)) throw new Error("invalid quest reward delivery");
    ids.add(entry.id);
    bytes += entry.payload.length;
    if (bytes > 65536) throw new Error("quest reward delivery queue payload exceeds limit");
    return { id: entry.id, ownerId: entry.ownerId, payload: entry.payload };
  });
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
  protected rewardDeliveries: QuestRewardDelivery[] = [];
  /** 目标索引仅用于当前进程的快速查询，不参与传送或持久化。 / Runtime objective index for fast local queries; excluded from transfer and persistence. */
  protected readonly objectiveIndex = new Map<string, QuestObjectiveIndexEntry[]>();
}
