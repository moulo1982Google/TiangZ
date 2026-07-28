import {
  Item,
  NativeItemRef,
  type AwakeItem,
  type ItemSnapshot,
  systemFor,
} from "#tiangz/model";

/** 单件道具的可热更局部规则；集合增删仍由 ItemComponentSystem 协调。 / Hot-reloadable rules for one item; collection ownership remains in ItemComponentSystem. */
@systemFor(Item)
export class ItemSystem extends Item {
  /** 创建与子 Entity InstanceId 一一对应的 Rust 权威数据。 / Creates Rust authoritative data keyed by the child Entity InstanceId. */
  protected override Awake(request: AwakeItem): void {
    if (typeof this.Id !== "number") {
      throw new Error(`item id must be a number: ${String(this.Id)}`);
    }
    this.native = NativeItemRef.Create({
      id: this.Id,
      instanceId: this.InstanceId,
      configId: request.configId,
      count: request.count,
      quality: request.quality,
      level: request.level,
      version: request.version,
    });
  }

  get id(): number { return this.requireNative().id; }
  get instanceId(): number { return this.InstanceId; }
  get configId(): number { return this.requireNative().configId; }
  get count(): number { return this.requireNative().count; }
  get quality(): number { return this.requireNative().quality; }
  get level(): number { return this.requireNative().level; }
  get version(): number { return this.requireNative().version; }

  /** 复制协议/持久化边界快照，不泄漏可变 Native handle。 / Copies a protocol/persistence snapshot without leaking the mutable Native handle. */
  Snapshot(): ItemSnapshot {
    const item = this.requireNative();
    return {
      itemId: item.id,
      configId: item.configId,
      count: item.count,
      quality: item.quality,
      level: item.level,
      version: item.version,
    };
  }

  /** 原子增加堆叠数量并推进版本。 / Atomically increases the stack and advances its version. */
  AddCount(count: number): ItemSnapshot {
    requirePositiveCount(count);
    const item = this.requireNative();
    item.count += count;
    item.version += 1;
    return this.Snapshot();
  }

  /** 原子扣除已校验数量；失败时不改变权威状态。 / Atomically removes a validated count or leaves authoritative state unchanged. */
  RemoveCount(count: number): ItemSnapshot {
    requirePositiveCount(count);
    const item = this.requireNative();
    if (item.count < count) throw new Error(`item ${item.id} is not enough`);
    item.count -= count;
    item.version += 1;
    return this.Snapshot();
  }

  /** 释放本子 Entity 独占的 Rust handle。 / Releases the Rust handle exclusively owned by this child Entity. */
  protected override OnDestroy(): void {
    this.native?.Dispose();
    this.native = undefined;
  }

  private requireNative(): NativeItemRef {
    if (!this.native) throw new Error(`item native data is unavailable: ${String(this.Id)}`);
    return this.native;
  }
}

function requirePositiveCount(count: number): void {
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error(`item count must be a positive integer: ${count}`);
  }
}
