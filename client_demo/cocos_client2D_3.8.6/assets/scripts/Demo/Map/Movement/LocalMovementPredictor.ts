import {
  canOccupyCell,
  cellToWorld,
  clampDirection,
  facingFromDirection,
  normalizeFacing,
  stepDurationSeconds,
  type Facing,
} from "./CellMovement";

export interface MovementInput {
  readonly x: number;
  readonly z: number;
}

export interface MovementInputState extends MovementInput {
  readonly sequence: number;
}

export interface AuthoritativeMovementState {
  readonly acknowledgedSequence: number;
  readonly serverTick: number;
  readonly fromCellX: number;
  readonly fromCellZ: number;
  readonly toCellX: number;
  readonly toCellZ: number;
  readonly moveStartTick: number;
  readonly moveEndTick: number;
  readonly moving: boolean;
  readonly facing: number;
}

export interface PredictedMovement {
  readonly x: number;
  readonly z: number;
  readonly facing: Facing;
  readonly moving: boolean;
}

export interface LocalMovementPredictorOptions {
  readonly fixedUpdateMs: number;
  readonly heartbeatSeconds: number;
  readonly mapWidthCells?: number;
  readonly mapDepthCells?: number;
  readonly moveSpeedCellsPerSecond?: number;
}

export class LocalMovementPredictor {
  private desiredInput: MovementInput = { x: 0, z: 0 };
  private currentCellX: number;
  private currentCellZ: number;
  private targetCellX: number;
  private targetCellZ: number;
  private stepElapsedSeconds = 0;
  private stepDuration = 0;
  private moving = false;
  private heartbeatElapsed = 0;
  private sequence = 0;
  private acknowledgedSequence = 0;
  private facing: Facing;

  constructor(
    cellX: number,
    cellZ: number,
    facing: number,
    private readonly sendState: (state: MovementInputState) => void,
    private readonly options: LocalMovementPredictorOptions,
  ) {
    this.currentCellX = cellX;
    this.currentCellZ = cellZ;
    this.targetCellX = cellX;
    this.targetCellZ = cellZ;
    this.facing = normalizeFacing(facing);
  }

  setInput(input: MovementInput): void {
    const normalized = {
      x: clampDirection(input.x),
      z: clampDirection(input.z),
    };
    if (
      normalized.x === this.desiredInput.x &&
      normalized.z === this.desiredInput.z
    ) return;

    this.desiredInput = normalized;
    this.heartbeatElapsed = 0;
    this.emitState(normalized);
    if (!this.moving) this.tryStartStep();
  }

  update(deltaSeconds: number): PredictedMovement {
    let remaining = Math.max(0, Math.min(deltaSeconds, 0.25));
    while (remaining > 0) {
      if (!this.moving && !this.tryStartStep()) break;
      const consumed = Math.min(remaining, this.stepDuration - this.stepElapsedSeconds);
      this.stepElapsedSeconds += consumed;
      remaining -= consumed;
      if (this.stepElapsedSeconds + 1e-6 >= this.stepDuration) {
        this.currentCellX = this.targetCellX;
        this.currentCellZ = this.targetCellZ;
        this.moving = false;
        this.stepElapsedSeconds = 0;
        this.stepDuration = 0;
      }
    }

    if (this.desiredInput.x !== 0 || this.desiredInput.z !== 0) {
      this.heartbeatElapsed += Math.max(0, deltaSeconds);
      while (this.heartbeatElapsed >= this.options.heartbeatSeconds) {
        this.heartbeatElapsed -= this.options.heartbeatSeconds;
        this.emitState(this.desiredInput);
      }
    } else {
      this.heartbeatElapsed = 0;
    }
    return this.position();
  }

  reconcile(state: AuthoritativeMovementState): boolean {
    if (state.acknowledgedSequence < this.acknowledgedSequence) return false;
    this.acknowledgedSequence = state.acknowledgedSequence;
    this.facing = normalizeFacing(state.facing);

    if (state.moving) {
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
      this.stepDuration = Math.max(
        this.options.fixedUpdateMs / 1_000,
        (state.moveEndTick - state.moveStartTick) * this.options.fixedUpdateMs / 1_000,
      );
      const serverProgress = Math.max(0, Math.min(
        1,
        (state.serverTick - state.moveStartTick) /
          Math.max(1, state.moveEndTick - state.moveStartTick),
      ));
      this.stepElapsedSeconds = this.stepDuration * serverProgress;
      this.moving = true;
      return true;
    }

    if (
      this.moving &&
      this.targetCellX === state.fromCellX &&
      this.targetCellZ === state.fromCellZ
    ) return true;

    this.currentCellX = state.fromCellX;
    this.currentCellZ = state.fromCellZ;
    this.targetCellX = state.fromCellX;
    this.targetCellZ = state.fromCellZ;
    this.moving = false;
    this.stepElapsedSeconds = 0;
    this.stepDuration = 0;
    return true;
  }

  private tryStartStep(): boolean {
    if (this.desiredInput.x === 0 && this.desiredInput.z === 0) return false;
    const targetX = this.currentCellX + this.desiredInput.x;
    const targetZ = this.currentCellZ + this.desiredInput.z;
    if (!canOccupyCell(
      targetX,
      targetZ,
      this.options.mapWidthCells,
      this.options.mapDepthCells,
    )) return false;
    this.targetCellX = targetX;
    this.targetCellZ = targetZ;
    this.facing = facingFromDirection(this.desiredInput.x, this.desiredInput.z);
    this.stepDuration = stepDurationSeconds(
      this.desiredInput.x,
      this.desiredInput.z,
      this.options.fixedUpdateMs,
      this.options.moveSpeedCellsPerSecond,
    );
    this.stepElapsedSeconds = 0;
    this.moving = true;
    return true;
  }

  private emitState(input: MovementInput): void {
    this.sendState({ ...input, sequence: ++this.sequence });
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
    const progress = Math.max(0, Math.min(1, this.stepElapsedSeconds / this.stepDuration));
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
