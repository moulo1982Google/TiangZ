import { ChildEntity, lifecycle, type GlobalId } from "../../../core/public";

export interface AwakeItem {
  readonly configId: number;
  readonly count: number;
  readonly quality?: number;
  readonly level?: number;
  readonly version?: number;
}

/** 道具的通用只读视图；网络层和持久化层可以各自投影它。 / Generic read-only item view; network and persistence layers may project it independently. */
export interface ItemView {
  readonly id: GlobalId;
  readonly instanceId: number;
  readonly configId: number;
  readonly count: number;
  readonly quality: number;
  readonly level: number;
  readonly version: number;
}

/**
 * Item只依赖这个最小Native能力面，不依赖某个游戏生成的NativeItemRef类型。
 * Item depends only on this minimal Native surface, not on a game's generated NativeItemRef type.
 */
export interface ItemNativeData {
  id: number;
  instanceId: number;
  configId: number;
  count: number;
  quality: number;
  level: number;
  version: number;
  Dispose(): void;
}

/**
 * Item是背包拥有的ChildEntity，不是网络Actor；具体实例数据由领域适配器托管。
 * Item is an inventory-owned ChildEntity, not a network Actor; concrete
 * instance data is owned by a domain adapter.
 */
@lifecycle({ awake: true, destroy: true })
export class Item extends ChildEntity<[request: AwakeItem]> {
  protected native: ItemNativeData | undefined;
}
