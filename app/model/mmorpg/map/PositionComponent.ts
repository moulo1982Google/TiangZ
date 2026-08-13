import {
  Component,
  component,
  transferable,
  type ITransfer,
} from "../../../core/public";
import {
  canOccupyCell,
  cellToWorldMeters,
  worldMetersToCell,
} from "../movement";
import type { NativeUnitRef } from "../../../generated/model/native/NativeUnitRef";

export interface PositionSnapshot {
  x: number;
  y: number;
  z: number;
  yaw: number;
  cellX: number;
  cellZ: number;
}

@component()
@transferable()
export class PositionComponent extends Component<[
  native: NativeUnitRef,
  mapWidthCells: number,
  mapDepthCells: number,
  cellSizeMeters: number,
]> implements ITransfer<PositionTransferState> {
  private native!: NativeUnitRef;
  private mapWidthCells = 0;
  private mapDepthCells = 0;
  private cellSizeMeters = 1;

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

  get z(): number {
    return this.native.z;
  }

  set z(value: number) {
    if (!Number.isFinite(value)) throw new Error(`invalid position z: ${value}`);
    this.native.z = value;
  }

  get yaw(): number {
    return this.native.yaw;
  }

  set yaw(value: number) {
    if (!Number.isFinite(value)) throw new Error(`invalid position yaw: ${value}`);
    this.native.yaw = normalizeYaw(value);
  }

  get cellX(): number {
    return this.native.cellX;
  }

  get cellZ(): number {
    return this.native.cellZ;
  }

  /** 统一使用米/秒；旧字段名保留给现有协议和迁移数据。 / Uses meters per second consistently; the legacy name remains for protocol and transfer compatibility. */
  get SpeedMetersPerSecond(): number {
    return this.native.speedCellsPerSecond;
  }

  set SpeedMetersPerSecond(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`movement speed must be positive: ${value}`);
    }
    this.native.speedCellsPerSecond = value;
  }

  /** 兼容旧业务调用；新代码应使用SpeedMetersPerSecond。 / Compatibility alias; new code should use SpeedMetersPerSecond. */
  get SpeedCellsPerSecond(): number {
    return this.SpeedMetersPerSecond;
  }

  set SpeedCellsPerSecond(value: number) {
    this.SpeedMetersPerSecond = value;
  }

  protected override Awake(
    native: NativeUnitRef,
    mapWidthCells: number,
    mapDepthCells: number,
    cellSizeMeters: number,
  ): void {
    this.native = native;
    this.mapWidthCells = mapWidthCells;
    this.mapDepthCells = mapDepthCells;
    this.cellSizeMeters = cellSizeMeters;
  }

  CanOccupy(cellX: number, cellZ: number): boolean {
    return canOccupyCell(
      cellX,
      cellZ,
      this.mapWidthCells,
      this.mapDepthCells,
    );
  }

  SetGridCell(cellX: number, cellZ: number, heightMeters = 0, yawRadians = 0): void {
    if (!this.CanOccupy(cellX, cellZ)) {
      throw new Error(`cell is outside map: ${cellX},${cellZ}`);
    }
    this.native.cellX = cellX;
    this.native.cellZ = cellZ;
    this.native.targetCellX = cellX;
    this.native.targetCellZ = cellZ;
    this.native.x = cellToWorldMeters(cellX, this.cellSizeMeters);
    this.native.y = heightMeters;
    this.native.z = cellToWorldMeters(cellZ, this.cellSizeMeters);
    this.native.yaw = normalizeYaw(yawRadians);
  }

  /** 使用米制世界坐标设置Grid2D出生点；X/Z必须精确落在Cell中心。 / Sets a Grid2D spawn in meters; X/Z must land exactly on cell centers. */
  SetGridWorldPosition(x: number, y: number, z: number, yaw: number): void {
    const cellX = worldMetersToCell(x, this.cellSizeMeters);
    const cellZ = worldMetersToCell(z, this.cellSizeMeters);
    const epsilon = 1e-5;
    if (
      Math.abs(cellToWorldMeters(cellX, this.cellSizeMeters) - x) > epsilon ||
      Math.abs(cellToWorldMeters(cellZ, this.cellSizeMeters) - z) > epsilon
    ) {
      throw new Error(`Grid2D position must be centered on a cell: ${x},${y},${z}`);
    }
    this.SetGridCell(cellX, cellZ, y, yaw);
  }

  /** 写入已经由Rust投影校验的NavMesh坐标，并同步AOI使用的Cell索引。 / Stores a Rust-projected NavMesh position and updates the cell indices used by AOI. */
  SetNavMeshWorldPosition(x: number, y: number, z: number, yaw: number): void {
    if (![x, y, z, yaw].every(Number.isFinite)) {
      throw new Error(`invalid NavMesh position: ${x},${y},${z},${yaw}`);
    }
    this.native.x = x;
    this.native.y = y;
    this.native.z = z;
    this.native.yaw = normalizeYaw(yaw);
    this.native.cellX = worldMetersToCell(x, this.cellSizeMeters);
    this.native.cellZ = worldMetersToCell(z, this.cellSizeMeters);
    this.native.targetCellX = this.native.cellX;
    this.native.targetCellZ = this.native.cellZ;
  }

  snapshot(): PositionSnapshot {
    return {
      x: this.native.x,
      y: this.native.y,
      z: this.native.z,
      yaw: this.native.yaw,
      cellX: this.native.cellX,
      cellZ: this.native.cellZ,
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

/** 将服务端朝向约束到[-PI, PI)，避免长期旋转积累出多种等价值。 / Normalizes authoritative yaw to [-PI, PI) so equivalent rotations have one representation. */
function normalizeYaw(value: number): number {
  const fullTurn = Math.PI * 2;
  return ((value + Math.PI) % fullTurn + fullTurn) % fullTurn - Math.PI;
}

export interface PositionTransferState {
  readonly speedCellsPerSecond: number;
  readonly facing: number;
  readonly alive: boolean;
}
