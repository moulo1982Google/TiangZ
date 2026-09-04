import { Component, component } from "../../../core/public";
import { SpatialMode } from "../../../generated/model/config";
import {
  canOccupyCell,
  cellToWorldMeters,
  worldMetersToCell,
} from "../movement";

/**
 * 由外部协议网关提交碰撞后位置时的地图级验收策略；只声明上限，不携带任何具体游戏坐标或速度。
 * Map-level acceptance policy for collision-resolved snapshots supplied by an
 * external protocol gateway; it defines only a bound, never game coordinates or speed.
 */
export interface ExternalMovementSnapshotProfile {
  readonly maxDeltaMeters: number;
}

/** 地图实例创建前冻结的空间资料；游戏模块只提供数据，空间实现与校验仍由TiangZ拥有。 / Spatial data frozen before map-instance creation; game modules provide data while TiangZ retains implementation and validation. */
export interface MapRuntimeSpatialProfile {
  readonly spatialMode: SpatialMode;
  readonly widthCells: number;
  readonly depthCells: number;
  readonly cellSizeMeters: number;
  readonly spawnX: number;
  readonly spawnY: number;
  readonly spawnZ: number;
  readonly spawnYaw: number;
  readonly navigationAsset: string;
  readonly navigationHash: string;
  readonly externalMovementSnapshots?: ExternalMovementSnapshotProfile;
}

/**
 * 地图工厂与外置游戏模块之间的中立资料边界。MapHost先装入默认冷配置，再同步执行MapScene扩展；
 * 最多一个模块可替换空间资料，避免加载顺序把冲突静默变成“最后写入者获胜”。
 *
 * Neutral data boundary between the map factory and external games. MapHost
 * installs cold defaults before synchronously extending MapScene. At most one
 * module may replace spatial data, preventing load order from silently choosing
 * a last writer.
 */
@component()
export class MapRuntimeProfileComponent extends Component {
  private mapConfigId = 0;
  private spatial: Readonly<MapRuntimeSpatialProfile> | undefined;
  private spatialOwner = "";

  get MapConfigId(): number {
    return this.mapConfigId;
  }

  get Spatial(): Readonly<MapRuntimeSpatialProfile> {
    if (!this.spatial) throw new Error("map runtime profile is not initialized");
    return this.spatial;
  }

  /** 由MapHost写入一次默认冷配置，游戏模块不得自行创建未初始化的地图资料。 / Initializes cold defaults once in MapHost; game modules must not fabricate an uninitialized profile. */
  Initialize(mapConfigId: number, profile: MapRuntimeSpatialProfile): void {
    if (this.spatial) throw new Error("map runtime profile is already initialized");
    if (!Number.isSafeInteger(mapConfigId) || mapConfigId <= 0) {
      throw new Error(`map config id must be a positive safe integer: ${mapConfigId}`);
    }
    this.mapConfigId = mapConfigId;
    this.spatial = freezeSpatialProfile(profile);
  }

  /** 允许一个外置游戏在地图发布前原子替换空间资料；模块ID会进入冲突错误。 / Atomically replaces spatial data for one external game before publication and retains its module ID for conflict diagnostics. */
  OverrideSpatial(ownerId: string, profile: MapRuntimeSpatialProfile): void {
    if (!this.spatial) throw new Error("map runtime profile is not initialized");
    const owner = requireOwnerId(ownerId, "map spatial profile");
    if (this.spatialOwner) {
      throw new Error(`map spatial profile already belongs to ${this.spatialOwner}`);
    }
    this.spatial = freezeSpatialProfile(profile);
    this.spatialOwner = owner;
  }
}

function freezeSpatialProfile(profile: MapRuntimeSpatialProfile): Readonly<MapRuntimeSpatialProfile> {
  if (!profile || typeof profile !== "object") throw new Error("map spatial profile must be an object");
  if (profile.spatialMode !== SpatialMode.Grid2D && profile.spatialMode !== SpatialMode.NavMesh3D) {
    throw new Error(`unsupported map spatial mode: ${profile.spatialMode}`);
  }
  requirePositiveInteger(profile.widthCells, "map width cells");
  requirePositiveInteger(profile.depthCells, "map depth cells");
  requirePositiveFinite(profile.cellSizeMeters, "map cell size meters");
  for (const [label, value] of [
    ["spawn x", profile.spawnX],
    ["spawn y", profile.spawnY],
    ["spawn z", profile.spawnZ],
    ["spawn yaw", profile.spawnYaw],
  ] as const) {
    if (!Number.isFinite(value)) throw new Error(`map ${label} must be finite: ${value}`);
  }
  if (profile.spatialMode === SpatialMode.Grid2D) {
    const cellX = worldMetersToCell(profile.spawnX, profile.cellSizeMeters);
    const cellZ = worldMetersToCell(profile.spawnZ, profile.cellSizeMeters);
    const epsilon = 1e-5;
    if (
      Math.abs(cellToWorldMeters(cellX, profile.cellSizeMeters) - profile.spawnX) > epsilon ||
      Math.abs(cellToWorldMeters(cellZ, profile.cellSizeMeters) - profile.spawnZ) > epsilon
    ) {
      throw new Error(`Grid2D map spawn must be centered on a cell: ${profile.spawnX},${profile.spawnZ}`);
    }
    if (!canOccupyCell(cellX, cellZ, profile.widthCells, profile.depthCells)) {
      throw new Error(`Grid2D map spawn is outside map: ${profile.spawnX},${profile.spawnZ}`);
    }
  }
  const externalMovementSnapshots = profile.externalMovementSnapshots;
  if (externalMovementSnapshots) {
    if (profile.spatialMode !== SpatialMode.Grid2D) {
      throw new Error("external movement snapshots currently require Grid2D");
    }
    requirePositiveFinite(
      externalMovementSnapshots.maxDeltaMeters,
      "external movement snapshot maximum delta meters",
    );
  }
  return Object.freeze({
    spatialMode: profile.spatialMode,
    widthCells: profile.widthCells,
    depthCells: profile.depthCells,
    cellSizeMeters: profile.cellSizeMeters,
    spawnX: profile.spawnX,
    spawnY: profile.spawnY,
    spawnZ: profile.spawnZ,
    spawnYaw: profile.spawnYaw,
    navigationAsset: profile.navigationAsset ?? "",
    navigationHash: profile.navigationHash ?? "",
    externalMovementSnapshots: externalMovementSnapshots
      ? Object.freeze({ maxDeltaMeters: externalMovementSnapshots.maxDeltaMeters })
      : undefined,
  });
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive: ${value}`);
}

function requirePositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive: ${value}`);
}

function requireOwnerId(value: string, label: string): string {
  const owner = value?.trim();
  if (!owner) throw new Error(`${label} owner id must not be empty`);
  return owner;
}
