import {
  GameErrCode,
  Item,
  ItemComponent,
  type ItemSnapshot,
  type ItemView,
  RpcError,
  systemFor,
} from "#tiangz/model";

/** 承载背包集合的可热更规则；子 Item Entity 和 Native handle 的销毁由 Core 所有权链保证。 / Hosts hot-reloadable inventory collection rules; Core ownership disposes child Item entities and Native handles. */
@systemFor(ItemComponent)
export class ItemComponentSystem extends ItemComponent {
  /** 创建一件演示道具；生产加载应从持久化数据组合背包。 / Seeds one demo item; production loading should compose inventory from persisted data. */
  protected override Awake(): void {
    this.Create(1, 1001, 3);
  }

  /** 返回短期只读视图；不得跨 await 或玩家生命周期保存。 / Returns a short-lived read-only view that must not cross await or player lifetime boundaries. */
  GetItem(itemId: number): ItemView | undefined {
    return this.TryGetChild(Item, itemId);
  }

  /** 复制当前背包用于全量同步或持久化，不暴露子 Entity 或 Native handle。 / Copies inventory for full sync or persistence without exposing child entities or Native handles. */
  Snapshot(): ItemSnapshot[] {
    return this.GetChildren(Item).map((item) => item.Snapshot());
  }

  /** 消耗一件道具并返回不可覆盖事件所需快照。 / Consumes one item and returns the snapshot required by a non-coalescing event. */
  UseItem(itemId: number): ItemSnapshot {
    const item = this.requireItem(itemId);
    if (item.count === 0) {
      throw new RpcError(GameErrCode.ItemNotEnough, `item ${itemId} is empty`);
    }
    return item.RemoveCount(1);
  }

  /** 增加已有堆叠并返回权威快照。 / Adds to an existing stack and returns its authoritative snapshot. */
  AddItem(itemId: number, count: number): ItemSnapshot {
    return this.requireItem(itemId).AddCount(count);
  }

  /** 原子扣除已校验数量；失败时不改变堆叠。 / Atomically removes a validated count or leaves the stack unchanged. */
  RemoveItem(itemId: number, count: number): ItemSnapshot {
    const item = this.requireItem(itemId);
    if (item.count < count) {
      throw new RpcError(GameErrCode.ItemNotEnough, `item ${itemId} is not enough`);
    }
    return item.RemoveCount(count);
  }

  private Create(itemId: number, configId: number, count: number): Item {
    return this.AddChild(Item, itemId, { configId, count });
  }

  private requireItem(itemId: number): Item {
    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
      throw new RpcError(GameErrCode.ItemNotFound, `invalid item id: ${itemId}`);
    }
    const item = this.TryGetChild(Item, itemId);
    if (!item) throw new RpcError(GameErrCode.ItemNotFound, `item not found: ${itemId}`);
    return item;
  }
}
