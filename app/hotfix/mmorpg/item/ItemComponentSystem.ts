import {
  GameErrCode,
  GameConfigs,
  GlobalIdSystem,
  Item,
  ItemComponent,
  ItemEvents,
  type InventoryGrant,
  type InventoryGrantPlan,
  type InventoryConsumePlan,
  type ItemSnapshot,
  type ItemView,
  type ITransfer,
  type M2C_UseItem,
  MapComponent,
  PlayerPersistenceComponent,
  PlayerUnit,
  QuestEvents,
  QuestObjectiveType,
  RpcError,
  SystemErrCode,
  requireGlobalId,
  systemFor,
  utf8Encode,
} from "#tiangz/model";
import {
  ApplyItemUseTransaction,
  DecodeItemUseReceipt,
  EncodeItemUseReceipt,
  PlanItemUseTransaction,
  type ItemUseCommitResult,
  type ItemUseTransactionReceipt,
} from "./ItemUseTransaction";

const CLIENT_OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;

/** 承载背包集合的可热更规则；子 Item Entity 和 Native handle 的销毁由 Core 所有权链保证。 / Hosts hot-reloadable inventory collection rules; Core ownership disposes child Item entities and Native handles. */
@systemFor(ItemComponent)
export class ItemComponentSystem extends ItemComponent implements ITransfer<readonly ItemSnapshot[]> {
  /**
   * 新玩家故意从空背包开始；药品只能来自任务奖励或其他明确的业务发放。
   * 生命周期仍保留Awake，是为了满足Component的Model契约，不能在这里偷偷创建Item。
   *
   * New players intentionally start with an empty inventory; potions must come
   * from quest rewards or another explicit business grant. Awake remains to
   * satisfy the Component Model contract and must not create starter Items here.
   */
  protected override Awake(): void {}

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
    // 兼容旧版本曾保存的空堆叠；数量归零的Item在语义上已经不存在，恢复时直接丢弃。
    // Ignore legacy zero-count stacks; semantically they are already gone and must not block login.
    for (const item of items) {
      if (item.count > 0) this.CreateItemById(item.itemId, item);
    }
  }

  /** 消耗一件道具并返回不可覆盖事件所需快照。 / Consumes one item and returns the snapshot required by a non-coalescing event. */
  UseItem(itemId: bigint): ItemSnapshot {
    return this.CommitConsumePlan(this.PlanConsumeItem(itemId));
  }

  /**
   * 先规划道具扣除、CD和效果，再把操作后玩家快照与业务回执原子提交给DBProxy。
   * DBProxy确认前不修改Entity；ACK丢失或客户端重试时读取原回执补齐内存，绝不重新执行效果。
   *
   * Plans inventory, cooldowns, and effects before atomically committing the
   * post-operation player snapshot plus receipt through DBProxy. Entities stay
   * unchanged before confirmation. Lost ACKs and retries recover the original
   * receipt instead of executing effects again.
   */
  async UseItemTransactional(itemId: bigint, clientOperationId: string): Promise<M2C_UseItem> {
    const unit = this.GetParent<PlayerUnit>();
    const operationId = itemUseOperationId(unit.Account, clientOperationId);
    const persistence = unit.GetComponent(PlayerPersistenceComponent);

    if (persistence.IsTransactionUncertain(operationId)) {
      const recovered = await this.tryRecoverUseItem(unit, itemId, operationId);
      if (recovered) return recovered;
    }

    let plan: ReturnType<typeof PlanItemUseTransaction>;
    try {
      const current = this.GetItem(itemId);
      if (!current) throw new RpcError(GameErrCode.ItemNotFound, `item not found: ${itemId}`);
      if (current.count <= 0) {
        throw new RpcError(GameErrCode.ItemNotEnough, `item ${itemId} is empty`);
      }
      const itemConfig = GameConfigs.ItemConfig.Get(current.configId);
      const vetoReason = unit.DomainScene().Events.Check(ItemEvents.BeforeUse, {
        unit,
        item: current,
        config: itemConfig,
      });
      if (vetoReason !== SystemErrCode.Success) {
        throw new RpcError(vetoReason, `item use vetoed: ${current.configId}`);
      }
      plan = PlanItemUseTransaction(unit, itemId, itemConfig.id);
    } catch (error) {
      // 同一operationId重试可能被首次提交形成的CD或库存变化拒绝，因此先查原回执。
      // A retry may be rejected by cooldown or inventory changes from the first
      // commit, so recover the original receipt before returning the error.
      const recovered = await this.tryRecoverUseItem(unit, itemId, operationId);
      if (recovered) return recovered;
      throw error;
    }

    const encodedReceipt = EncodeItemUseReceipt(plan.receipt);
    let committed;
    try {
      committed = await persistence.ApplyTransaction(operationId, plan.data, encodedReceipt);
    } catch (error) {
      const recovered = await this.tryRecoverUseItem(unit, itemId, operationId);
      if (recovered) return recovered;
      throw error;
    }

    const durable = DecodeItemUseReceipt(committed.result);
    validateReceipt(durable, itemId);
    const result = bytesEqual(committed.result, encodedReceipt)
      ? ApplyItemUseTransaction(unit, durable, plan.inventory)
      : ApplyItemUseTransaction(unit, durable);
    await this.publishCommittedUseItem(unit, durable, result);
    return result.response;
  }

  private async tryRecoverUseItem(
    unit: PlayerUnit,
    itemId: bigint,
    operationId: string,
  ): Promise<M2C_UseItem | undefined> {
    const receipt = await unit.GetComponent(PlayerPersistenceComponent).LoadTransaction(operationId);
    if (!receipt) return undefined;
    const durable = DecodeItemUseReceipt(receipt.result);
    validateReceipt(durable, itemId);
    const result = ApplyItemUseTransaction(unit, durable);
    await this.publishCommittedUseItem(unit, durable, result);
    return result.response;
  }

  private async publishCommittedUseItem(
    unit: PlayerUnit,
    receipt: ItemUseTransactionReceipt,
    result: ItemUseCommitResult,
  ): Promise<void> {
    if (!result.inventoryChanged) return;
    unit.DomainScene().Events.Publish(QuestEvents.Progress, {
      player: unit,
      objectiveType: QuestObjectiveType.UseItem,
      targetConfigId: receipt.itemConfigId,
      count: 1,
    });
    await unit.DomainScene().GetComponent(MapComponent).PublishItemChanged(
      unit,
      receipt.consumedItem,
    );
  }

  /**
   * 在纯快照上规划一次道具扣除；DBProxy等待期间不会提前改变背包。
   * Plans one item consumption on value snapshots so inventory remains
   * unchanged while DBProxy is pending.
   */
  PlanConsumeItem(itemId: bigint, count: number = 1): InventoryConsumePlan {
    const item = this.requireItem(itemId);
    requirePositiveCount(count);
    if (item.count < count) {
      throw new RpcError(GameErrCode.ItemNotEnough, `item ${itemId} is not enough`);
    }
    const baseItems = this.Snapshot();
    const consumedItem: ItemSnapshot = {
      ...item.Snapshot(),
      count: item.count - count,
      version: item.version + 1,
    };
    return {
      baseItems,
      // 数量归零代表整堆Item被消耗，持久化快照不再保留空堆叠。
      // A zero-count stack is fully consumed and must disappear from the persisted snapshot.
      nextItems: sortSnapshots(baseItems
        .filter((value) => value.itemId !== itemId || consumedItem.count > 0)
        .map((value) => value.itemId === itemId ? consumedItem : value)),
      consumedItem,
    };
  }

  /**
   * 无await提交已经持久化的扣除计划；完整base快照不一致时拒绝覆盖新背包状态。
   * Commits a persisted consume plan without await and rejects it when the
   * complete base snapshot no longer matches current inventory.
   */
  CommitConsumePlan(plan: InventoryConsumePlan): ItemSnapshot {
    if (!snapshotArraysEqual(this.Snapshot(), plan.baseItems)) {
      throw new Error("inventory consume plan is stale");
    }
    const current = this.requireItem(plan.consumedItem.itemId);
    const before = current.Snapshot();
    if (
      before.configId !== plan.consumedItem.configId ||
      before.quality !== plan.consumedItem.quality ||
      before.level !== plan.consumedItem.level ||
      plan.consumedItem.count >= before.count ||
      plan.consumedItem.version !== before.version + 1
    ) {
      throw new Error(`inventory consume plan has invalid transition: ${before.itemId}`);
    }
    const committed = current.RemoveCount(before.count - plan.consumedItem.count);
    if (!snapshotEqual(committed, plan.consumedItem)) {
      throw new Error(`inventory consume plan commit mismatch: ${before.itemId}`);
    }
    if (committed.count === 0) this.RemoveChild(Item, current.Id);
    if (!snapshotArraysEqual(this.Snapshot(), plan.nextItems)) {
      throw new Error("inventory consume plan final snapshot mismatch");
    }
    return { ...committed };
  }

  /**
   * 根据DBProxy回执补做已提交扣除；只接受相同值或恰好减少一次且version前进一的转换。
   * Reconciles a committed consumption receipt and accepts only an equal value
   * or one exact decrement with a single version advance.
   */
  ApplyCommittedConsumeItem(expected: ItemSnapshot): ItemSnapshot {
    const current = this.TryGetChild(Item, expected.itemId);
    // 事务回执可能在首次应用时已经移除了最后一堆Item；重试必须把这个状态视为已完成。
    // A retry may observe the item already removed by the first commit; that is an idempotent success.
    if (!current) {
      if (expected.count === 0) return { ...expected };
      throw new RpcError(GameErrCode.ItemNotFound, `item not found: ${expected.itemId}`);
    }
    const snapshot = current.Snapshot();
    if (snapshotEqual(snapshot, expected)) return { ...snapshot };
    if (
      snapshot.configId === expected.configId &&
      snapshot.quality === expected.quality &&
      snapshot.level === expected.level &&
      snapshot.version > expected.version
    ) {
      // 后续背包操作已经覆盖这次扣除；事务回执只用于返回原结果，不能回退当前堆叠。
      // Later inventory writes already superseded this consumption; the receipt
      // returns the original result and must never roll the stack backward.
      return { ...expected };
    }
    if (
      snapshot.configId !== expected.configId ||
      snapshot.quality !== expected.quality ||
      snapshot.level !== expected.level ||
      expected.count >= snapshot.count ||
      expected.version !== snapshot.version + 1
    ) {
      throw new Error(`committed inventory consumption conflicts with local item: ${expected.itemId}`);
    }
    const committed = current.RemoveCount(snapshot.count - expected.count);
    if (!snapshotEqual(committed, expected)) {
      throw new Error(`committed inventory consumption mismatch: ${expected.itemId}`);
    }
    if (committed.count === 0) this.RemoveChild(Item, current.Id);
    return { ...committed };
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
    const committed = item.RemoveCount(count);
    if (committed.count === 0) this.RemoveChild(Item, item.Id);
    return committed;
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

function itemUseOperationId(account: string, clientOperationId: string): string {
  if (!CLIENT_OPERATION_ID_PATTERN.test(clientOperationId)) {
    throw new Error("UseItem operationId must be 1-96 ASCII letters, digits, dot, underscore, colon, or dash");
  }
  const operationId = `item-use:${account}:${clientOperationId}`;
  if (utf8Encode(operationId).byteLength > 256) {
    throw new Error("UseItem operationId exceeds DBProxy's 256-byte limit");
  }
  return operationId;
}

function validateReceipt(receipt: ItemUseTransactionReceipt, itemId: bigint): void {
  if (receipt.consumedItem.itemId !== itemId) {
    throw new Error(
      `UseItem operationId conflicts with item ${itemId}; original item=${receipt.consumedItem.itemId}`,
    );
  }
  if (receipt.consumedItem.configId !== receipt.itemConfigId) {
    throw new Error(`UseItem receipt config mismatch: ${receipt.itemConfigId}`);
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
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
