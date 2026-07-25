import { Component, component } from "../../core/public";
import {
  canOccupyCell,
  cellToWorld,
} from "../movement";
import type { NativeUnitRef } from "../../generated/model/native/NativeUnitRef";

export interface PositionSnapshot {
  x: number;
  y: number;
  cellX: number;
  cellY: number;
}

@component()
export class PositionComponent extends Component<[native: NativeUnitRef]> {
  private native!: NativeUnitRef;

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

  get CellX(): number {
    return this.cellX;
  }

  get CellY(): number {
    return this.cellY;
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

  protected override Awake(native: NativeUnitRef): void {
    this.native = native;
  }

  CanOccupy(cellX: number, cellY: number): boolean {
    return canOccupyCell(cellX, cellY);
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
}
