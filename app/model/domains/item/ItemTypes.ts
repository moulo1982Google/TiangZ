/**
 * 不绑定协议的道具值；网络层可以把它投影成自己的Snapshot。
 * Protocol-neutral item value; each network layer may project it to its own Snapshot.
 */
export interface ItemState {
  readonly itemId: bigint;
  readonly configId: number;
  readonly count: number;
  readonly quality: number;
  readonly level: number;
  readonly version: number;
}

export interface InventoryGrant {
  readonly configId: number;
  readonly count: number;
}

export interface InventoryGrantPlan<TItem extends ItemState = ItemState> {
  readonly baseItems: readonly TItem[];
  readonly nextItems: readonly TItem[];
  readonly affectedItems: readonly TItem[];
}

export interface InventoryConsumePlan<TItem extends ItemState = ItemState> {
  readonly baseItems: readonly TItem[];
  readonly nextItems: readonly TItem[];
  readonly consumedItem: TItem;
}
