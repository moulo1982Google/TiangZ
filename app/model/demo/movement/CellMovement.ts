export const CELL_SIZE = 12;
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
  readonly fromCellY: number;
  readonly toCellX: number;
  readonly toCellY: number;
  readonly moveStartTick: number;
  readonly moveEndTick: number;
  readonly moving: boolean;
  readonly stateChanged: boolean;
}

export function cellToWorld(cell: number): number {
  return cell * CELL_SIZE;
}

export function worldToCell(world: number): number {
  return Math.round(world / CELL_SIZE);
}

export function clampDirection(value: number): number {
  return Math.max(-1, Math.min(1, Math.round(value)));
}

export function canOccupyCell(
  x: number,
  y: number,
  widthCells = MAP_CELL_COUNT,
  heightCells = MAP_CELL_COUNT,
): boolean {
  const minX = -Math.floor(widthCells / 2) + 1;
  const maxX = Math.floor((widthCells - 1) / 2) - 1;
  const minY = -Math.floor(heightCells / 2) + 1;
  const maxY = Math.floor((heightCells - 1) / 2) - 1;
  return x >= minX && x <= maxX && y >= minY && y <= maxY;
}
