import {
  GameErrCode,
  GameConfigs,
  GlobalIdSystem,
  Item,
  ItemComponent,
  type InventoryGrant,
  type InventoryGrantPlan,
  type ItemSnapshot,
  type ItemView,
  type ITransfer,
  RpcError,
  requireGlobalId,
  systemFor,
} from "#tiangz/model";

const DEMO_STARTER_ITEMS = [
  { configId: 1001, count: 50 },
  { configId: 1002, count: 20 },
] as const;

/** 承载背包集合的可热更规则；子 Item Entity 和 Native handle 的销毁由 Core 所有权链保证。 / Hosts hot-reloadable inventory collection rules; Core ownership disposes child Item entities and Native handles. */
@systemFor(ItemComponent)
export class ItemComponentSystem extends ItemComponent implements ITransfer<readonly ItemSnapshot[]> {
  /**
   * 创建演示玩家的初始背包；生产加载应从持久化数据组合背包。
   * 这里只在Unit第一次创建时执行，传送/重连会通过RestoreTransfer替换默认数据，不能在RestoreTransfer中再次发放。
   *
   * Seeds the demo player's starter inventory; production loading should compose
   * the inventory from persisted data. This runs only for a newly created Unit.
   * Transfer/reconnect replaces these defaults in RestoreTransfer, so that method
   * must never call this seeding logic again.
   */
  protected override Awake(): void {
    // 初始道具数量属于演示业务，不放进Entity构造流程；后续正式项目应从玩家数据恢复。
    // Starter quantities are demo business data, not an Entity-construction rule; production should restore them from player data.
    for (const starter of DEMO_STARTER_ITEMS) {
      this.GrantItem(starter.configId, starter.count);
    }
  }

  /** 返回短期只读视图；不得跨 await 或玩家生命周期保存。 / Returns a short-lived read-only view that must not cross await or player lifetime boundaries. */
  GetItem(itemId: bigint): ItemView | undefined {
    return this.TryGetChild(Item, itemId);
  }

  /** 复制当前背包用于全量同步或持久化，不暴露子 Entity 或 Native handle。 / Copies inventory for full sync or persistence without exposing child entities or Native handles. */
  Snapshot(): ItemSnapshot[] {
    return sortSnapshots(this.GetChildren(Item).map((item) => item.Snapshot()));
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
    const item = this.requireItem(itemId);
    const config = this.getItemConfig(item.configId);
    requirePositiveCount(count);
    if (item.count + count > config.maxStack) {
      throw new RpcError(GameErrCode.ItemStackFull, `item ${itemId} exceeds max stack ${config.maxStack}`);
    }
    return item.AddCount(count);
  }

  /** 原子扣除已校验数量；失败时不改变堆叠。 / Atomically removes a validated count or leaves the stack unchanged. */
  RemoveItem(itemId: bigint, count: number): ItemSnapshot {
    const item = this.requireItem(itemId);
    requirePositiveCount(count);
    if (item.count < count) {
      throw new RpcError(GameErrCode.ItemNotEnough, `item ${itemId} is not enough`);
    }
    return item.RemoveCount(count);
  }

  /** 生成全新的永久ItemId并创建道具；发放、掉落和拆分堆叠必须走此入口。 / Creates an item with a fresh persistent ID; grants, drops, and stack splits must use this entry. */
  CreateItem(configId: number, count: number): Item {
    const config = this.getItemConfig(configId);
    requireStackCount(count, config.maxStack, configId);
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
    const config = this.getItemConfig(snapshot.configId);
    requireStackCount(snapshot.count, config.maxStack, snapshot.configId);
    return this.AddChild(Item, snapshot.itemId, {
      configId: snapshot.configId,
      count: snapshot.count,
      quality: snapshot.quality,
      level: snapshot.level,
      version: snapshot.version,
    });
  }

  /**
   * 按配置发放道具；优先填充已有堆叠，剩余数量才创建新Item子实体。
   * 这是奖励、掉落和GM发放的统一入口，调用方不能自行遍历Item并拼接堆叠。
   *
   * Grants by ItemConfig. Existing stacks are filled before new child Items are
   * created. Rewards, drops, and GM grants must use this entry instead of
   * implementing their own stack merge rules.
   */
  GrantItem(configId: number, count: number): readonly ItemSnapshot[] {
    return this.GrantItems([{ configId, count }]);
  }

  /**
   * 预检全部配置和数量后，按稳定顺序合并/拆堆；返回受影响堆叠的最终快照。
   * 当前背包没有容量上限，所以预检成功后不会因“格子不足”失败；未来加入格子限制时，
   * 必须扩展这里的预检，而不是让任务系统处理背包容量。
   *
   * Validates every grant before applying deterministic merge/split operations
   * and returns final snapshots for affected stacks. The demo inventory has no
   * slot limit; a future slot rule belongs in this preflight, never in Quest.
   */
  GrantItems(grants: readonly InventoryGrant[]): readonly ItemSnapshot[] {
    return this.CommitGrantPlan(this.PlanGrantItems(grants));
  }

  /**
   * 只在纯快照上规划合堆与拆堆，不修改Item Entity。相同configId的输入先合并，
   * 因此一个提交批次内同一堆叠的version最多推进一次。
   *
   * Plans stack merging and splitting on value snapshots only. Inputs with the
   * same configId are consolidated, so one stack advances version at most once
   * in one committed batch.
   */
  PlanGrantItems(grants: readonly InventoryGrant[]): InventoryGrantPlan {
    const baseItems = this.Snapshot();
    if (grants.length === 0) {
      return { baseItems, nextItems: baseItems, affectedItems: [] };
    }
    const consolidated = new Map<number, number>();
    for (const grant of grants) {
      this.getItemConfig(grant.configId);
      requirePositiveCount(grant.count);
      const total = (consolidated.get(grant.configId) ?? 0) + grant.count;
      if (!Number.isSafeInteger(total)) {
        throw new Error(`item grant count exceeds safe integer: ${grant.configId}`);
      }
      consolidated.set(grant.configId, total);
    }

    const working = new Map<bigint, ItemSnapshot>(
      baseItems.map((item) => [item.itemId, { ...item }]),
    );
    const affected = new Map<bigint, ItemSnapshot>();
    for (const [configId, count] of [...consolidated].sort(([left], [right]) => left - right)) {
      const config = this.getItemConfig(configId);
      let remaining = count;
      const stacks = [...working.values()]
        .filter((item) => item.configId === configId && item.count < config.maxStack)
        .sort(compareSnapshots);

      for (const item of stacks) {
        if (remaining === 0) break;
        const capacity = config.maxStack - item.count;
        const amount = Math.min(capacity, remaining);
        if (amount <= 0) continue;
        remaining -= amount;
        const next = { ...item, count: item.count + amount, version: item.version + 1 };
        working.set(item.itemId, next);
        affected.set(item.itemId, next);
      }

      while (remaining > 0) {
        const amount = Math.min(config.maxStack, remaining);
        remaining -= amount;
        const itemId = GlobalIdSystem.Instance.Next();
        const next: ItemSnapshot = {
          itemId,
          configId,
          count: amount,
          quality: 0,
          level: 1,
          version: 1,
        };
        working.set(itemId, next);
        affected.set(itemId, next);
      }
    }
    return {
      baseItems,
      nextItems: sortSnapshots([...working.values()]),
      affectedItems: sortSnapshots([...affected.values()]),
    };
  }

  /**
   * 无await提交已持久化的发放计划。先比较完整base快照，保证规划期间没有其他背包写入；
   * 校验成功后的操作只调用已预检过的Item规则，不得在这里访问网络或数据库。
   *
   * Commits a persisted grant plan without await. It first compares the full
   * base snapshot so no intervening inventory write can be overwritten. After
   * validation it only invokes preflighted Item rules and performs no I/O.
   */
  CommitGrantPlan(plan: InventoryGrantPlan): readonly ItemSnapshot[] {
    const current = this.Snapshot();
    if (!snapshotArraysEqual(current, plan.baseItems)) {
      throw new Error("inventory grant plan is stale");
    }
    const currentById = new Map(this.GetChildren(Item).map((item) => [item.id, item]));
    for (const expected of plan.affectedItems) {
      const item = currentById.get(expected.itemId);
      if (!item) {
        this.CreateItemById(expected.itemId, expected);
        continue;
      }
      if (
        item.configId !== expected.configId ||
        item.quality !== expected.quality ||
        item.level !== expected.level
      ) {
        throw new Error(`inventory grant plan changed immutable item data: ${expected.itemId}`);
      }
      const added = expected.count - item.count;
      if (added <= 0 || expected.version !== item.version + 1) {
        throw new Error(`inventory grant plan has invalid stack transition: ${expected.itemId}`);
      }
      const committed = item.AddCount(added);
      if (!snapshotEqual(committed, expected)) {
        throw new Error(`inventory grant plan commit mismatch: ${expected.itemId}`);
      }
    }
    if (!snapshotArraysEqual(this.Snapshot(), plan.nextItems)) {
      throw new Error("inventory grant plan final snapshot mismatch");
    }
    return plan.affectedItems.map((item) => ({ ...item }));
  }

  /**
   * 根据DBProxy回执补做一次已提交发放。它只接受“当前值已经等于结果”或“恰好前进一个version”的转换，
   * 任何其他差异都拒绝自动覆盖，并要求上层重新加载完整玩家快照。
   *
   * Reconciles a grant already committed by DBProxy. It accepts only an
   * already-equal value or an exact one-version transition. Any other drift is
   * rejected so the caller can reload the complete player snapshot.
   */
  ApplyCommittedGrantItems(items: readonly ItemSnapshot[]): readonly ItemSnapshot[] {
    const expectedItems = sortSnapshots(items);
    const currentById = new Map(this.GetChildren(Item).map((item) => [item.id, item]));
    for (const expected of expectedItems) {
      const config = this.getItemConfig(expected.configId);
      requireStackCount(expected.count, config.maxStack, expected.configId);
      const current = currentById.get(expected.itemId);
      if (!current) {
        if (expected.version !== 1) {
          throw new Error(`cannot recover missing item at version ${expected.version}: ${expected.itemId}`);
        }
        continue;
      }
      const snapshot = current.Snapshot();
      if (snapshotEqual(snapshot, expected)) continue;
      if (
        snapshot.configId !== expected.configId ||
        snapshot.quality !== expected.quality ||
        snapshot.level !== expected.level ||
        expected.version !== snapshot.version + 1 ||
        expected.count <= snapshot.count
      ) {
        throw new Error(`committed inventory result conflicts with local item: ${expected.itemId}`);
      }
    }
    for (const expected of expectedItems) {
      const current = currentById.get(expected.itemId);
      if (!current) {
        this.CreateItemById(expected.itemId, expected);
      } else if (!snapshotEqual(current.Snapshot(), expected)) {
        current.AddCount(expected.count - current.count);
      }
    }
    return expectedItems;
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

  private getItemConfig(configId: number): import("#tiangz/model").ItemConfigData {
    if (!Number.isSafeInteger(configId) || configId <= 0) {
      throw new Error(`invalid item config id: ${configId}`);
    }
    return GameConfigs.ItemConfig.Get(configId);
  }
}

function sortSnapshots(items: readonly ItemSnapshot[]): ItemSnapshot[] {
  return items.map((item) => ({ ...item })).sort(compareSnapshots);
}

function compareSnapshots(left: ItemSnapshot, right: ItemSnapshot): number {
  return left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0;
}

function snapshotArraysEqual(
  left: readonly ItemSnapshot[],
  right: readonly ItemSnapshot[],
): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = sortSnapshots(left);
  const sortedRight = sortSnapshots(right);
  return sortedLeft.every((item, index) => snapshotEqual(item, sortedRight[index]!));
}

function snapshotEqual(left: ItemSnapshot, right: ItemSnapshot): boolean {
  return left.itemId === right.itemId &&
    left.configId === right.configId &&
    left.count === right.count &&
    left.quality === right.quality &&
    left.level === right.level &&
    left.version === right.version;
}

function requireStackCount(count: number, maxStack: number, configId: number): void {
  requirePositiveCount(count);
  if (!Number.isSafeInteger(maxStack) || maxStack <= 0) {
    throw new Error(`invalid max stack for item config ${configId}: ${maxStack}`);
  }
  if (count > maxStack) {
    throw new Error(`item ${configId} count ${count} exceeds max stack ${maxStack}`);
  }
}

function requirePositiveCount(count: number): void {
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error(`item count must be a positive safe integer: ${count}`);
  }
}
