// 服务端世界坐标统一使用米；Cocos/Pixi自行决定一米对应多少屏幕像素。
// Server world coordinates are meters; Cocos/Pixi choose their own pixels-per-meter scale.
export const GRID_CELL_SIZE_METERS = 1;
export const MAP_CELL_COUNT = 128;
export const UNIT_FOOTPRINT_CELLS = 3;
export const DEFAULT_MOVE_SPEED_CELLS_PER_SECOND = 10;

// 128 个格子使用 -64..63；3x3 Unit 的中心不能落在最外圈。
export const MIN_UNIT_CELL = -63;
export const MAX_UNIT_CELL = 62;

export interface MovementFrame {
  readonly unitId: number;
  readonly acknowledgedSequence: number;
  readonly fromCellX: number;
  readonly fromCellZ: number;
  readonly toCellX: number;
  readonly toCellZ: number;
  readonly moveStartTick: number;
  readonly moveEndTick: number;
  readonly moving: boolean;
  readonly stateChanged: boolean;
}

export function cellToWorldMeters(
  cell: number,
  cellSizeMeters = GRID_CELL_SIZE_METERS,
): number {
  return cell * cellSizeMeters;
}

export function worldMetersToCell(
  world: number,
  cellSizeMeters = GRID_CELL_SIZE_METERS,
): number {
  return Math.round(world / cellSizeMeters);
}

export function clampDirection(value: number): number {
  return Math.max(-1, Math.min(1, Math.round(value)));
}

export function canOccupyCell(
  x: number,
  z: number,
  widthCells = MAP_CELL_COUNT,
  depthCells = MAP_CELL_COUNT,
): boolean {
  const minX = -Math.floor(widthCells / 2) + 1;
  const maxX = Math.floor((widthCells - 1) / 2) - 1;
  const minZ = -Math.floor(depthCells / 2) + 1;
  const maxZ = Math.floor((depthCells - 1) / 2) - 1;
  return x >= minX && x <= maxX && z >= minZ && z <= maxZ;
}
