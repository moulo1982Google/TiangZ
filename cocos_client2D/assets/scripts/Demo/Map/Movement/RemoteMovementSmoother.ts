import { cellToWorld, normalizeFacing, type Facing } from "./CellMovement";
import type { AuthoritativeMovementState, PredictedMovement } from "./LocalMovementPredictor";

export class RemoteMovementSmoother {
  private currentCellX: number;
  private currentCellY: number;
  private targetCellX: number;
  private targetCellY: number;
  private stepElapsedSeconds = 0;
  private stepDurationSeconds = 0;
  private moving = false;
  private receivedServerTick = -1;
  private facing: Facing;

  constructor(
    cellX: number,
    cellY: number,
    facing: number,
    private readonly fixedUpdateMs: number,
  ) {
    this.currentCellX = cellX;
    this.currentCellY = cellY;
    this.targetCellX = cellX;
    this.targetCellY = cellY;
    this.facing = normalizeFacing(facing);
  }

  applyState(state: AuthoritativeMovementState): boolean {
    if (state.serverTick <= this.receivedServerTick) return false;
    this.receivedServerTick = state.serverTick;
    this.facing = normalizeFacing(state.facing);

    if (!state.moving) {
      if (
        this.moving &&
        this.targetCellX === state.fromCellX &&
        this.targetCellY === state.fromCellY
      ) return true;
      this.setIdle(state.fromCellX, state.fromCellY);
      return true;
    }

    const sameStep = this.moving &&
      this.currentCellX === state.fromCellX &&
      this.currentCellY === state.fromCellY &&
      this.targetCellX === state.toCellX &&
      this.targetCellY === state.toCellY;
    if (sameStep) return true;

    this.currentCellX = state.fromCellX;
    this.currentCellY = state.fromCellY;
    this.targetCellX = state.toCellX;
    this.targetCellY = state.toCellY;
    this.stepDurationSeconds = Math.max(
      this.fixedUpdateMs / 1_000,
      (state.moveEndTick - state.moveStartTick) * this.fixedUpdateMs / 1_000,
    );
    const progress = Math.max(0, Math.min(
      1,
      (state.serverTick - state.moveStartTick) /
        Math.max(1, state.moveEndTick - state.moveStartTick),
    ));
    this.stepElapsedSeconds = this.stepDurationSeconds * progress;
    this.moving = true;
    return true;
  }

  update(deltaSeconds: number): PredictedMovement {
    if (this.moving) {
      this.stepElapsedSeconds += Math.max(0, Math.min(deltaSeconds, 0.25));
      if (this.stepElapsedSeconds + 1e-6 >= this.stepDurationSeconds) {
        this.setIdle(this.targetCellX, this.targetCellY);
      }
    }
    return this.position();
  }

  private setIdle(cellX: number, cellY: number): void {
    this.currentCellX = cellX;
    this.currentCellY = cellY;
    this.targetCellX = cellX;
    this.targetCellY = cellY;
    this.stepElapsedSeconds = 0;
    this.stepDurationSeconds = 0;
    this.moving = false;
  }

  private position(): PredictedMovement {
    if (!this.moving) {
      return {
        x: cellToWorld(this.currentCellX),
        y: cellToWorld(this.currentCellY),
        facing: this.facing,
        moving: false,
      };
    }
    const progress = Math.max(
      0,
      Math.min(1, this.stepElapsedSeconds / this.stepDurationSeconds),
    );
    return {
      x: cellToWorld(this.currentCellX) +
        (cellToWorld(this.targetCellX) - cellToWorld(this.currentCellX)) * progress,
      y: cellToWorld(this.currentCellY) +
        (cellToWorld(this.targetCellY) - cellToWorld(this.currentCellY)) * progress,
      facing: this.facing,
      moving: true,
    };
  }
}
