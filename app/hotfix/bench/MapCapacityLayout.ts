import { GameConfigs } from "#tiangz/model";

export interface MapCapacityPlacement {
  readonly cellX: number;
  readonly cellZ: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
}

const GRID_CROSSING_PLAYER_MODULUS = 5;
const GRID_CROSSING_SECONDS = 2;

/**
 * 判断均匀AOI基线中的虚拟玩家是否属于跨Grid组。每5人固定选择1人，保证20%比例可复现。
 * 该分类只属于Bench负载模型，不能用于正式业务分流。
 *
 * Returns whether a virtual player belongs to the deterministic 20% grid-crossing cohort.
 * This is benchmark workload metadata and must not be used by production gameplay.
 */
export function IsMapCapacityGridCrossingPlayer(
  mapId: number,
  playerIndex: number,
  layout: number,
): boolean {
  if (layout !== 1) return false;
  const map = GameConfigs.MapConfig.Get(mapId);
  const aoi = map.aoiConfigId_ref;
  if (!aoi) throw new Error(`map ${map.id} has no AOI config`);
  const gridCount = (map.widthCells / aoi.gridSizeCells) *
    (map.depthCells / aoi.gridSizeCells);
  const gridIndex = playerIndex % gridCount;
  const playerSlotInGrid = Math.floor(playerIndex / gridCount);
  return (gridIndex + playerSlotInGrid) % GRID_CROSSING_PLAYER_MODULUS === 0;
}

/**
 * 返回Bench玩家的权威移动速度。跨Grid组用两秒走完一个Grid中心距，其余玩家保持1 Cell/s。
 * 速度由服务端设置，压测客户端只发送方向，避免用传送伪造AOI跨界成本。
 *
 * Returns the authoritative benchmark speed. Crossing players travel one grid-center distance
 * every two seconds; local players remain at one cell per second.
 */
export function MapCapacitySpeedCellsPerSecond(
  mapId: number,
  playerIndex: number,
  layout: number,
): number {
  if (!IsMapCapacityGridCrossingPlayer(mapId, playerIndex, layout)) return 1;
  const map = GameConfigs.MapConfig.Get(mapId);
  const aoi = map.aoiConfigId_ref;
  if (!aoi) throw new Error(`map ${map.id} has no AOI config`);
  return aoi.gridSizeCells / GRID_CROSSING_SECONDS;
}

/**
 * 根据冷地图配置计算可复现的Bench出生点。布局1轮询全部Grid中央Cell；布局2使用中央Grid的安全锚点。
 * 该函数只服务Bench Bundle，正式客户端不能选择服务端权威坐标。
 *
 * Computes deterministic benchmark spawns from cold map config. Layout 1 cycles through grid
 * centers; layout 2 uses safe anchors in the center grid. Production clients cannot call it.
 */
export function MapCapacityPlacementOf(
  mapId: number,
  playerIndex: number,
  layout: number,
  anchorSeed = playerIndex,
): MapCapacityPlacement {
  const map = GameConfigs.MapConfig.Get(mapId);
  const aoi = map.aoiConfigId_ref;
  if (!aoi) throw new Error(`map ${map.id} has no AOI config`);
  if (map.widthCells % aoi.gridSizeCells !== 0 || map.depthCells % aoi.gridSizeCells !== 0) {
    throw new Error(
      `map ${map.id} dimensions must be exact multiples of AOI Grid size: ` +
      `${map.widthCells}x${map.depthCells} / ${aoi.gridSizeCells}`,
    );
  }
  if (layout !== 1 && layout !== 2) throw new Error(`unsupported map capacity layout: ${layout}`);

  const gridsX = map.widthCells / aoi.gridSizeCells;
  const gridsZ = map.depthCells / aoi.gridSizeCells;
  const gridCount = gridsX * gridsZ;
  const gridIndex = playerIndex % gridCount;
  const gridX = layout === 2 ? Math.floor(gridsX / 2) : gridIndex % gridsX;
  const gridZ = layout === 2 ? Math.floor(gridsZ / 2) : Math.floor(gridIndex / gridsX);
  const gridMinCellX = -Math.floor(map.widthCells / 2) + gridX * aoi.gridSizeCells;
  const gridMinCellZ = -Math.floor(map.depthCells / 2) + gridZ * aoi.gridSizeCells;
  const gridMaxCellX = gridMinCellX + aoi.gridSizeCells - 1;
  const gridMaxCellZ = gridMinCellZ + aoi.gridSizeCells - 1;
  let cellX = gridMinCellX + Math.floor(aoi.gridSizeCells / 2);
  let cellZ = gridMinCellZ + Math.floor(aoi.gridSizeCells / 2);
  if (layout === 2) {
    if (aoi.gridSizeCells < 7) throw new Error(`AOI Grid is too small: ${aoi.gridSizeCells}`);
    const centerX = cellX;
    const centerZ = cellZ;
    const anchorOffset = Math.max(1, Math.floor(aoi.gridSizeCells / 6));
    const lowX = centerX - anchorOffset;
    const highX = centerX + anchorOffset;
    const lowZ = centerZ - anchorOffset;
    const highZ = centerZ + anchorOffset;
    switch (anchorSeed % 4) {
      case 0: [cellX, cellZ] = [lowX, lowZ]; break;
      case 1: [cellX, cellZ] = [highX, lowZ]; break;
      case 2: [cellX, cellZ] = [highX, highZ]; break;
      default: [cellX, cellZ] = [lowX, highZ]; break;
    }
  }
  return {
    cellX,
    cellZ,
    x: cellX * map.cellSizeMeters,
    y: map.spawnY,
    z: cellZ * map.cellSizeMeters,
    yaw: map.spawnYaw,
  };
}
