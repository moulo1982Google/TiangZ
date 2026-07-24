import { Component, component } from "../../core/runtime";
import { RpcError } from "../../core/protocol/RpcError";
import { NativeItemRef } from "../../generated/model/native/NativeItemRef";
import type { ItemSnapshot } from "../../generated/model/server/demo/protocol/messages";
import { GameErrCode } from "../../game/protocol/GameErrCode";

@component()
export class ItemComponent extends Component {
  private static nextNativeInstanceId = 1;

  private readonly items = new Map<number, NativeItemRef>();

  protected override Awake(): void {
    this.Create(1, 1001, 3);
  }

  Snapshot(): ItemSnapshot[] {
    return [...this.items.values()].map(toSnapshot);
  }

  UseItem(itemId: number): ItemSnapshot {
    const item = this.requireItem(itemId);
    if (item.count === 0) {
      throw new RpcError(GameErrCode.ItemNotEnough, `item ${itemId} is empty`);
    }
    item.count -= 1;
    item.version += 1;
    return toSnapshot(item);
  }

  AddItem(itemId: number, count: number): ItemSnapshot {
    requirePositiveCount(count);
    const item = this.requireItem(itemId);
    item.count += count;
    item.version += 1;
    return toSnapshot(item);
  }

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
