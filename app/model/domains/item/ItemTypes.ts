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
  readonly durability?: number;
  readonly maxDurability?: number;
  /** 模块解释的不透明放置编号；0 表示未放置。 / Module-interpreted opaque placement ID; zero means unplaced. */
  readonly placementId?: number;
}

export interface InventoryGrant {
  readonly configId: number;
  readonly count: number;
}

/** 新聚合体的一次性精确物品种子；放置语义由外置游戏模块拥有。 / Exact one-time item seed for a new aggregate; placement semantics belong to the external game module. */
export interface InventorySeed extends InventoryGrant {
  readonly placementId?: number;
}

export interface InventoryConsumeByConfig {
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

/** 完整背包替换计划用于跨玩家事务等批量所有权变更；它不是客户端可提交的任意快照。 / Full inventory replacement plan for batched ownership changes such as player trade; it is never an arbitrary client-supplied snapshot. */
export interface InventoryReplacePlan<TItem extends ItemState = ItemState> {
  readonly baseItems: readonly TItem[];
  readonly nextItems: readonly TItem[];
}


/** 基于值快照原子规划按配置消耗与发放。 / Atomically plans config-based consumption and grants on value snapshots. */
export interface InventoryExchangePlan<TItem extends ItemState = ItemState>
  extends InventoryReplacePlan<TItem> {
  readonly affectedItems: readonly TItem[];
  readonly grantedItems: readonly TItem[];
}

/** 耐久修复的纯快照计划；费用以最小货币单位表示。 / Pure snapshot plan for durability repair; cost uses the smallest currency unit. */
export interface InventoryRepairPlan<TItem extends ItemState = ItemState>
  extends InventoryReplacePlan<TItem> {
  readonly affectedItems: readonly TItem[];
  readonly cost: bigint;
}
