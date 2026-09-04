// 服务端世界坐标统一使用米；Cocos/Pixi自行决定一米对应多少屏幕像素。
// Server world coordinates are meters; Cocos/Pixi choose their own pixels-per-meter scale.
export const CELL_SIZE_METERS = 1;
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
  cellSizeMeters = CELL_SIZE_METERS,
): number {
  return cell * cellSizeMeters;
}

export function worldMetersToCell(
  world: number,
  cellSizeMeters = CELL_SIZE_METERS,
): number {
  return Math.round(world / cellSizeMeters);
}

export function clampDirection(value: number): number {
  return Math.max(-1, Math.min(1, Math.round(value)));
}

/**
 * 把角色朝向空间中的前后/横移输入量化为Grid2D八方向。Yaw 0朝+Z，正横移朝角色右侧；
 * 22.5度阈值让临近主轴的输入保持主轴，其余角度进入对角线。
 *
 * Quantizes facing-relative forward/strafe input to Grid2D's eight directions.
 * Yaw zero faces +Z and positive strafe points right; a 22.5-degree threshold
 * keeps input near a cardinal axis on that axis and maps the remainder diagonally.
 */
export function resolveFacingRelativeGridInput(
  forward: number,
  strafe: number,
  yaw: number,
): { readonly inputX: number; readonly inputZ: number } {
  if (
    !Number.isInteger(forward) ||
    !Number.isInteger(strafe) ||
    Math.abs(forward) > 1 ||
    Math.abs(strafe) > 1 ||
    !Number.isFinite(yaw)
  ) {
    throw new Error("invalid facing-relative Grid2D input");
  }
  if (forward === 0 && strafe === 0) return { inputX: 0, inputZ: 0 };
  const directionX = Math.sin(yaw) * forward + Math.cos(yaw) * strafe;
  const directionZ = Math.cos(yaw) * forward - Math.sin(yaw) * strafe;
  const threshold = Math.sin(Math.PI / 8);
  return {
    inputX: Math.abs(directionX) >= threshold ? Math.sign(directionX) : 0,
    inputZ: Math.abs(directionZ) >= threshold ? Math.sign(directionZ) : 0,
  };
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
