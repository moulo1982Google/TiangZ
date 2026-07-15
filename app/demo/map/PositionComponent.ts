import { Component, component } from "../../core/runtime";

export interface PositionSnapshot {
  x: number;
  y: number;
}

@component()
export class PositionComponent extends Component<[x: number, y: number]> {
  private currentX = 0;
  private currentY = 0;

  protected override Awake(x: number, y: number): void {
    this.currentX = x;
    this.currentY = y;
  }

  applyInput(inputX: number, inputY: number, seconds: number): void {
    const length = Math.hypot(inputX, inputY);
    if (length === 0 || seconds <= 0) return;

    const distance = 180 * seconds;
    this.currentX = clamp(
      this.currentX + (inputX / length) * distance,
      -430,
      430,
    );
    this.currentY = clamp(
      this.currentY + (inputY / length) * distance,
      -250,
      250,
    );
  }

  snapshot(): PositionSnapshot {
    return {
      x: Math.round(this.currentX),
      y: Math.round(this.currentY),
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
