import {
  Component,
  component,
  lifecycle,
} from "../../../core/public";
import type { NumericTypeValue } from "./NumericType";

/**
 * 一个数值资源的协议无关脉冲恢复定义；字段编号由调用方领域拥有。
 * Protocol-neutral pulse regeneration for one numeric resource; the caller's
 * domain owns the numeric field identifiers.
 */
interface NumericRegenerationDefinitionBase {
  readonly currentNumericType: NumericTypeValue;
  readonly maximumNumericType: NumericTypeValue;
  readonly intervalMs: number;
  readonly delayAfterDecreaseMs: number;
}

/** 固定恢复量或动态Numeric恢复量必须且只能选择一种。 / Exactly one fixed or Numeric-backed recovery amount must be selected. */
export type NumericRegenerationDefinition = NumericRegenerationDefinitionBase & (
  | { readonly amount: bigint; readonly amountNumericType?: never }
  | { readonly amount?: never; readonly amountNumericType: NumericTypeValue }
);

export interface NumericRegenerationComponent {
  /** 由所属领域的固定更新桶调用；返回本次是否写入了资源值。 / Called by the owning domain's fixed-update bucket; returns whether this tick wrote the resource. */
  Tick(nowMs: number): boolean;
  /** 外部直接重置资源后同步观察值并清空旧调度。 / Synchronizes the observation and clears the old schedule after an external resource reset. */
  ResetSchedule(): void;
}

/**
 * 挂在普通 Unit 上的资源恢复运行态；它不创建 Timer，也不判断战斗、职业或协议规则。
 * Unit-local regeneration state. It creates no Timer and knows nothing about
 * combat, classes, or wire protocols.
 */
@component()
@lifecycle({ awake: true })
export class NumericRegenerationComponent extends Component<[
  definition: Readonly<NumericRegenerationDefinition>,
]> {
  protected currentNumericType!: NumericTypeValue;
  protected maximumNumericType!: NumericTypeValue;
  protected amount = 0n;
  protected amountNumericType: NumericTypeValue | 0 = 0;
  protected intervalMs = 0;
  protected delayAfterDecreaseMs = 0;
  protected lastObservedValue = 0n;
  protected nextSettlementAtMs = 0;
}
