import { Component, component, lifecycle, transferable } from "../../../core/public";
import type {
  ItemSnapshot,
  M2C_UseItem,
} from "../../../generated/model/server/demo/protocol/messages";

/** 一次背包发放请求；数量按ItemConfig.maxStack自动合并或拆成多个Item。 / One inventory grant request; maxStack decides merging and splitting. */
export interface InventoryGrant {
  readonly configId: number;
  readonly count: number;
}

/** 背包发放结果只返回受影响堆叠的最新快照，不暴露Item Entity。 / Grant results expose only latest affected stack snapshots, never Item Entities. */
export interface InventoryGrantResult {
  readonly items: readonly ItemSnapshot[];
}

/**
 * 背包发放的纯数据计划。baseItems用于提交前防止陈旧计划覆盖新状态；nextItems可直接进入持久化快照。
 * 计划不持有Item Entity或Native handle，可以安全跨DBProxy调用保存，但只能由创建它的ItemComponent提交。
 *
 * Pure-value inventory grant plan. baseItems prevents a stale plan from
 * overwriting newer state, while nextItems can enter persistence directly. It
 * owns no Item Entity or Native handle and must be committed by its creator.
 */
export interface InventoryGrantPlan {
  readonly baseItems: readonly ItemSnapshot[];
  readonly nextItems: readonly ItemSnapshot[];
  readonly affectedItems: readonly ItemSnapshot[];
}

/**
 * 单个堆叠扣除的纯数据计划。事务提交前只把nextItems写入持久快照，不能提前修改Item Entity。
 * Pure-value plan for consuming one stack. Only nextItems enters persistence
 * before the transaction commits; Item Entities must remain untouched.
 */
export interface InventoryConsumePlan {
  readonly baseItems: readonly ItemSnapshot[];
  readonly nextItems: readonly ItemSnapshot[];
  readonly consumedItem: ItemSnapshot;
}

export interface ItemComponent {
  Snapshot(): ItemSnapshot[];
  CaptureTransfer(): ItemSnapshot[];
  RestoreTransfer(items: readonly ItemSnapshot[]): void;
  GrantItem(configId: number, count: number): readonly ItemSnapshot[];
  GrantItems(grants: readonly InventoryGrant[]): readonly ItemSnapshot[];
  PlanGrantItems(grants: readonly InventoryGrant[]): InventoryGrantPlan;
  CommitGrantPlan(plan: InventoryGrantPlan): readonly ItemSnapshot[];
  ApplyCommittedGrantItems(items: readonly ItemSnapshot[]): readonly ItemSnapshot[];
  PlanConsumeItem(itemId: bigint, count?: number): InventoryConsumePlan;
  CommitConsumePlan(plan: InventoryConsumePlan): ItemSnapshot;
  ApplyCommittedConsumeItem(item: ItemSnapshot): ItemSnapshot;
  UseItemTransactional(itemId: bigint, clientOperationId: string): Promise<M2C_UseItem>;
}

@component()
@transferable()
@lifecycle({ awake: true })
export class ItemComponent extends Component {}
