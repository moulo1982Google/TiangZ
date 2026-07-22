import { Component, component } from "../../core/runtime";
import {
  canOccupyCell,
  cellToWorld,
  worldToCell,
} from "../movement";
import type { NativeUnitRef } from "../../generated/model/native/NativeUnitRef";

export interface PositionSnapshot {
  x: number;
  y: number;
  cellX: number;
  cellY: number;
}

@component()
export class PositionComponent extends Component<[
  x: number,
  y: number,
  native?: NativeUnitRef,
]> {
  private currentCellX = 0;
  private currentCellY = 0;
  private native: NativeUnitRef | undefined;

  get CellX(): number {
    return this.native?.Snapshot().cellX ?? this.currentCellX;
  }

  get CellY(): number {
    return this.native?.Snapshot().cellY ?? this.currentCellY;
  }

  protected override Awake(x: number, y: number, native?: NativeUnitRef): void {
    this.currentCellX = worldToCell(x);
    this.currentCellY = worldToCell(y);
    this.native = native;
  }

  CanOccupy(cellX: number, cellY: number): boolean {
    return canOccupyCell(cellX, cellY);
  }

  SetCell(cellX: number, cellY: number): void {
    if (this.native) {
      throw new Error("native Unit position must be updated by NativeData.FixedUpdateMap");
    }
    if (!this.CanOccupy(cellX, cellY)) {
      throw new Error(`cell is outside map: ${cellX},${cellY}`);
    }
    this.currentCellX = cellX;
    this.currentCellY = cellY;
  }

  snapshot(): PositionSnapshot {
    if (this.native) {
      const snapshot = this.native.Snapshot();
      return {
        x: snapshot.x,
        y: snapshot.y,
        cellX: snapshot.cellX,
        cellY: snapshot.cellY,
      };
    }
    return {
      x: cellToWorld(this.currentCellX),
      y: cellToWorld(this.currentCellY),
      cellX: this.currentCellX,
      cellY: this.currentCellY,
    };
  }
}
