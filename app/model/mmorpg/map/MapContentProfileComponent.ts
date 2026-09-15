import { Component, component } from "../../../core/public";
import { GameConfigs } from "../../../generated/model/config";
import { freezeSpatialProfile, type MapRuntimeSpatialProfile } from "./MapRuntimeProfileComponent";

export interface MapContentDefinition {
  readonly id: number;
  readonly spatial: MapRuntimeSpatialProfile;
  readonly entryPlayersPerTick: number;
  readonly entryQueueCapacity: number;
  readonly aoi: {
    readonly gridSizeCells: number;
    readonly enterRangeGrids: number;
    readonly detachRangeGrids: number;
    readonly tiers: readonly { readonly rangeGrids: number; readonly syncHz: number }[];
  };
}

/** 宿主拥有的启动期地图目录；模块无需向主工程内容表添加占位地图。 / Host-owned startup map catalog without placeholder rows in engine content tables. */
@component()
export class MapContentProfileComponent extends Component {
  private readonly definitions = new Map<number, Readonly<MapContentDefinition>>();
  private sealed = false;

  /** 整批校验后登记，重复 ID（包括内置地图）拒绝；发布后不可变更。 / Atomically registers validated definitions, rejecting built-in/duplicate IDs and post-publication changes. */
  Register(owner: string, definitions: readonly MapContentDefinition[]): void {
    if (this.sealed || !owner.trim()) throw new Error("map catalog is sealed or owner is empty");
    const pending = new Map<number, Readonly<MapContentDefinition>>();
    for (const value of definitions) {
      const aoi = value.aoi;
      if (!Number.isSafeInteger(value.id) || value.id <= 0 || this.definitions.has(value.id)
        || pending.has(value.id) || GameConfigs.MapConfig.TryGet(value.id)) throw new Error(`map content ID conflict: ${value.id}`);
      if (![value.entryPlayersPerTick, value.entryQueueCapacity, aoi.gridSizeCells].every(n => Number.isSafeInteger(n) && n > 0)
        || value.entryPlayersPerTick > value.entryQueueCapacity
        || ![aoi.enterRangeGrids, aoi.detachRangeGrids, ...aoi.tiers.map(t => t.rangeGrids)].every(n => Number.isSafeInteger(n) && n > 0 && n % 2 === 1)
        || aoi.detachRangeGrids < aoi.enterRangeGrids || !aoi.tiers.length
        || aoi.tiers.some(t => !Number.isFinite(t.syncHz) || t.syncHz <= 0)
        || new Set(aoi.tiers.map(t => t.rangeGrids)).size !== aoi.tiers.length
        || Math.max(...aoi.tiers.map(t => t.rangeGrids)) < aoi.detachRangeGrids
        || value.spatial.widthCells % aoi.gridSizeCells !== 0 || value.spatial.depthCells % aoi.gridSizeCells !== 0) throw new Error(`invalid map admission/AOI: ${value.id}`);
      pending.set(value.id, Object.freeze({ ...value, spatial: freezeSpatialProfile(value.spatial),
        aoi: Object.freeze({ ...aoi, tiers: Object.freeze(aoi.tiers.map(t => Object.freeze({ ...t })).sort((a,b) => a.rangeGrids-b.rangeGrids)) }) }));
    }
    for (const [id, value] of pending) this.definitions.set(id, value);
  }

  /** 地图启动前封闭目录。 / Seals the catalog before maps start. */
  Seal(): void { this.sealed = true; }

  /** 优先模块定义，旧工程继续读取原内容表；返回中立的完整创建资料。 / Resolves module content with legacy cold-table fallback into neutral creation data. */
  Resolve(id: number): Readonly<MapContentDefinition> | undefined {
    const custom = this.definitions.get(id);
    if (custom) return custom;
    const cold = GameConfigs.MapConfig.TryGet(id);
    if (!cold) return undefined;
    const aoi = cold.aoiConfigId_ref;
    if (!aoi) throw new Error(`map ${id} has no AOI config`);
    return { id, spatial: cold, entryPlayersPerTick: cold.entryPlayersPerTick, entryQueueCapacity: cold.entryQueueCapacity,
      aoi: { gridSizeCells: aoi.gridSizeCells, enterRangeGrids: aoi.enterRangeGrids, detachRangeGrids: aoi.detachRangeGrids,
        tiers: GameConfigs.AoiSyncTierConfig.GetAll().filter(t => t.aoiConfigId === aoi.id).sort((a,b) => a.rangeGrids-b.rangeGrids) } };
  }
}
