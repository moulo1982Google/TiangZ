import {
  Component,
  UnitComponent,
  component,
  lifecycle,
  type Unit,
} from "../../../core/public";
import type { AoiVisibilityDelta, MapAoiComponent } from "../map/MapAoiComponent";
import type { MapComponent } from "../map/MapComponent";
import type { PlayerUnit } from "../map/PlayerUnit";
import type { DamageSchoolValue } from "../combat/CombatComponent";
import type { MonsterUnit } from "../monster/MonsterUnit";
import type { NpcUnit } from "../npc/NpcUnit";
import type { SummonedUnit } from "./SummonedUnit";

/** 可拥有临时召唤Unit的中立地图实体。 / Neutral map entities that may own a temporary summoned Unit. */
export type SummonOwnerUnit = PlayerUnit | MonsterUnit | NpcUnit;

/**
 * 归属 Unit 的协议无关反应姿态；具体客户端枚举由外部适配器转换。
 * Protocol-neutral owned-Unit reaction modes; external adapters translate client enums.
 */
export const OwnedUnitReaction = {
  Passive: 1,
  Defensive: 2,
  Aggressive: 3,
} as const;

export type OwnedUnitReactionValue = typeof OwnedUnitReaction[keyof typeof OwnedUnitReaction];

/** 归属Unit可执行能力的中立目录项；技能规则仍由公共SkillDefinition目录提供。 / Neutral catalog entry for an owned-Unit ability; the shared SkillDefinition catalog still owns cast rules. */
export interface OwnedUnitAbilityDefinition {
  readonly abilityId: number;
  readonly autoCastByDefault: boolean;
}

/** 模块提交给中立召唤运行时的冻结数值；不得包含来源数据库对象。 / Frozen values supplied by a module to the neutral summon runtime; source-database objects are forbidden. */
export interface OwnedSummonDefinition {
  readonly id: number;
  readonly name: string;
  readonly modelId: string;
  readonly maxHp: number;
  readonly maxMp: number;
  readonly attackDamage: number;
  readonly moveSpeed: number;
  readonly attackRange: number;
  readonly attackIntervalMs: number;
  readonly attackDamageSchool: DamageSchoolValue;
  readonly attackAbilityId: number;
  readonly followDistance: number;
  readonly teleportDistance: number;
  readonly assistOwner: boolean;
  readonly initialReaction: OwnedUnitReactionValue;
  readonly aggressiveAcquireRange: number;
  readonly abilities: readonly OwnedUnitAbilityDefinition[];
  /** 可选的主资源脉冲恢复；具体数值由外置模块配置。 / Optional primary-resource pulse regeneration configured by an external module. */
  readonly resourceRegenAmount?: number;
  readonly resourceRegenIntervalMs?: number;
  readonly resourceRegenDelayAfterSpendMs?: number;
}

export interface SummonOwnedUnitRequest {
  /** 同一所有者和槽位只能有一个Unit；新召唤原子替换旧Unit。 / One Unit may occupy an owner slot; a new summon replaces the old Unit. */
  readonly ownershipSlot: number;
  readonly createdByAbilityId: number;
  readonly definition: Readonly<OwnedSummonDefinition>;
  readonly reaction?: OwnedUnitReactionValue;
  readonly autoCastAbilityIds?: readonly number[];
}

/**
 * 跨地图迁移时可携带的召唤物意图；只包含冻结值，不包含Unit、Native handle或地图运行态。
 * Transfer-safe owned-summon intent. It contains frozen values only; runtime
 * Units, Native handles, targets, and map-local state never cross a map.
 */
export interface OwnedSummonTransferState {
  readonly ownershipSlot: number;
  readonly createdByAbilityId: number;
  readonly definition: Readonly<OwnedSummonDefinition>;
  readonly reaction: OwnedUnitReactionValue;
  readonly autoCastAbilityIds: readonly number[];
}

export interface SummonRuntimeState {
  readonly summon: SummonedUnit;
  readonly ownerUnitId: number;
  readonly ownershipSlot: number;
  readonly definition: Readonly<OwnedSummonDefinition>;
  targetMonsterUnitId: number;
  nextThinkAtMs: number;
  nextAttackAtMs: number;
  navigationSequence: number;
  followOwner: boolean;
  reaction: OwnedUnitReactionValue;
  readonly autoCastAbilityIds: Set<number>;
}

/** 当前控制面快照；用于 AOI/协议适配器恢复 UI，不暴露地图内 AI 状态。 / Current control-plane snapshot for AOI adapters; map-local AI state remains private. */
export interface OwnedUnitControlState {
  readonly reaction: OwnedUnitReactionValue;
  readonly autoCastAbilityIds: readonly number[];
}

/**
 * 归属临时 Unit 接受的协议无关指令。
 * Protocol-neutral commands accepted by an owned temporary Unit.
 */
export const OwnedUnitCommand = {
  Follow: 1,
  Stay: 2,
  Attack: 3,
  Dismiss: 4,
  SetPassive: 5,
  SetDefensive: 6,
  SetAggressive: 7,
  CastAbility: 8,
  EnableAbilityAutoCast: 9,
  DisableAbilityAutoCast: 10,
} as const;

export type OwnedUnitCommandValue = typeof OwnedUnitCommand[keyof typeof OwnedUnitCommand];

export interface SummonComponent {
  SummonOwnedUnit(owner: SummonOwnerUnit, request: SummonOwnedUnitRequest): SummonedUnit;
  CaptureOwnedState(owner: PlayerUnit): readonly OwnedSummonTransferState[];
  /** 目标Owner的槽位必须为空；任何一项创建失败都会撤销本批已经创建的Unit。 / Target owner slots must be empty; a failure in any item rolls back every Unit created by this batch. */
  RestoreOwnedState(
    owner: PlayerUnit,
    states: readonly OwnedSummonTransferState[],
  ): readonly SummonedUnit[];
  DismissOwnedUnit(owner: SummonOwnerUnit, ownershipSlot: number): boolean;
  GetOwnedUnit(owner: SummonOwnerUnit, ownershipSlot: number): SummonedUnit | undefined;
  Get(summonUnitId: number): SummonedUnit | undefined;
  GetAll(): readonly SummonedUnit[];
  GetControlState(summonUnitId: number): OwnedUnitControlState | undefined;
  CommandOwnedUnit(
    owner: PlayerUnit,
    summonUnitId: number,
    command: OwnedUnitCommandValue,
    targetUnitId: number,
    abilityId?: number,
  ): boolean;
  AssistOwnerAgainst(owner: PlayerUnit, target: MonsterUnit): void;
  /** Map移除玩家时合并其召唤物的AOI Leave；调用方负责统一广播。 / Merges summon AOI leaves when Map removes an owner; the caller publishes the combined batch. */
  OwnerLeaving(owner: SummonOwnerUnit): readonly AoiVisibilityDelta[];
}

/**
 * 地图级中立召唤物所有者：维护所有权槽、Unit生命周期、跟随和可选协战。
 * Map-level neutral summon owner for ownership slots, Unit lifecycle, follow,
 * and optional owner-assist behavior.
 */
@component()
@lifecycle({ awake: true, destroy: true })
export class SummonComponent extends Component<[
  map: MapComponent,
  aoi: MapAoiComponent,
]> {
  protected map!: MapComponent;
  protected aoi!: MapAoiComponent;
  protected units!: UnitComponent;
  protected readonly summons = new Map<number, SummonedUnit>();
  protected readonly runtime = new Map<number, SummonRuntimeState>();
  protected readonly summonUnitIdByOwnerSlot = new Map<string, number>();
  protected nextSummonUnitId = 0xa000_0000;

  protected RequireMapUnit(unit: Unit<any[]>): void {
    if (unit.DomainScene() !== this.DomainScene()) {
      throw new Error(`summon unit ${unit.UnitId} belongs to another map`);
    }
  }
}
