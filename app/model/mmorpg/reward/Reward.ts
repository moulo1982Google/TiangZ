import type { ItemSnapshot } from "../../../generated/model/server/demo/protocol/messages";
import type { RewardPlan } from "../../domains/reward/RewardPlan";

/**
 * MMORPG奖励适配器沿用通用RewardPlan；这个别名保留旧业务命名，避免任务与掉落代码无谓改写。
 * The MMORPG adapter aliases the reusable RewardPlan; this legacy name keeps
 * quest and loot code readable without duplicating the contract.
 */
export type RewardDefinition = RewardPlan;

/** MMORPG协议把通用RewardPlan的执行结果投影为ItemSnapshot。 / MMORPG projects execution results to ItemSnapshot. */
export interface RewardResult {
  readonly changed: boolean;
  readonly items: readonly ItemSnapshot[];
}
