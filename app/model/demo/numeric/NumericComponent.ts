import { Component, component, lifecycle, transferable } from "../../../core/public";
import type { NumericType as NumericTypeValue } from "./NumericType";

/**
 * 创建Numeric时可覆盖的初始值字典；key必须是NumericType，value必须是bigint。
 * 派生结果（例如MaxHp、Attack）不能作为输入，只能写入Base/Add/Pct或普通属性。
 *
 * Numeric creation overrides keyed by NumericType. Derived results such as
 * MaxHp and Attack are not valid inputs; write Base/Add/Pct or raw attributes.
 */
export type NumericInitialValues = Partial<Record<NumericTypeValue, bigint>>;

@component()
@transferable()
@lifecycle({ awake: true, destroy: true })
export class NumericComponent extends Component<[initial?: NumericInitialValues]> {
  [type: number]: bigint;

  protected unitHandle = 0;
}
