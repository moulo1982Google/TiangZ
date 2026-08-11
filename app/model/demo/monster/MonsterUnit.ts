import { Unit, lifecycle } from "../../../core/public";
import type { UnitNumericDelta } from "../../../generated/model/server/demo/protocol/messages";

export interface AwakeMonsterUnit {
  readonly mapId: number;
  readonly mapInstanceId: bigint;
  readonly areaId: number;
  readonly monsterConfigId: number;
}

export interface MonsterSnapshot {
  readonly unitId: number;
  readonly monsterConfigId: number;
  readonly name: string;
  readonly modelId: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly cellX: number;
  readonly cellZ: number;
  readonly speedCellsPerSecond: number;
  readonly facing: number;
  readonly alive: boolean;
  readonly numerics: readonly UnitNumericDelta[];
}

/**
 * 地图中的怪物也是统一Unit；它没有玩家账号和Gate归属。
 * 具体AI、攻击和生命周期规则由MonsterUnitSystem热更承载。
 *
 * A monster is a regular map Unit without an account or Gate ownership.
 * Hotfix MonsterUnitSystem owns its AI, attack, and lifecycle rules.
 */
@lifecycle({ awake: true, destroy: true })
export class MonsterUnit extends Unit<[request: AwakeMonsterUnit]> {
  protected mapId = 0;
  protected mapInstanceId = 0n;
  protected areaId = 0;
  protected monsterConfigId = 0;

  get MapId(): number {
    return this.mapId;
  }

  get MapInstanceId(): bigint {
    return this.mapInstanceId;
  }

  get AreaId(): number {
    return this.areaId;
  }

  get MonsterConfigId(): number {
    return this.monsterConfigId;
  }
}
