import {
  Component,
  component,
  transferable,
  type ITransfer,
} from "../../../core/public";
import {
  canOccupyCell,
  cellToWorld,
} from "../movement";
import type { NativeUnitRef } from "../../../generated/model/native/NativeUnitRef";

export interface PositionSnapshot {
  x: number;
  y: number;
  cellX: number;
  cellY: number;
}

@component()
@transferable()
export class PositionComponent extends Component<[
  native: NativeUnitRef,
  mapWidthCells: number,
  mapHeightCells: number,
]> implements ITransfer<PositionTransferState> {
  private native!: NativeUnitRef;
  private mapWidthCells = 0;
  private mapHeightCells = 0;

  get x(): number {
    return this.native.x;
  }

  set x(value: number) {
    if (!Number.isFinite(value)) throw new Error(`invalid position x: ${value}`);
    this.native.x = value;
  }

  get y(): number {
    return this.native.y;
  }

  set y(value: number) {
    if (!Number.isFinite(value)) throw new Error(`invalid position y: ${value}`);
    this.native.y = value;
  }

  get cellX(): number {
    return this.native.cellX;
  }

  get cellY(): number {
    return this.native.cellY;
  }

  get SpeedCellsPerSecond(): number {
    return this.native.speedCellsPerSecond;
  }

  set SpeedCellsPerSecond(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`movement speed must be positive: ${value}`);
    }
    this.native.speedCellsPerSecond = value;
  }

  protected override Awake(
    native: NativeUnitRef,
    mapWidthCells: number,
    mapHeightCells: number,
  ): void {
    this.native = native;
    this.mapWidthCells = mapWidthCells;
    this.mapHeightCells = mapHeightCells;
  }

  CanOccupy(cellX: number, cellY: number): boolean {
    return canOccupyCell(
      cellX,
      cellY,
      this.mapWidthCells,
      this.mapHeightCells,
    );
  }

  SetCell(cellX: number, cellY: number): void {
    if (!this.CanOccupy(cellX, cellY)) {
      throw new Error(`cell is outside map: ${cellX},${cellY}`);
    }
    this.native.cellX = cellX;
    this.native.cellY = cellY;
    this.native.targetCellX = cellX;
    this.native.targetCellY = cellY;
    this.native.x = cellToWorld(cellX);
    this.native.y = cellToWorld(cellY);
  }

  snapshot(): PositionSnapshot {
    return {
      x: this.native.x,
      y: this.native.y,
      cellX: this.native.cellX,
      cellY: this.native.cellY,
    };
  }

  /** 只迁移跨地图仍有效的移动属性，故意排除坐标和移动中间态。 / Captures only movement attributes valid across maps, intentionally excluding coordinates and in-flight movement. */
  CaptureTransfer(): PositionTransferState {
    return {
      speedCellsPerSecond: this.native.speedCellsPerSecond,
      facing: this.native.facing,
      alive: this.native.alive !== 0,
    };
  }

  /** 在目标地图出生点已设置后恢复移动属性，不覆盖目标坐标。 / Restores movement attributes after target spawn placement without overwriting target coordinates. */
  RestoreTransfer(state: PositionTransferState): void {
    this.SpeedCellsPerSecond = state.speedCellsPerSecond;
    this.native.facing = state.facing;
    this.native.alive = Number(state.alive);
  }
}

export interface PositionTransferState {
  readonly speedCellsPerSecond: number;
  readonly facing: number;
  readonly alive: boolean;
}
