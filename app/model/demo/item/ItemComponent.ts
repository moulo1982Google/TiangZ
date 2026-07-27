import { Component, component } from "../../../core/public";
import { NativeItemRef } from "../../../generated/model/native/NativeItemRef";

@component()
export class ItemComponent extends Component {
  protected static nextNativeInstanceId = 1;

  protected readonly items = new Map<number, NativeItemRef>();

}
