import type { ActionDefinition } from "../action/ActionDefinition";

/**
 * 通用奖励计划。奖励只是有序Action数据，不持有玩家、Item、Entity或数据库连接。
 * A reusable reward plan is ordered Action data; it owns no player, Item,
 * Entity, or database connection.
 */
export interface RewardPlan {
  readonly actions: readonly ActionDefinition[];
  /** 可选的业务幂等键；持久化事务仍由DBProxy负责。 / Optional business idempotency key; DBProxy still owns durable transactions. */
  readonly operationId?: string;
}
