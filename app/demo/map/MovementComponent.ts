import { Component, component } from "../../core/runtime";

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
        ? 50
        : Math.max(0, Math.min(nowMs - this.lastMoveAtMs, 100));
    this.currentSequence = sequence;
    this.lastMoveAtMs = nowMs;
    return elapsedMs / 1000;
  }
}
