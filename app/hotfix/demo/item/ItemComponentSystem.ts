import {
  GameErrCode,
  GameConfigs,
  GlobalIdSystem,
  Item,
  ItemComponent,
  type ItemSnapshot,
  type ItemView,
  type ITransfer,
  RpcError,
  requireGlobalId,
  systemFor,
} from "#tiangz/model";

/** 承载背包集合的可热更规则；子 Item Entity 和 Native handle 的销毁由 Core 所有权链保证。 / Hosts hot-reloadable inventory collection rules; Core ownership disposes child Item entities and Native handles. */
@systemFor(ItemComponent)
export class ItemComponentSystem extends ItemComponent implements ITransfer<readonly ItemSnapshot[]> {
  /** 创建一件演示道具；生产加载应从持久化数据组合背包。 / Seeds one demo item; production loading should compose inventory from persisted data. */
  protected override Awake(): void {
    const playerConfig = GameConfigs.PlayerConfig.Get(1);
    this.CreateItem(
      playerConfig.initialItemConfigId,
      playerConfig.initialItemCount,
    );
  }

  /** 返回短期只读视图；不得跨 await 或玩家生命周期保存。 / Returns a short-lived read-only view that must not cross await or player lifetime boundaries. */
  GetItem(itemId: bigint): ItemView | undefined {
    return this.TryGetChild(Item, itemId);
  }

  /** 复制当前背包用于全量同步或持久化，不暴露子 Entity 或 Native handle。 / Copies inventory for full sync or persistence without exposing child entities or Native handles. */
  Snapshot(): ItemSnapshot[] {
    return this.GetChildren(Item).map((item) => item.Snapshot());
  }

  /** 导出不包含子Entity引用和Native handle的背包快照。 / Exports an inventory snapshot without child Entity references or Native handles. */
  CaptureTransfer(): ItemSnapshot[] {
    return this.Snapshot();
  }

  /** 用迁移快照替换目标Unit初始化出的默认背包。 / Replaces the target Unit's default inventory with the transferred snapshot. */
  RestoreTransfer(items: readonly ItemSnapshot[]): void {
    for (const item of this.GetChildren(Item)) {
      this.RemoveChild(Item, item.Id);
    }
    for (const item of items) this.CreateItemById(item.itemId, item);
  }

  /** 消耗一件道具并返回不可覆盖事件所需快照。 / Consumes one item and returns the snapshot required by a non-coalescing event. */
  UseItem(itemId: bigint): ItemSnapshot {
    const item = this.requireItem(itemId);
    if (item.count === 0) {
      throw new RpcError(GameErrCode.ItemNotEnough, `item ${itemId} is empty`);
    }
    return item.RemoveCount(1);
  }

  /** 增加已有堆叠并返回权威快照。 / Adds to an existing stack and returns its authoritative snapshot. */
  AddItem(itemId: bigint, count: number): ItemSnapshot {
    return this.requireItem(itemId).AddCount(count);
  }

  /** 原子扣除已校验数量；失败时不改变堆叠。 / Atomically removes a validated count or leaves the stack unchanged. */
  RemoveItem(itemId: bigint, count: number): ItemSnapshot {
    const item = this.requireItem(itemId);
    if (item.count < count) {
      throw new RpcError(GameErrCode.ItemNotEnough, `item ${itemId} is not enough`);
    }
    return item.RemoveCount(count);
  }

  /** 生成全新的永久ItemId并创建道具；发放、掉落和拆分堆叠必须走此入口。 / Creates an item with a fresh persistent ID; grants, drops, and stack splits must use this entry. */
  CreateItem(configId: number, count: number): Item {
    const itemId = GlobalIdSystem.Instance.Next();
    return this.CreateItemById(itemId, {
      itemId,
      configId,
      count,
      quality: 0,
      level: 1,
      version: 1,
    });
  }

  /** 使用数据库、迁移或恢复数据中的原ItemId重建Entity；普通发放不得指定ID。 / Rebuilds an Entity with its persisted ID during load, transfer, or recovery; ordinary grants must not inject IDs. */
  CreateItemById(itemId: bigint, snapshot: ItemSnapshot): Item {
    requireGlobalId(itemId, "itemId");
    if (snapshot.itemId !== itemId) {
      throw new Error(`item snapshot id mismatch: ${itemId} != ${snapshot.itemId}`);
    }
    if (this.TryGetChild(Item, itemId)) {
      throw new Error(`duplicate item id: ${itemId}`);
    }
    return this.AddChild(Item, snapshot.itemId, {
      configId: snapshot.configId,
      count: snapshot.count,
      quality: snapshot.quality,
      level: snapshot.level,
      version: snapshot.version,
    });
  }

  private requireItem(itemId: bigint): Item {
    try {
      requireGlobalId(itemId, "itemId");
    } catch {
      throw new RpcError(GameErrCode.ItemNotFound, `invalid item id: ${itemId}`);
    }
    const item = this.TryGetChild(Item, itemId);
    if (!item) throw new RpcError(GameErrCode.ItemNotFound, `item not found: ${itemId}`);
    return item;
  }
}
