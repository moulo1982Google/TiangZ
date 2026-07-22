import { Component, component } from "../../core/runtime";
import {
  DEFAULT_MOVE_SPEED_CELLS_PER_SECOND,
  clampDirection,
  stepDurationTicks,
  type UnitMovementState,
} from "../movement";
import { PositionComponent } from "./PositionComponent";

@component()
export class MovementComponent extends Component {
  private readonly speedCellsPerSecond = DEFAULT_MOVE_SPEED_CELLS_PER_SECOND;
  private sequence = 0;
  private desiredInputX = 0;
  private desiredInputY = 0;
  private inputChanged = false;
  private fromCellX = 0;
  private fromCellY = 0;
  private targetCellX = 0;
  private targetCellY = 0;
  private moveStartTick = 0;
  private moveEndTick = 0;
  private moving = false;

  protected override Awake(): void {
    this.Reset();
  }

  Reset(): void {
    const position = this.GetParent().GetComponent(PositionComponent).snapshot();
    this.sequence = 0;
    this.desiredInputX = 0;
    this.desiredInputY = 0;
    this.inputChanged = false;
    this.fromCellX = position.cellX;
    this.fromCellY = position.cellY;
    this.targetCellX = position.cellX;
    this.targetCellY = position.cellY;
    this.moveStartTick = 0;
    this.moveEndTick = 0;
    this.moving = false;
  }

  SetInput(inputX: number, inputY: number, sequence: number): boolean {
    if (sequence <= this.sequence) return false;
    const nextX = clampDirection(inputX);
    const nextY = clampDirection(inputY);
    this.inputChanged ||= nextX !== this.desiredInputX || nextY !== this.desiredInputY;
    this.desiredInputX = nextX;
    this.desiredInputY = nextY;
    this.sequence = sequence;
    return true;
  }

  UpdateStep(serverTick: number, fixedUpdateMs: number): UnitMovementState | undefined {
    let stateChanged = this.inputChanged;
    this.inputChanged = false;
    const position = this.GetParent().GetComponent(PositionComponent);

    if (this.moving && serverTick >= this.moveEndTick) {
      position.SetCell(this.targetCellX, this.targetCellY);
      this.fromCellX = this.targetCellX;
      this.fromCellY = this.targetCellY;
      this.moving = false;
      stateChanged = true;
    }

    if (!this.moving && (this.desiredInputX !== 0 || this.desiredInputY !== 0)) {
      const targetX = position.CellX + this.desiredInputX;
      const targetY = position.CellY + this.desiredInputY;
      if (position.CanOccupy(targetX, targetY)) {
        this.fromCellX = position.CellX;
        this.fromCellY = position.CellY;
        this.targetCellX = targetX;
        this.targetCellY = targetY;
        this.moveStartTick = serverTick;
        this.moveEndTick = serverTick + stepDurationTicks(
          this.desiredInputX,
          this.desiredInputY,
          fixedUpdateMs,
          this.speedCellsPerSecond,
        );
        this.moving = true;
      } else {
        this.desiredInputX = 0;
        this.desiredInputY = 0;
      }
      stateChanged = true;
    }

    if (!this.moving && !stateChanged) return undefined;
    return this.State(stateChanged);
  }

  private State(stateChanged: boolean): UnitMovementState {
    return {
      acknowledgedSequence: this.sequence,
      fromCellX: this.fromCellX,
      fromCellY: this.fromCellY,
      toCellX: this.targetCellX,
      toCellY: this.targetCellY,
      moveStartTick: this.moveStartTick,
      moveEndTick: this.moveEndTick,
      moving: this.moving,
      stateChanged,
    };
  }
}
