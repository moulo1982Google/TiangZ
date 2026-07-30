import { cellToWorld, normalizeFacing, type Facing } from "./CellMovement";
import type { AuthoritativeMovementState, PredictedMovement } from "./LocalMovementPredictor";

export class RemoteMovementSmoother {
  private currentCellX: number;
  private currentCellZ: number;
  private targetCellX: number;
  private targetCellZ: number;
  private stepElapsedSeconds = 0;
  private stepDurationSeconds = 0;
  private moving = false;
  private receivedServerTick = -1;
  private facing: Facing;

  constructor(
    cellX: number,
    cellZ: number,
    facing: number,
    private readonly fixedUpdateMs: number,
  ) {
    this.currentCellX = cellX;
    this.currentCellZ = cellZ;
    this.targetCellX = cellX;
    this.targetCellZ = cellZ;
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
        this.targetCellZ === state.fromCellZ
      ) return true;
      this.setIdle(state.fromCellX, state.fromCellZ);
      return true;
    }

    const sameStep = this.moving &&
      this.currentCellX === state.fromCellX &&
      this.currentCellZ === state.fromCellZ &&
      this.targetCellX === state.toCellX &&
      this.targetCellZ === state.toCellZ;
    if (sameStep) return true;

    this.currentCellX = state.fromCellX;
    this.currentCellZ = state.fromCellZ;
    this.targetCellX = state.toCellX;
    this.targetCellZ = state.toCellZ;
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
        this.setIdle(this.targetCellX, this.targetCellZ);
      }
    }
    return this.position();
  }

  private setIdle(cellX: number, cellZ: number): void {
    this.currentCellX = cellX;
    this.currentCellZ = cellZ;
    this.targetCellX = cellX;
    this.targetCellZ = cellZ;
    this.stepElapsedSeconds = 0;
    this.stepDurationSeconds = 0;
    this.moving = false;
  }

  private position(): PredictedMovement {
    if (!this.moving) {
      return {
        x: cellToWorld(this.currentCellX),
        z: cellToWorld(this.currentCellZ),
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
      z: cellToWorld(this.currentCellZ) +
        (cellToWorld(this.targetCellZ) - cellToWorld(this.currentCellZ)) * progress,
      facing: this.facing,
      moving: true,
    };
  }
}
