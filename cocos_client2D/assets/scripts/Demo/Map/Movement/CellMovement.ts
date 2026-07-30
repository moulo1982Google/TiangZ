/** Cocos 2D展示比例；服务端世界仍以米为单位。 / Presentation scale only; the server world remains meter-based. */
export const PIXELS_PER_METER = 12;
export const MAP_CELL_COUNT = 128;
export const UNIT_FOOTPRINT_CELLS = 3;
export const DEFAULT_MOVE_SPEED_CELLS_PER_SECOND = 10;
export const MIN_UNIT_CELL = -63;
export const MAX_UNIT_CELL = 62;

export const Facing = {
  Down: 0,
  Left: 1,
  Right: 2,
  Up: 3,
} as const;

export type Facing = typeof Facing[keyof typeof Facing];

export function normalizeFacing(value: number): Facing {
  return value === Facing.Left || value === Facing.Right || value === Facing.Up
    ? value
    : Facing.Down;
}

export function facingFromDirection(x: number, y: number): Facing {
  if (y > 0) return Facing.Up;
  if (y < 0) return Facing.Down;
  if (x < 0) return Facing.Left;
  if (x > 0) return Facing.Right;
  return Facing.Down;
}

export function cellToWorld(cell: number): number {
  return cell * PIXELS_PER_METER;
}

export function worldToCell(world: number): number {
  return Math.round(world / PIXELS_PER_METER);
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

export function stepDurationSeconds(
  directionX: number,
  directionY: number,
  fixedUpdateMs: number,
  speedCellsPerSecond = DEFAULT_MOVE_SPEED_CELLS_PER_SECOND,
): number {
  const distance = directionX !== 0 && directionY !== 0 ? Math.SQRT2 : 1;
  const durationMs = 1_000 * distance / speedCellsPerSecond;
  return Math.max(1, Math.ceil(durationMs / fixedUpdateMs)) * fixedUpdateMs / 1_000;
}
