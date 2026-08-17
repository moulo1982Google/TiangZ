import { Component, component, lifecycle, transferable } from "../../../core/public";
import type { ItemState } from "./ItemTypes";

export type { InventoryConsumePlan, InventoryGrant, InventoryGrantPlan, InventoryReplacePlan, ItemState } from "./ItemTypes";

export interface InventoryGrantResult<TItem extends ItemState = ItemState> {
  readonly items: readonly TItem[];
}

/**
 * ItemComponent是通用背包集合的生命周期容器；堆叠、使用效果和协议返回由领域适配器实现。
 * ItemComponent is the lifecycle container for a reusable inventory; stacking,
 * use effects, and protocol responses belong to the domain adapter.
 */
@component()
@transferable()
@lifecycle({ awake: true })
export class ItemComponent extends Component {}
