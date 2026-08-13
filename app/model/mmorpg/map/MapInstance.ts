import type { SceneConfig } from "../../../core/public";

/** 地图模板编号只描述静态配置，不承担运行时寻址。 / A map config ID describes a template and is never a runtime route. */
export type MapConfigId = number;

/** 地图实例编号是跨Process稳定的运行时身份；静态地图实例号等于配置号。 / A map instance ID is the cross-Process runtime identity; static instances equal their config IDs. */
export type MapInstanceId = bigint;

export interface MapInstanceDefinition {
  readonly mapConfigId: MapConfigId;
  readonly mapInstanceId: MapInstanceId;
  readonly dynamic: boolean;
}

export interface MapInstanceRoute extends MapInstanceDefinition {
  readonly mapHost: SceneConfig;
}

/** 把静态地图配置号转换为确定的实例号。 / Converts a static map config ID to its deterministic instance ID. */
export function StaticMapInstanceId(mapConfigId: MapConfigId): MapInstanceId {
  if (!Number.isSafeInteger(mapConfigId) || mapConfigId <= 0 || mapConfigId > 0xffff_ffff) {
    throw new Error(`invalid static map config id: ${mapConfigId}`);
  }
  return BigInt(mapConfigId);
}
