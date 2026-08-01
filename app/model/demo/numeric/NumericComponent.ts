import { Component, component, lifecycle, transferable, type TimerId } from "../../../core/public";

export interface NumericComponent {
  /** 停止Demo自动回血；容量测试用于隔离Move/AOI，正式业务也可在规则切换时调用。 / Stops demo HP regeneration for isolated benchmarks or business rule changes. */
  StopRegeneration(): void;
}

@component()
@transferable()
@lifecycle({ awake: true, destroy: true })
export class NumericComponent extends Component {
  [type: number]: bigint;

  protected unitHandle = 0;
  protected regenerationTimer = 0 as TimerId;
}
