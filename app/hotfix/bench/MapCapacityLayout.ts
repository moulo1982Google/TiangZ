import { GameConfigs } from "#tiangz/model";

export interface MapCapacityPlacement {
  readonly cellX: number;
  readonly cellZ: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
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
    if (aoi.gridSizeCells < 5) throw new Error(`AOI Grid is too small: ${aoi.gridSizeCells}`);
    const lowX = gridMinCellX + 2;
    const highX = gridMaxCellX - 2;
    const lowZ = gridMinCellZ + 2;
    const highZ = gridMaxCellZ - 2;
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
