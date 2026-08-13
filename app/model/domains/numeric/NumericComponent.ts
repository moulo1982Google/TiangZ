import { Component, component, lifecycle, transferable } from "../../../core/public";

/**
 * Numeric初始值允许领域扩展自己的编号；通用容器不认识某个游戏的字段名称。
 * The generic container accepts domain-defined numeric ids without knowing a
 * particular game's field names.
 */
export type NumericInitialValues = Partial<Record<number, bigint>>;

/**
 * Numeric只保存数值句柄和字段访问面；派生计算由Rust桥，空间同步由领域适配器处理。
 * Numeric stores values and exposes field access; Rust owns derived evaluation,
 * while spatial synchronization belongs to a domain adapter.
 */
@component()
@transferable()
@lifecycle({ awake: true, destroy: true })
export class NumericComponent extends Component<[initial?: NumericInitialValues]> {
  [type: number]: bigint;

  protected unitHandle = 0;
}
