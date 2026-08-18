import {
  Component,
  component,
  lifecycle,
  type Unit,
} from "../../../core/public";
import type { MonsterAreaConfig } from "../../../generated/model/config";
import type { DamageRequest, DamageResult } from "../combat/CombatComponent";
import type { PlayerUnit } from "../map/PlayerUnit";
import type {
  M2C_InspectLootMonster,
  M2C_LootMonster,
} from "../../../generated/model/server/demo/protocol/messages";
import type { LootContainer } from "../loot/LootContainer";
import { MapAoiComponent } from "../map/MapAoiComponent";
import { MapComponent } from "../map/MapComponent";
import { MonsterUnit } from "./MonsterUnit";

export interface MonsterSpawnSlot {
  readonly config: MonsterAreaConfig;
  monster: MonsterUnit | null;
  respawnAtMs: number;
}

export interface MonsterCorpseState {
  readonly monster: MonsterUnit;
  corpseExpiresAtMs: number;
  corpseCleanupInFlight: boolean;
}

export interface MonsterRuntimeState {
  targetUnitId: number;
  /** 只保存战斗运行态；数值是服务端权威伤害产生的仇恨，不进入客户端快照。 / Runtime-only threat values produced by authoritative server damage; never part of client snapshots. */
  threatByUnitId: Map<number, bigint>;
  /** 第一个造成有效伤害的账号；Starter普通掉落按首个有效攻击者归属，未来组队后替换为LootAudience。 / The first account to deal effective damage; Starter regular loot follows this tag until party loot is added. */
  lootOwnerAccount: string | null;
  nextThinkAtMs: number;
  nextAttackAtMs: number;
  navigationSequence: number;
  /** 超出仇恨回归距离后回到刷点；回到刷点时会清空全部仇恨来源。 / Returning to spawn after the leash is exceeded; threat is cleared on return. */
  returningToSpawn: boolean;
}

export interface MonsterComponent {
  ApplyPlayerDamage(
    attacker: PlayerUnit,
    monster: MonsterUnit,
    request: DamageRequest,
  ): DamageResult;
  InspectLootMonster(player: PlayerUnit, monsterId: number): M2C_InspectLootMonster;
  LootMonster(player: PlayerUnit, monsterId: number, operationId: string, dropId: number, lootAll: boolean): Promise<M2C_LootMonster>;
}

/**
 * 地图级刷怪总管：读取冷刷点、创建统一Unit、维护尸体和重生。
 * 第一版一条配置记录就是一个固定刷怪点，不引入随机区域和刷怪池。
 * 刷怪槽位长期存在且只持有当前活怪；死亡Unit转入独立尸体集合，仍可在AOI中被查看和拾取。
 * 重生时间与尸体窗口相互独立，避免五分钟掉落尸体阻塞十秒刷新规则。
 *
 * Map-level monster owner. It reads cold spawn points, creates regular Units,
 * and owns corpse/respawn state. A stable spawn slot owns only its current live
 * monster. Dead Units move to an independent corpse set and remain visible and
 * lootable in AOI. Respawn deadlines never wait for corpse expiration.
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
  /** 尸体与刷怪槽位分离；同一刷点可同时有新活怪和仍在拾取窗口内的旧尸体。 / Corpses are independent from spawn slots, allowing a replacement and its older lootable corpse to coexist. */
  protected readonly corpses = new Map<number, MonsterCorpseState>();
  /** 尸体掉落归Map所有；普通掉落带首个有效攻击者归属，任务掉落按账号资格判断。 / Corpse loot belongs to the Map; regular rows are tagged to the first effective attacker and quest rows use account eligibility. */
  protected readonly lootContainers = new Map<number, LootContainer>();
  protected nextMonsterUnitId = 0x8000_0000;

  /** 查询本地图怪物；业务攻击、任务和掉落只通过这个入口取Unit。 / Looks up a map monster for attacks, quests, and drops. */
  Get(monsterId: number): MonsterUnit | undefined {
    return this.monsters.get(monsterId);
  }

  /** 返回当前怪物与尸体的稳定数组快照；调用者需按alive过滤且不得保存到下一帧。 / Returns a stable snapshot including corpses; callers must filter by alive and never retain it across ticks. */
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
