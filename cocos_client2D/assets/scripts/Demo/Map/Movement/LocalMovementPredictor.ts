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
  readonly y: number;
}

export interface MovementInputState extends MovementInput {
  readonly sequence: number;
}

export interface AuthoritativeMovementState {
  readonly acknowledgedSequence: number;
  readonly serverTick: number;
  readonly fromCellX: number;
  readonly fromCellY: number;
  readonly toCellX: number;
  readonly toCellY: number;
  readonly moveStartTick: number;
  readonly moveEndTick: number;
  readonly moving: boolean;
  readonly facing: number;
}

export interface PredictedMovement {
  readonly x: number;
  readonly y: number;
  readonly facing: Facing;
  readonly moving: boolean;
}

export interface LocalMovementPredictorOptions {
  readonly fixedUpdateMs: number;
  readonly heartbeatSeconds: number;
  readonly mapWidthCells?: number;
  readonly mapHeightCells?: number;
  readonly moveSpeedCellsPerSecond?: number;
}

export class LocalMovementPredictor {
  private desiredInput: MovementInput = { x: 0, y: 0 };
  private currentCellX: number;
  private currentCellY: number;
  private targetCellX: number;
  private targetCellY: number;
  private stepElapsedSeconds = 0;
  private stepDuration = 0;
  private moving = false;
  private heartbeatElapsed = 0;
  private sequence = 0;
  private acknowledgedSequence = 0;
  private facing: Facing;

  constructor(
    cellX: number,
    cellY: number,
    facing: number,
    private readonly sendState: (state: MovementInputState) => void,
    private readonly options: LocalMovementPredictorOptions,
  ) {
    this.currentCellX = cellX;
    this.currentCellY = cellY;
    this.targetCellX = cellX;
    this.targetCellY = cellY;
    this.facing = normalizeFacing(facing);
  }

  setInput(input: MovementInput): void {
    const normalized = {
      x: clampDirection(input.x),
      y: clampDirection(input.y),
    };
    if (
      normalized.x === this.desiredInput.x &&
      normalized.y === this.desiredInput.y
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
        this.currentCellY = this.targetCellY;
        this.moving = false;
        this.stepElapsedSeconds = 0;
        this.stepDuration = 0;
      }
    }

    if (this.desiredInput.x !== 0 || this.desiredInput.y !== 0) {
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
        this.currentCellY === state.fromCellY &&
        this.targetCellX === state.toCellX &&
        this.targetCellY === state.toCellY;
      if (sameStep) return true;

      this.currentCellX = state.fromCellX;
      this.currentCellY = state.fromCellY;
      this.targetCellX = state.toCellX;
      this.targetCellY = state.toCellY;
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
      this.targetCellY === state.fromCellY
    ) return true;

    this.currentCellX = state.fromCellX;
    this.currentCellY = state.fromCellY;
    this.targetCellX = state.fromCellX;
    this.targetCellY = state.fromCellY;
    this.moving = false;
    this.stepElapsedSeconds = 0;
    this.stepDuration = 0;
    return true;
  }

  private tryStartStep(): boolean {
    if (this.desiredInput.x === 0 && this.desiredInput.y === 0) return false;
    const targetX = this.currentCellX + this.desiredInput.x;
    const targetY = this.currentCellY + this.desiredInput.y;
    if (!canOccupyCell(
      targetX,
      targetY,
      this.options.mapWidthCells,
      this.options.mapHeightCells,
    )) return false;
    this.targetCellX = targetX;
    this.targetCellY = targetY;
    this.facing = facingFromDirection(this.desiredInput.x, this.desiredInput.y);
    this.stepDuration = stepDurationSeconds(
      this.desiredInput.x,
      this.desiredInput.y,
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
        y: cellToWorld(this.currentCellY),
        facing: this.facing,
        moving: false,
      };
    }
    const progress = Math.max(0, Math.min(1, this.stepElapsedSeconds / this.stepDuration));
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
