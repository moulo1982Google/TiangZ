import { Component, component } from "../../../core/public";
import { NativeItemRef } from "../../../generated/model/native/NativeItemRef";

/**
 * 道具运行时只读视图；业务可以短期读取，但不能借此释放或修改底层 Native 实体。
 * Runtime read-only item view; business code may inspect it briefly but cannot
 * mutate or dispose the underlying Native entity through this contract.
 */
export interface ItemView {
  readonly id: number;
  readonly instanceId: number;
  readonly configId: number;
  readonly count: number;
  readonly quality: number;
  readonly level: number;
  readonly version: number;
}

@component()
export class ItemComponent extends Component {
  protected static nextNativeInstanceId = 1;

  protected readonly items = new Map<number, NativeItemRef>();
}
