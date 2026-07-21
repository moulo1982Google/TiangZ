import { Component, component } from "../../core/runtime";

// 默认客户端以 5Hz 上报输入，因此正常两个输入包之间相隔 200ms。
// 服务端仍以 20Hz Game.Update 运行；这里按服务端收包时间计算权威移动步长。
const DEFAULT_MOVE_STEP_MS = 200;
const MAX_MOVE_STEP_MS = 250;

@component()
export class MovementComponent extends Component {
  private currentSequence = 0;
  private lastMoveAtMs = 0;

  get lastSequence(): number {
    return this.currentSequence;
  }

  protected override Awake(): void {
    this.reset();
  }

  reset(): void {
    this.currentSequence = 0;
    this.lastMoveAtMs = 0;
  }

  consumeStepSeconds(sequence: number, nowMs: number): number | undefined {
    if (sequence <= this.currentSequence) return undefined;

    const elapsedMs =
      this.lastMoveAtMs === 0
        ? DEFAULT_MOVE_STEP_MS
        : Math.max(0, Math.min(nowMs - this.lastMoveAtMs, MAX_MOVE_STEP_MS));
    this.currentSequence = sequence;
    this.lastMoveAtMs = nowMs;
    return elapsedMs / 1000;
  }
}
