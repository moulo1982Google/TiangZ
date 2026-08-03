import { Component, component, lifecycle, transferable, type TimerId } from "../../../core/public";

/** 创建Numeric时可覆盖的初始值；未传入时沿用玩家演示配置。 / Optional initial values for Numeric creation; omitted values keep the player demo defaults. */
export interface NumericInitialValues {
  readonly currentHp?: bigint;
  readonly maxHpBase?: bigint;
  readonly maxHpAdd?: bigint;
  readonly maxHpPct?: bigint;
  readonly regenerateHp?: boolean;
}

export interface NumericComponent {
  /** 停止Demo自动回血；容量测试用于隔离Move/AOI，正式业务也可在规则切换时调用。 / Stops demo HP regeneration for isolated benchmarks or business rule changes. */
  StopRegeneration(): void;
}

@component()
@transferable()
@lifecycle({ awake: true, destroy: true })
export class NumericComponent extends Component<[initial?: NumericInitialValues]> {
  [type: number]: bigint;

  protected unitHandle = 0;
  protected regenerationTimer = 0 as TimerId;
}
