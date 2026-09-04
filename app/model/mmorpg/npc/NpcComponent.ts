import { Component, component, lifecycle } from "../../../core/public";
import type { MapAoiComponent } from "../map/MapAoiComponent";
import type { MapComponent } from "../map/MapComponent";
import type { PlayerUnit } from "../map/PlayerUnit";
import type { DamageRequest, DamageResult } from "../combat/CombatComponent";
import type {
  NpcContentDefinition,
  NpcContentInteractionRule,
  NpcContentInteractionTriggerValue,
  NpcContentIdleSequence,
  NpcContentSpawn,
  NpcContentWaypoint,
  NpcRuntimeContentPatch,
} from "./NpcContentProfileComponent";
import { NpcUnit } from "./NpcUnit";

export const STARTER_NPC_UNIT_ID = 0x4000_0001;
export const STARTER_NPC_CONFIG_ID = 9001;
export const STARTER_NPC_NAME = "任务使者";
export const STARTER_NPC_QUEST_CONFIG_IDS = [5001, 5002, 5003, 5004, 5005, 5006] as const;
export const STARTER_SHOP_NPC_UNIT_ID = 0x4000_0002;
export const STARTER_SHOP_NPC_CONFIG_ID = 9002;
export const STARTER_SHOP_NPC_NAME = "杂货商";
export const STARTER_NPC_INTERACT_RANGE_METERS = 5;

export interface NpcComponent {
  Get(npcUnitId: number): NpcUnit | undefined;
  GetAll(): readonly NpcUnit[];
  /** 激活外置目录中的稳定NPC刷点；重复激活保持幂等。 / Activates a stable NPC spawn from the external catalog; repeated activation is idempotent. */
  ActivateSpawn(spawnId: number): void;
  /** 停用NPC刷点并清理路线、交互状态、AOI和Unit所有权。 / Deactivates an NPC spawn and clears routes, interactions, AOI, and Unit ownership. */
  DeactivateSpawn(spawnId: number): void;
  /** 对一个定义的全部当前/未来刷点应用可逆内容增量。 / Applies a reversible content delta to every current and future spawn of one definition. */
  ApplyDefinitionContentPatch(ownerId: string, npcDefinitionId: number, patch: NpcRuntimeContentPatch): readonly NpcUnit[];
  RemoveDefinitionContentPatch(ownerId: string, npcDefinitionId: number): readonly NpcUnit[];
  /** 对一个稳定刷点应用可逆内容增量。 / Applies a reversible content delta to one stable spawn. */
  ApplySpawnContentPatch(ownerId: string, spawnId: number, patch: NpcRuntimeContentPatch): readonly NpcUnit[];
  RemoveSpawnContentPatch(ownerId: string, spawnId: number): readonly NpcUnit[];
  /** 在PlayerUnit有序mailbox内校验商店归属、距离和可交互状态。 / Validates shop ownership, distance, and availability in the ordered PlayerUnit mailbox. */
  ValidateShopInteraction(player: PlayerUnit, npcUnitId: number): NpcUnit;
  /** 校验训练师归属、地图挂载与交互距离。 / Validates trainer ownership, map attachment, and interaction distance. */
  ValidateTrainerInteraction(player: PlayerUnit, npcUnitId: number): NpcUnit;
  /** 校验修理服务归属、地图挂载与交互距离。 / Validates repair-service ownership, map attachment, and interaction distance. */
  ValidateRepairInteraction(player: PlayerUnit, npcUnitId: number): NpcUnit;
  /** 在PlayerUnit有序mailbox内调用，校验NPC归属、任务提供关系和距离。 / Call inside the PlayerUnit ordered mailbox to validate ownership, quest offering, and distance. */
  ValidateQuestOffer(player: PlayerUnit, npcUnitId: number, questConfigId: number): void;
  /** 在 PlayerUnit 有序 mailbox 内校验 NPC 归属、任务交付关系和距离。 / Validates ownership, quest turn-in, and distance in the ordered PlayerUnit mailbox. */
  ValidateQuestTurnIn(player: PlayerUnit, npcUnitId: number, questConfigId: number): void;
  /** 校验同地图、AOI已挂载且距离足够近的NPC内容事实来源。 / Validates a nearby same-map NPC as the source of an external content fact. */
  ValidateContentInteraction(player: PlayerUnit, npcUnitId: number): NpcUnit;
  /** 在已提交的领域事实之后触发内容声明的NPC表现规则；不会回滚或修改领域状态。 / Triggers content-declared NPC presentation rules after a committed domain fact; never rolls back or mutates domain state. */
  TriggerInteraction(
    player: PlayerUnit,
    npcUnitId: number,
    trigger: NpcContentInteractionTriggerValue,
    triggerValue: number,
  ): void;
  /** 判断一个玩家模板能否攻击当前存活 NPC。 / Returns whether a player template may attack this live NPC. */
  CanPlayerAttack(player: PlayerUnit, npc: NpcUnit): boolean;
  /** 通过 NPC 生命周期边界结算玩家伤害、仇恨、死亡和重生。 / Resolves player damage, threat, death, and respawn through the NPC lifecycle boundary. */
  ApplyPlayerDamage(attacker: PlayerUnit, npc: NpcUnit, request: DamageRequest): DamageResult;
  /** 延迟伤害沿相同死亡边界结算；来源玩家离图后仍完成 NPC 生命周期。 / Resolves delayed damage through the same death boundary even after its player source leaves. */
  ApplyUnitDamage(npc: NpcUnit, request: DamageRequest): DamageResult;
  /** 通过共享的玩家死亡与战斗状态边界结算 NPC 来源伤害。 / Resolves NPC-originated damage through the shared player-death and combat-state boundary. */
  ApplyDamageToPlayer(npc: NpcUnit, target: PlayerUnit, request: DamageRequest): DamageResult;
  /** 平A命中入口；复用与技能相同的资格、伤害和死亡边界。 / Auto-attack hit entry sharing skill eligibility, damage, and death semantics. */
  Attack(attacker: PlayerUnit, npc: NpcUnit): DamageResult;
}

/** 战斗型 NPC 的地图临时状态；定义和刷点仍由只读内容目录拥有。 / Map-local state for combat-capable NPCs; immutable definitions and slots remain content-owned. */
export interface NpcCombatRuntimeState {
  readonly spawnId: number;
  targetUnitId: number;
  readonly threatByUnitId: Map<number, bigint>;
  nextAttackAtMs: number;
  navigationSequence: number;
  navigationTarget: Readonly<{ x: number; y: number; z: number }> | null;
  returningToSpawn: boolean;
  corpseExpiresAtMs: number;
  respawnAtMs: number;
  engagementSequence: number;
  behaviorState: number;
  combatMovementEnabled: boolean;
  fleeing: boolean;
  fleeDistanceMeters: number;
  readonly triggeredBehaviorRuleIds: Set<number>;
  readonly behaviorRuleNextAtMs: Map<number, number>;
  readonly behaviorRuleExecutionSequences: Map<number, number>;
}

/** 内容声明 NPC 路线的运行时游标；源 AI 状态仍由 Core 外部持有。 Runtime cursor for a content-declared NPC route; source AI state stays outside Core. */
export interface NpcRouteState {
  readonly waypoints: readonly NpcContentWaypoint[];
  nextWaypointIndex: number;
  pauseUntilMs: number;
  navigationSequence: number;
  /** 上一次已提交的导航目标；重复目标不得重启 Rust 路径。 / Last submitted target; resubmitting it must not restart the Rust path. */
  navigationTarget: Readonly<{ x: number; y: number; z: number }> | null;
}

/** NPC空闲序列的运行时游标；内容定义保持冷数据，调度状态只存在地图内。 / Runtime cursor for an NPC idle sequence; definitions stay cold while scheduler state stays map-local. */
export interface NpcIdleSequenceRuntimeState {
  nextTriggerAtMs: number;
  activeSinceMs: number;
  nextActionIndex: number;
  executionSequence: number;
}

/** NPC交互规则的一次运行时游标；定义保持冷数据，玩家/延迟状态只存在当前地图。 / Runtime cursor for one NPC interaction; definitions stay cold while player and delay state remain map-local. */
export interface NpcInteractionRuntimeState {
  readonly sourceUnitId: number;
  readonly playerUnitId: number;
  readonly rule: Readonly<NpcContentInteractionRule>;
  readonly startedAtMs: number;
  readonly executionSequence: number;
  nextActionIndex: number;
}

/**
 * 地图级NPC索引与交互边界。NPC仍由MapScene的UnitComponent统一拥有，
 * 这里只保存NPC业务索引，不复制一份AOI或玩家状态。
 *
 * Map-level NPC index and interaction boundary. NPCs remain owned by the
 * MapScene UnitComponent; this component stores only NPC business indexes and
 * never duplicates AOI or player state.
 */
@component()
@lifecycle({ awake: true, destroy: true })
export class NpcComponent extends Component<[
  map: MapComponent,
  aoi: MapAoiComponent,
]> {
  protected map!: MapComponent;
  protected aoi!: MapAoiComponent;
  protected readonly npcs = new Map<number, NpcUnit>();
  protected readonly contentSpawns = new Map<number, Readonly<{
    definition: Readonly<NpcContentDefinition>;
    spawn: Readonly<NpcContentSpawn>;
  }>>();
  protected readonly routes = new Map<number, NpcRouteState>();
  protected readonly idleSequenceDefinitions = new Map<number, readonly NpcContentIdleSequence[]>();
  protected readonly idleSequenceStates = new Map<number, Map<number, NpcIdleSequenceRuntimeState>>();
  protected readonly interactionDefinitions = new Map<number, readonly NpcContentInteractionRule[]>();
  protected readonly interactionStates = new Map<number, NpcInteractionRuntimeState[]>();
  protected readonly interactionSequences = new Map<number, number>();
  protected readonly combatStates = new Map<number, NpcCombatRuntimeState>();
  protected readonly pendingRespawns = new Map<number, number>();
  /** 每个内容刷点成功创建的代数；失败创建不得消耗下一代等级。 / Successful creation generation per content spawn; failed creation must not consume the next level. */
  protected readonly spawnGenerations = new Map<number, number>();
  protected readonly definitionContentPatches = new Map<number, Map<string, Readonly<NpcRuntimeContentPatch>>>();
  protected readonly spawnContentPatches = new Map<number, Map<string, Readonly<NpcRuntimeContentPatch>>>();
}
