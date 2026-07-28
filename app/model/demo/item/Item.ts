import { ChildEntity } from "../../../core/public";
import { NativeItemRef } from "../../../generated/model/native/NativeItemRef";

export interface AwakeItem {
  configId: number;
  count: number;
}

/** 道具运行时只读视图；只能在当前同步调用中读取。 / Runtime read-only item view for the current synchronous call. */
export interface ItemView {
  readonly id: number;
  readonly instanceId: number;
  readonly configId: number;
  readonly count: number;
  readonly quality: number;
  readonly level: number;
  readonly version: number;
}

/**
 * ItemComponent 拥有的本地子 Entity；它没有 mailbox，不能作为网络消息目标。
 * Native handle 是稳定 Model 状态，具体规则由 ItemSystem 热更实现。
 *
 * A local child Entity owned by ItemComponent. It has no mailbox and cannot be
 * a network target. Its Native handle is stable Model state while ItemSystem
 * provides hot-reloadable behavior.
 */
export class Item extends ChildEntity<[request: AwakeItem]> {
  protected native: NativeItemRef | undefined;
}
