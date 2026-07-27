import { Component, RpcError, component } from "../../../core/public";
import { NativeItemRef } from "../../../generated/model/native/NativeItemRef";
import type { ItemSnapshot } from "../../../generated/model/server/demo/protocol/messages";
import { GameErrCode } from "../../game/protocol/GameErrCode";

@component()
export class ItemComponent extends Component {
  private static nextNativeInstanceId = 1;

  private readonly items = new Map<number, NativeItemRef>();

  /** 创建一件演示道具；生产环境应从持久化数据组合背包。 / Seeds one demo item; production loading should compose inventory from persistent data instead. */
  protected override Awake(): void {
    this.Create(1, 1001, 3);
  }

  /** 复制当前背包用于全量同步或持久化，不暴露 Native 句柄。 / Copies the current inventory for full sync or persistence without exposing Native handles. */
  Snapshot(): ItemSnapshot[] {
    return [...this.items.values()].map(toSnapshot);
  }

  /** 立即消耗一件道具并递增版本，用于不可覆盖事件投递。 / Consumes one item immediately and increments version for non-replaceable event delivery. */
  UseItem(itemId: number): ItemSnapshot {
    const item = this.requireItem(itemId);
    if (item.count === 0) {
      throw new RpcError(GameErrCode.ItemNotEnough, `item ${itemId} is empty`);
    }
    item.count -= 1;
    item.version += 1;
    return toSnapshot(item);
  }

  /** 增加已有堆叠，并返回变更后的权威快照。 / Adds to an existing stack and returns the authoritative post-change snapshot. */
  AddItem(itemId: number, count: number): ItemSnapshot {
    requirePositiveCount(count);
    const item = this.requireItem(itemId);
    item.count += count;
    item.version += 1;
    return toSnapshot(item);
  }

  /** 原子扣除已校验数量；失败时抛错且不改变堆叠。 / Removes a validated amount atomically or throws without changing the stack. */
  RemoveItem(itemId: number, count: number): ItemSnapshot {
    requirePositiveCount(count);
    const item = this.requireItem(itemId);
    if (item.count < count) {
      throw new RpcError(GameErrCode.ItemNotEnough, `item ${itemId} is not enough`);
    }
    item.count -= count;
    item.version += 1;
    return toSnapshot(item);
  }

  /** 释放本背包拥有的全部 Rust Arena 句柄。 / Releases all Rust Arena handles owned by this inventory. */
  protected override OnDestroy(): void {
    for (const item of this.items.values()) item.Dispose();
    this.items.clear();
  }

  private Create(itemId: number, configId: number, count: number): NativeItemRef {
    if (this.items.has(itemId)) throw new Error(`item already exists: ${itemId}`);
    const instanceId = ItemComponent.nextNativeInstanceId++;
    if (ItemComponent.nextNativeInstanceId > 0xffff_ffff) {
      ItemComponent.nextNativeInstanceId = 1;
    }
    const item = NativeItemRef.Create({
      id: itemId,
      instanceId,
      configId,
      count,
    });
    this.items.set(itemId, item);
    return item;
  }

  private requireItem(itemId: number): NativeItemRef {
    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
      throw new RpcError(GameErrCode.ItemNotFound, `invalid item id: ${itemId}`);
    }
    const item = this.items.get(itemId);
    if (!item) throw new RpcError(GameErrCode.ItemNotFound, `item not found: ${itemId}`);
    return item;
  }
}

function toSnapshot(item: NativeItemRef): ItemSnapshot {
  return {
    itemId: item.id,
    configId: item.configId,
    count: item.count,
    quality: item.quality,
    level: item.level,
    version: item.version,
  };
}

function requirePositiveCount(count: number): void {
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error(`item count must be a positive integer: ${count}`);
  }
}
