import {
  type ActionExecutionContext,
  type RewardDefinition,
  type RewardResult,
  type Unit,
} from "#tiangz/model";
import { ExecuteActionBatch } from "../action/ActionExecutor";

/**
 * 统一执行任务、掉落和GM奖励；背包堆叠规则仍只在ItemComponent中实现。
 * 这里是同步的业务提交边界，不是假装替代DB事务；跨服务持久化由后续独立DBProxy负责。
 *
 * Executes quest, loot, and GM rewards through one boundary while keeping stack
 * rules inside ItemComponent. This is synchronous business commit, not a fake
 * database transaction; cross-service durability belongs to the later DBProxy.
 */
export function ExecuteReward(
  target: Unit<any[]>,
  reward: RewardDefinition,
  context: ActionExecutionContext = {},
): RewardResult {
  const result = ExecuteActionBatch(target, reward.actions, {
    ...context,
    reason: context.reason ?? "reward",
  });
  return {
    changed: result.changed,
    items: result.grantedItems,
  };
}
