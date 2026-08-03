import {
  Component,
  component,
  lifecycle,
  type Unit,
} from "../../../core/public";
import type { MonsterAreaConfig } from "../../../generated/model/config";
import { MapAoiComponent } from "../map/MapAoiComponent";
import { MapComponent } from "../map/MapComponent";
import { MonsterUnit } from "./MonsterUnit";

export interface MonsterSpawnSlot {
  readonly config: MonsterAreaConfig;
  monster: MonsterUnit | null;
  deadAtMs: number;
  respawnAtMs: number;
}

export interface MonsterRuntimeState {
  targetUnitId: number;
  nextThinkAtMs: number;
  nextAttackAtMs: number;
  navigationSequence: number;
}

/**
 * 地图级刷怪总管：读取冷刷点、创建统一Unit、维护死亡与重生。
 * 第一版一条配置记录就是一个固定刷怪点，不引入随机区域和刷怪池。
 *
 * Map-level monster owner. It reads cold spawn points, creates regular Units,
 * and owns death/respawn. Version one treats each config row as one fixed slot.
 */
@component()
@lifecycle({ awake: true, destroy: true })
export class MonsterComponent extends Component<[
  map: MapComponent,
  aoi: MapAoiComponent,
]> {
  protected map!: MapComponent;
  protected aoi!: MapAoiComponent;
  protected readonly slots = new Map<number, MonsterSpawnSlot>();
  protected readonly monsters = new Map<number, MonsterUnit>();
  protected readonly runtime = new Map<number, MonsterRuntimeState>();
  protected nextMonsterUnitId = 0x8000_0000;

  /** 查询本地图怪物；业务攻击、任务和掉落只通过这个入口取Unit。 / Looks up a map monster for attacks, quests, and drops. */
  Get(monsterId: number): MonsterUnit | undefined {
    return this.monsters.get(monsterId);
  }

  /** 返回当前存活怪物的稳定数组快照；调用者不得保存到下一帧。 / Returns a stable current-monster snapshot that callers must not retain across ticks. */
  GetAll(): readonly MonsterUnit[] {
    return [...this.monsters.values()];
  }

  /** 只允许同一地图Unit进入怪物模块；用于避免跨地图误伤。 / Accepts only Units from this map to prevent cross-map damage. */
  protected RequireMapUnit(unit: Unit<any[]>): void {
    if (unit.DomainScene() !== this.DomainScene()) {
      throw new Error(`monster unit ${unit.UnitId} belongs to another map`);
    }
  }
}
