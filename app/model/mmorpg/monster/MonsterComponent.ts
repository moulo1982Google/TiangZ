import {
  Component,
  component,
  lifecycle,
  type Unit,
} from "../../../core/public";
import type { DamageRequest, DamageResult } from "../combat/CombatComponent";
import type { PlayerUnit } from "../map/PlayerUnit";
import type {
  M2C_InspectLootMonster,
  M2C_LootMonster,
} from "../../../generated/model/server/demo/protocol/messages";
import type { LootContainer } from "../loot/LootContainer";
import { MapAoiComponent } from "../map/MapAoiComponent";
import { MapComponent } from "../map/MapComponent";
import type {
  MonsterContentDefinition,
  MonsterContentSpawn,
} from "./MonsterContentProfileComponent";
import { MonsterUnit } from "./MonsterUnit";

export interface MonsterSpawnSlot {
  readonly config: Readonly<MonsterContentSpawn>;
  readonly definition: Readonly<MonsterContentDefinition>;
  monster: MonsterUnit | null;
  respawnAtMs: number;
  /** 每次成功创建后递增，为等级等生成期选择提供稳定序列。 / Incremented after each successful creation to seed stable spawn-time selections such as level. */
  spawnGeneration: number;
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
  /** 最近一次提交给 Rust 的目标点；相同目标不重复重建路径，避免 5Hz 重置造成客户端跳步。 / Last target submitted to Rust; identical targets do not rebuild the path every 5 Hz tick, preventing client-facing movement steps. */
  navigationTarget?: MonsterRuntimePoint | null;
  /** 用于确定性行为概率与文本选择的稳定计数器。 / Stable counter used for deterministic behavior chances and text choices. */
  behaviorEncounterSequence: number;
  /** 当前战斗中已经判定过的不可重复行为规则。 / Non-repeatable behavior rules already evaluated in the current encounter. */
  triggeredBehaviorRuleIds: Set<number>;
  /** AuraState规则最近观察到的每个不透明Buff状态。 / Last observed state for each opaque Buff used by an AuraState rule. */
  behaviorBuffStates: Map<number, boolean>;
  /** 可重复行为规则匹配后的下一次计时刻度；时间区间由所属模块提供。 / Next due time for each matched repeatable rule; owning modules provide the interval data. */
  behaviorRuleNextAtMs: Map<number, number>;
  /** 可重复行为规则的执行次数，用于区间内的确定性延迟选择。 / Per-rule execution counters used for deterministic delay selection within declared intervals. */
  behaviorRuleExecutionSequences: Map<number, number>;
  /** 脱战定时序列的每刷点执行进度；进入战斗时清空并在回归后重新初始化。 / Per-spawn idle-sequence progress, cleared on combat and initialized again after return. */
  idleSequenceStates: Map<number, MonsterIdleSequenceRuntimeState>;
  /** 模块持有的循环巡逻路径中的下一个点。 / Next point in a repeating module-owned patrol route. */
  ambientWaypointIndex: number;
  /** 当前延迟动作所在路径点；不处于到达暂停时为-1。 / Waypoint whose delayed actions are active, or -1 outside an arrival pause. */
  ambientWaypointActiveIndex: number;
  /** 到达当前活动路径点的时间。 / Time at which the active waypoint was reached. */
  ambientWaypointArrivedAtMs: number;
  /** 当前路径点有序动作列表中的下一个延迟动作。 / Next delayed action in the active waypoint's sorted action list. */
  ambientWaypointActionIndex: number;
  /** 用于确定性路径点动作概率的稳定到达计数器。 / Stable arrival counter used for deterministic waypoint action chances. */
  ambientWaypointArrivalSequence: number;
  /** 由路径点动作开启的临时随机移动半径。 / Temporary random-movement radius started by a waypoint action. */
  ambientWaypointWanderRadius: number;
  /** 路径点游走动作生效时，随机目标之间的短暂停顿截止时间。 / Short pause deadline between random destinations while a waypoint wander action is active. */
  ambientWaypointWanderPauseUntilMs: number;
  /** 到达路径点或随机游走目标后的延迟截止时间。 / Delay deadline after a waypoint or random-wander arrival. */
  ambientPauseUntilMs: number;
  /** 用于确定性选择游走目标和停顿的稳定序列。 / Stable sequence used to choose deterministic wander destinations and pauses. */
  ambientWanderSequence: number;
  /** 上一次实际停顿后已经完成的连续游走路段数。 / Completed consecutive wander legs since the last actual pause. */
  ambientWanderLegsSincePause: number;
  /** 当前随机游走目标；路径点目标仍保留在冷刷点数据中。 / Current random-wander destination; waypoint destinations remain cold spawn data. */
  ambientTarget: MonsterRuntimePoint | null;
  /** 当前战斗打断环境移动时所在的位置。 / Position where the current encounter interrupted ambient movement. */
  combatReturnPoint: MonsterRuntimePoint | null;
  /** 超出仇恨回归距离后回到刷点；回到刷点时会清空全部仇恨来源。 / Returning to spawn after the leash is exceeded; threat is cleared on return. */
  returningToSpawn: boolean;
}

export interface MonsterIdleSequenceRuntimeState {
  nextTriggerAtMs: number;
  activeSinceMs: number;
  nextActionIndex: number;
  executionSequence: number;
}

export interface MonsterRuntimePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface MonsterComponent {
  /** 激活一个已登记但当前空闲的稳定刷点。 / Activates a registered stable spawn slot that is currently idle. */
  ActivateSpawn(spawnId: number): void;
  /** 撤销一个已登记刷点的当前实体和旧尸体，不安排普通重生。 / Deactivates a registered slot, its live entity, and old corpses without scheduling a normal respawn. */
  DeactivateSpawn(spawnId: number): void;
  /** 在不暴露源结构的情况下解析模块持有的玩家模板战斗资格。 / Resolves module-owned player-template combat eligibility without exposing its source schema. */
  CanPlayerAttack(player: PlayerUnit, monster: MonsterUnit): boolean;
  /** 将外部适配器已解码的不透明信号提交给可见的存活怪物；信号编号及行为均由内容模块定义。 / Submits an adapter-decoded opaque signal to a visible live monster; the content module owns its id and behavior. */
  TriggerContentSignal(source: PlayerUnit, monsterId: number, signalId: number): boolean;
  ApplyPlayerDamage(
    attacker: PlayerUnit,
    monster: MonsterUnit,
    request: DamageRequest,
  ): DamageResult;
  /** 持续伤害等延迟来源通过同一死亡边界结算；sourceUnitId仍在Request中保留。 / Resolves delayed sources such as periodic damage through the same death boundary; sourceUnitId remains in the request. */
  ApplyUnitDamage(monster: MonsterUnit, request: DamageRequest): DamageResult;
  /** 增加中立的权威仇恨；模块可用它激活配置驱动的遭遇对手。 / Adds neutral authoritative threat; modules may use it to activate configured encounter opponents. */
  AddThreat(monster: MonsterUnit, source: PlayerUnit, amount: bigint): void;
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
