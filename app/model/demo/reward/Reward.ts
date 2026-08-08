import type { ActionDefinition } from "../action/ActionType";
import type { ItemSnapshot } from "../../../generated/model/server/demo/protocol/messages";

/**
 * 一份奖励只描述要执行的Action，不持有玩家、Item或数据库引用。
 * 奖励执行器会把这些Action交给目标Unit的Inventory/Combat/Buff边界处理。
 *
 * A reward describes Actions only; it holds no player, Item, or database
 * reference. The reward executor delegates those Actions to the target Unit's
 * Inventory, Combat, and Buff boundaries.
 */
export interface RewardDefinition {
  readonly actions: readonly ActionDefinition[];
}

/** 奖励执行后的短期结果；Item快照用于协议广播，不是持久化对象。 / Short-lived reward result; Item snapshots are for protocol publication, not persistence objects. */
export interface RewardResult {
  readonly changed: boolean;
  readonly items: readonly ItemSnapshot[];
}
