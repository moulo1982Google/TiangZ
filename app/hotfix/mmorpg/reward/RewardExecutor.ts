import {
  ActionType,
  type ActionExecutionContext,
  type InventoryGrant,
  type InventoryGrantPlan,
  ItemComponent,
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

/**
 * 把关键奖励转换为纯Inventory计划。当前事务版只接受GrantItem，防止Heal/Buff等运行态效果
 * 被误认为已经与数据库原子提交；扩展新Action前必须先提供对应的纯数据Planner。
 *
 * Converts a critical reward into a pure Inventory plan. The transactional
 * path currently accepts GrantItem only, preventing runtime effects such as
 * Heal or Buff from being mistaken for durable atomic writes. Every new Action
 * requires its own pure-data planner before it may enter this path.
 */
export function PlanTransactionalReward(
  target: Unit<any[]>,
  reward: RewardDefinition,
): InventoryGrantPlan {
  const grants: InventoryGrant[] = reward.actions.map((action) => {
    if (action.type !== ActionType.GrantItem || action.parameters.length !== 2) {
      throw new Error(
        `transactional reward only supports GrantItem actions: ${action.type}`,
      );
    }
    const configId = toPositiveSafeInteger(action.parameters[0], "reward item configId");
    const count = toPositiveSafeInteger(action.parameters[1], "reward item count");
    return { configId, count };
  });
  return target.GetComponent(ItemComponent).PlanGrantItems(grants);
}

function toPositiveSafeInteger(value: bigint, name: string): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted <= 0 || BigInt(converted) !== value) {
    throw new Error(`${name} must be a positive safe integer: ${value}`);
  }
  return converted;
}
