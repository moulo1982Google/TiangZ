import { Component, component } from "../../../core/public";
import {
  FreezeContentCombatLevelStats,
  type ContentCombatLevelStats,
} from "../combat/ContentCombatLevelStats";

/**
 * 可选的中立 NPC 战斗资料；只有内容明确声明时，服务 NPC 才进入可攻击、仇恨和重生生命周期。
 * Optional neutral NPC combat data. A service NPC enters attack, threat, and
 * respawn lifecycles only when its content explicitly declares this profile.
 */
export interface NpcCombatProfile {
  readonly maxHp: number;
  readonly maxMp: number;
  readonly attackDamage: number;
  readonly moveSpeed: number;
  readonly attackRange: number;
  readonly attackIntervalMs: number;
  /** 可选完整逐级战斗数值；来源公式必须在模块构建期完成。 / Optional complete per-level combat stats projected by the source module at build time. */
  readonly combatStatsByLevel?: readonly ContentCombatLevelStats[];
  readonly acquireRangeMeters: number;
  readonly leashRangeMeters: number;
  /** 内容驱动战斗单位使用的可选中立主资源恢复参数。 / Optional neutral primary-resource regeneration used by content-driven combatants. */
  readonly resourceRegenAmount?: number;
  readonly resourceRegenIntervalMs?: number;
  readonly resourceRegenDelayAfterSpendMs?: number;
  /** 玩家模板资格由所属内容包计算；空数组表示本地图玩家均不可攻击。 / The owning content pack computes player-template eligibility; an empty list denies every local player. */
  readonly attackablePlayerConfigIds: readonly number[];
  /** 主动索敌资格必须是可攻击资格的子集。 / Active-acquisition eligibility must be a subset of attackable eligibility. */
  readonly aggressivePlayerConfigIds: readonly number[];
  /** 由所属内容模块投影的通用战斗规则。 / Generic combat rules projected by the owning content module. */
  readonly behaviorRules?: readonly NpcCombatBehaviorRule[];
}

/** 由 NPC 运行时求值的来源中立战斗事实。 / Source-neutral combat facts evaluated by the NPC runtime. */
export const NpcCombatBehaviorTrigger = {
  Reset: 1,
  Engage: 2,
  CombatInterval: 3,
  HealthRange: 4,
  ResourceRange: 5,
  TargetDistanceRange: 6,
} as const;

export type NpcCombatBehaviorTriggerValue =
  (typeof NpcCombatBehaviorTrigger)[keyof typeof NpcCombatBehaviorTrigger];

/** 来源中立动作；不透明能力仍归游戏模块所有。 / Source-neutral actions; opaque abilities remain owned by the game module. */
export const NpcCombatBehaviorActionType = {
  ExecuteAbility: 1,
  SetCombatMovement: 2,
  SetState: 3,
  ChangeState: 4,
  Flee: 5,
} as const;

export type NpcCombatBehaviorActionTypeValue =
  (typeof NpcCombatBehaviorActionType)[keyof typeof NpcCombatBehaviorActionType];

export const NpcCombatBehaviorTarget = {
  Self: 1,
  CombatTarget: 2,
} as const;

export type NpcCombatBehaviorTargetValue =
  (typeof NpcCombatBehaviorTarget)[keyof typeof NpcCombatBehaviorTarget];

export interface NpcCombatBehaviorAction {
  readonly type: NpcCombatBehaviorActionTypeValue;
  readonly target: NpcCombatBehaviorTargetValue;
  readonly abilityId?: number;
  readonly enabled?: boolean;
  readonly state?: number;
  readonly stateDelta?: number;
  readonly fleeDistanceMeters?: number;
}

/**
 * 小型确定性战斗状态规则；来源引擎的事件/动作编号由模块转换，绝不进入此契约。
 * A small deterministic combat-state rule. Source engine event/action numbers
 * are converted by modules and never enter this contract.
 */
export interface NpcCombatBehaviorRule {
  readonly id: number;
  readonly trigger: NpcCombatBehaviorTriggerValue;
  readonly chancePermille: number;
  /** 零表示允许所有行为状态，否则第 N 位允许状态 N。 / Zero means every behavior state; otherwise bit N admits state N. */
  readonly requiredStateMask?: number;
  readonly oncePerEngagement?: boolean;
  readonly minValuePermille?: number;
  readonly maxValuePermille?: number;
  readonly minDistanceMeters?: number;
  readonly maxDistanceMeters?: number;
  readonly initialDelayMinMs?: number;
  readonly initialDelayMaxMs?: number;
  readonly repeatDelayMinMs?: number;
  readonly repeatDelayMaxMs?: number;
  readonly actions: readonly NpcCombatBehaviorAction[];
}

/** 模块拥有、由现有地图NPC运行时消费的中立NPC资料。 / A module-owned neutral NPC definition consumed by the existing map NPC runtime. */
export interface NpcContentDefinition {
  readonly id: number;
  readonly name: string;
  /** Optional inclusive content level range; both bounds must be present together. / 可选内容等级闭区间；上下界必须成对提供。 */
  readonly minimumLevel?: number;
  readonly maximumLevel?: number;
  /**
   * Optional neutral presentation identifiers selected by the owning content
   * package.  TiangZ stores these values but never interprets a source-game
   * display or equipment table.
   *
   * 由内容包选择的可选中立外观编号。TiangZ 只保存字符串，不解释来源游戏的模型或装备表。
   */
  readonly presentationModelId?: string;
  readonly presentationLoadoutId?: string;
  /** Optional persistent presentation state; the owning adapter gives the value its meaning. / 可选持久表现状态，具体含义由所属适配器负责。 */
  readonly presentationStateId?: number;
  /** Content-declared buffs applied when a fresh NPC instance is spawned. / 内容声明的NPC初始Buff；每次新刷出时应用。 */
  readonly initialBuffDefinitionIds?: readonly number[];
  readonly questStarterConfigIds: readonly number[];
  readonly questEnderConfigIds: readonly number[];
  readonly shopItemConfigIds: readonly number[];
  readonly trainerId: number;
  readonly shopEnabled: boolean;
  readonly repairEnabled?: boolean;
  /** 是否提供普通会话入口；具体菜单和协议由外置适配器拥有。 / Whether a generic conversation entry is exposed; external adapters own menus and protocol details. */
  readonly conversationEnabled?: boolean;
  /** 是否公开已有训练资料；trainerId 仍决定具体训练目录。 / Whether the existing trainer profile is exposed; trainerId still selects the actual catalog. */
  readonly trainingEnabled?: boolean;
  /** 是否提供死亡恢复服务；复活规则仍由独立领域组件负责。 / Whether a death-recovery service is exposed; independent domain components still own revival rules. */
  readonly recoveryEnabled?: boolean;
  /** 可选中立战斗资料；省略时该 NPC 永远保持纯服务实体。 / Optional neutral combat data; omission keeps this NPC service-only. */
  readonly combatProfile?: NpcCombatProfile;
}

/**
 * 低频内容状态的可逆增量。数组与服务开关只做并集；外观和装束同一时刻只能有一个不同覆盖值。
 * Reversible low-frequency content delta. Arrays and service switches are additive, while appearance and loadout allow only one distinct active override.
 */
export interface NpcRuntimeContentPatch {
  readonly questStarterConfigIds?: readonly number[];
  readonly questEnderConfigIds?: readonly number[];
  readonly shopItemConfigIds?: readonly number[];
  readonly questEnabled?: boolean;
  readonly conversationEnabled?: boolean;
  readonly shopEnabled?: boolean;
  readonly trainingEnabled?: boolean;
  readonly repairEnabled?: boolean;
  readonly recoveryEnabled?: boolean;
  readonly presentationModelId?: string;
  readonly presentationLoadoutId?: string;
  /** 外置适配器解释的命名空间能力键；Core 只做去重、快照和回滚。 / Namespaced capability keys interpreted by external adapters; Core only deduplicates, snapshots, and rolls them back. */
  readonly extensionCapabilities?: readonly string[];
}

/** 在进入运行时状态前规范化并冻结内容增量。 / Normalizes and freezes a content delta before it enters runtime state. */
export function NormalizeNpcRuntimeContentPatch(
  patch: NpcRuntimeContentPatch,
): Readonly<NpcRuntimeContentPatch> {
  if (!patch || typeof patch !== "object") throw new Error("NPC runtime content patch must be an object");
  const result: NpcRuntimeContentPatch = {
    questStarterConfigIds: freezeRuntimePositiveIds(patch.questStarterConfigIds ?? [], "quest starter"),
    questEnderConfigIds: freezeRuntimePositiveIds(patch.questEnderConfigIds ?? [], "quest ender"),
    shopItemConfigIds: freezeRuntimePositiveIds(patch.shopItemConfigIds ?? [], "shop item"),
    extensionCapabilities: freezeRuntimeCapabilities(patch.extensionCapabilities ?? []),
  };
  for (const key of [
    "questEnabled",
    "conversationEnabled",
    "shopEnabled",
    "trainingEnabled",
    "repairEnabled",
    "recoveryEnabled",
  ] as const) {
    const value = patch[key];
    if (value !== undefined && value !== true) {
      throw new Error(`NPC runtime content patch ${key} must be true when present`);
    }
    if (value) Object.assign(result, { [key]: true });
  }
  for (const key of ["presentationModelId", "presentationLoadoutId"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    const normalized = value.trim();
    if (!normalized || normalized.length > 128) {
      throw new Error(`NPC runtime content patch ${key} must be 1..128 characters`);
    }
    Object.assign(result, { [key]: normalized });
  }
  return Object.freeze(result);
}

/** 稳定NPC刷点；运行实体ID由刷点ID提供，资料包不拥有Unit生命周期。 / A stable NPC slot whose ID supplies the runtime entity identity without owning its Unit lifecycle. */
export interface NpcContentSpawn {
  readonly id: number;
  readonly npcDefinitionId: number;
  /** Optional spawn-specific neutral loadout; the content adapter owns its meaning. / 可选的刷点级中立装束编号，具体含义由内容适配器负责。 */
  readonly presentationLoadoutId?: string;
  /** Optional spawn override; zero explicitly clears the template state. / 可选刷点覆盖；零表示显式清除模板状态。 */
  readonly presentationStateId?: number;
  /** Optional spawn override; an empty list explicitly clears template buffs. / 可选刷点覆盖；空数组显式清除模板Buff。 */
  readonly initialBuffDefinitionIds?: readonly number[];
  readonly spawnX: number;
  readonly spawnY: number;
  readonly spawnZ: number;
  readonly spawnYaw: number;
  readonly initialSpawn: boolean;
  /** 战斗 NPC 死亡后的刷点重生时间；纯服务 NPC 也保留该数据但不会触发生命周期。 / Slot respawn delay after a combat NPC dies; service-only NPCs retain the data without entering combat lifecycle. */
  readonly respawnSeconds?: number;
  /** 刷点规则存在时替换定义级战斗规则，空列表会显式清除继承。 / Spawn rules replace definition-level combat rules when present; an empty list clears inheritance. */
  readonly combatBehaviorRules?: readonly NpcCombatBehaviorRule[];
  /**
   * 可选的、以中立地图坐标表示的循环路线；内容适配器负责源路径语义。
   * Optional repeating route in neutral map coordinates.  The content
   * adapter owns source path semantics; Core only consumes validated points.
   */
  readonly waypoints?: readonly NpcContentWaypoint[];
  /** 由内容包声明的交互触发规则；触发器和值保持协议中立，来源游戏的事件编号只存在于适配器。 / Content-declared interaction rules; trigger kinds and values are protocol-neutral, while source-game event IDs stay in the adapter. */
  readonly interactionRules?: readonly NpcContentInteractionRule[];
  /** 脱战时执行的刷点级定时表现序列；源SmartAI事件由适配器映射。 / Spawn-level timed presentation sequences; source SmartAI events are mapped by the adapter. */
  readonly idleSequences?: readonly NpcContentIdleSequence[];
}

/** 协议中立的 NPC 路线点；源 waypoint/action 枚举留在适配器中。 A protocol-neutral NPC route point; source waypoint/action enums stay in the adapter. */
export interface NpcContentWaypoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw?: number;
  readonly delayMs: number;
  readonly moveSpeed?: number;
}

/** NPC脱战序列支持的中立瞬时动作。 / Neutral transient actions supported by NPC out-of-combat sequences. */
/** NPC交互触发器只描述通用领域事实；具体协议/游戏的编号由适配器映射。 / NPC interaction triggers describe generic domain facts; protocol/game-specific numbers are mapped by adapters. */
export const NpcContentInteractionTrigger = {
  QuestAccepted: 1,
  QuestRewarded: 2,
  GossipSelected: 3,
} as const;

export type NpcContentInteractionTriggerValue =
  (typeof NpcContentInteractionTrigger)[keyof typeof NpcContentInteractionTrigger];

/** NPC交互动作只描述中立表现或不透明能力请求；权威数值结算仍由对应领域组件/外置模块负责。 / Interaction actions describe neutral presentation or opaque ability requests; authoritative effects remain in domain components or external modules. */
export const NpcContentInteractionActionType = {
  Emote: 1,
  Say: 2,
  /** 请求所属游戏模块执行不透明能力编号。 / Ask the owning game module to execute an opaque ability identifier. */
  ExecuteAbility: 3,
} as const;

export type NpcContentInteractionActionTypeValue =
  (typeof NpcContentInteractionActionType)[keyof typeof NpcContentInteractionActionType];

/** 交互动作的目标用于确定客户端表现的可选目标玩家；动作来源始终是触发NPC。 / Action targets select an optional player audience; the triggering NPC remains the presentation source. */
export const NpcContentInteractionActionTarget = {
  Self: 1,
  Player: 2,
} as const;

export type NpcContentInteractionActionTargetValue =
  (typeof NpcContentInteractionActionTarget)[keyof typeof NpcContentInteractionActionTarget];

export interface NpcContentInteractionAction {
  readonly id: number;
  readonly type: NpcContentInteractionActionTypeValue;
  readonly target: NpcContentInteractionActionTargetValue;
  readonly delayMs: number;
  readonly delayMaxMs?: number;
  readonly chancePermille: number;
  /** 外置模块拥有的不透明能力编号；模块负责协议/法术表现。 / One opaque module-owned ability identifier; the game module owns its protocol/spell presentation. */
  readonly abilityId?: number;
  /** 单个表情编号；与presentationIds二选一。 / One emote identifier; mutually exclusive with presentationIds. */
  readonly presentationId?: number;
  /** 有序表情候选；重复值可保留来源权重。 / Ordered emote candidates; duplicate values preserve source weighting. */
  readonly presentationIds?: readonly number[];
  /** 说话文本候选；适配器负责本地化和占位符替换。 / Speech candidates; adapters own localization and placeholder substitution. */
  readonly textChoices?: readonly string[];
}

export interface NpcContentInteractionRule {
  readonly id: number;
  readonly trigger: NpcContentInteractionTriggerValue;
  /** 触发器的中立配置值；0表示匹配全部值。 / Neutral trigger value; zero matches every value. */
  readonly triggerValue?: number;
  readonly chancePermille: number;
  readonly actions: readonly NpcContentInteractionAction[];
}

export const NpcContentIdleActionType = {
  Emote: 1,
  /** 璇锋眰妯″潡鎵ц涓€涓笉閫忔槑鑳藉姏锛涘崗璁疄鐜颁繚鐣欏湪妯″潡涓€?/ Ask the owning module to execute an opaque ability request. */
  ExecuteAbility: 2,
  /** NPC 绌洪棽璇濇湰鎴栧箍鎾枃鏈紱涓嶈В閲婁换浣曟父鎴忓崗璁€?/ Idle speech text; the adapter owns the client chat opcode and localization. */
  Say: 3,
  /** 持续的中立动画状态；零表示清除。 / Persistent neutral animation state; zero clears the state. */
  EmoteState: 4,
} as const;

export type NpcContentIdleActionTypeValue =
  (typeof NpcContentIdleActionType)[keyof typeof NpcContentIdleActionType];

/** 空闲动作可作用于自身或同一内容所有者的稳定刷点。 / An idle action targets self or a stable spawn owned by the same content package. */
export const NpcContentIdleActionTarget = {
  Self: 1,
  StableSpawn: 2,
} as const;

export type NpcContentIdleActionTargetValue =
  (typeof NpcContentIdleActionTarget)[keyof typeof NpcContentIdleActionTarget];

export interface NpcContentIdleAction {
  readonly id: number;
  readonly type: NpcContentIdleActionTypeValue;
  readonly target: NpcContentIdleActionTargetValue;
  /** StableSpawn目标使用的模块刷点编号。 / Module spawn identifier used by a StableSpawn target. */
  readonly targetSpawnId?: number;
  /** 相对于本轮空闲序列触发时刻的延迟。 / Delay relative to this idle-sequence execution. */
  readonly delayMs: number;
  /** 可选延迟上界；用于表达源数据的确定性范围选择。 / Optional delay upper bound for source ranges selected deterministically. */
  readonly delayMaxMs?: number;
  readonly chancePermille: number;
  /** 澶栫疆妯″潡鎷ユ湁鐨勪笉閫忔槑鑳藉姟缂栧彿锛涙湇鍔℃牴鎹湇鍔″疄鐜拌В閲婂崗璁€?/ Opaque module-owned ability identifier; the adapter decides the actual protocol effect. */
  readonly abilityId?: number;
  /** 单个表现编号；与presentationIds二选一。 / Single presentation ID; mutually exclusive with presentationIds. */
  readonly presentationId?: number;
  /** 按源内容顺序保留的表现候选；重复值可表达源数据的权重。 / Ordered presentation candidates; duplicate values preserve source weighting. */
  readonly presentationIds?: readonly number[];
  /** 绌洪棽璇濇湰鍊欓€夛紱閫傞厤鍣ㄨ礋璐ｆ湰鍦板寲鍜屽崰浣嶇鏇挎崲銆?/ Speech candidates; adapters own localization and placeholder substitution. */
  readonly textChoices?: readonly string[];
}

/** 仅在NPC脱战时推进的可重复表现序列。 / Repeatable presentation sequence advanced only while an NPC is out of combat. */
export interface NpcContentIdleSequence {
  readonly id: number;
  readonly chancePermille: number;
  readonly initialDelayMinMs: number;
  readonly initialDelayMaxMs: number;
  readonly repeatDelayMinMs: number;
  readonly repeatDelayMaxMs: number;
  readonly actions: readonly NpcContentIdleAction[];
}

export interface NpcContentRegistration {
  readonly definitions: readonly NpcContentDefinition[];
  readonly spawns: readonly NpcContentSpawn[];
}

/**
 * 地图工厂与外置内容包之间的中立NPC目录。模块在MapScene发布前原子登记资料并冻结，
 * NpcComponent继续拥有Unit、AOI和交互校验；目录不认识任何外部数据库或具体游戏协议。
 *
 * Neutral NPC catalog between map creation and external content packages.
 * Modules register definitions atomically before MapScene publication, while
 * NpcComponent retains Unit, AOI, and interaction ownership. The catalog knows
 * neither external database schemas nor game-specific protocols.
 */
@component()
export class NpcContentProfileComponent extends Component {
  private readonly definitions = new Map<number, Readonly<NpcContentDefinition>>();
  private readonly definitionOwners = new Map<number, string>();
  private readonly spawns = new Map<number, Readonly<NpcContentSpawn>>();
  private readonly spawnOwners = new Map<number, string>();
  private coldContentReplacementOwner = "";
  private sealed = false;

  get DefinitionCount(): number {
    return this.definitions.size;
  }

  get SpawnCount(): number {
    return this.spawns.size;
  }

  get IncludesColdContent(): boolean {
    return this.coldContentReplacementOwner.length === 0;
  }

  /** 声明完整外置内容包替换演示NPC；第二个所有者会被拒绝。 / Claims replacement of demo NPCs for one complete external content package. */
  ReplaceColdContent(ownerId: string): void {
    if (this.sealed) throw new Error("npc content profile is sealed");
    const owner = requireOwnerId(ownerId);
    if (this.coldContentReplacementOwner) {
      throw new Error(
        `cold NPC content already belongs to ${this.coldContentReplacementOwner}`,
      );
    }
    this.coldContentReplacementOwner = owner;
  }

  /** 完整校验后一次发布定义和刷点，失败时不会留下部分目录。 / Validates and publishes definitions and slots atomically. */
  Register(ownerId: string, registration: NpcContentRegistration): void {
    if (this.sealed) throw new Error("npc content profile is sealed");
    const owner = requireOwnerId(ownerId);
    if (!registration || typeof registration !== "object") {
      throw new Error("npc content registration must be an object");
    }
    if (!Array.isArray(registration.definitions) || !Array.isArray(registration.spawns)) {
      throw new Error("npc content registration requires definition and spawn arrays");
    }

    const pendingDefinitions = new Map<number, Readonly<NpcContentDefinition>>();
    for (const definition of registration.definitions) {
      const frozen = freezeDefinition(definition);
      if (this.definitions.has(frozen.id) || pendingDefinitions.has(frozen.id)) {
        const previousOwner = this.definitionOwners.get(frozen.id) ?? owner;
        throw new Error(`NPC definition ${frozen.id} already belongs to ${previousOwner}`);
      }
      pendingDefinitions.set(frozen.id, frozen);
    }

    const pendingSpawns = new Map<number, Readonly<NpcContentSpawn>>();
    for (const spawn of registration.spawns) {
      const frozen = freezeSpawn(spawn);
      if (this.spawns.has(frozen.id) || pendingSpawns.has(frozen.id)) {
        const previousOwner = this.spawnOwners.get(frozen.id) ?? owner;
        throw new Error(`NPC spawn ${frozen.id} already belongs to ${previousOwner}`);
      }
      const definitionOwner = this.definitionOwners.get(frozen.npcDefinitionId);
      if (definitionOwner && definitionOwner !== owner) {
        throw new Error(
          `NPC spawn ${frozen.id} cannot reference definition ${frozen.npcDefinitionId} owned by ${definitionOwner}`,
        );
      }
      if (!pendingDefinitions.has(frozen.npcDefinitionId) && definitionOwner !== owner) {
        throw new Error(
          `NPC spawn ${frozen.id} references missing definition ${frozen.npcDefinitionId}`,
        );
      }
      pendingSpawns.set(frozen.id, frozen);
    }

    for (const spawn of pendingSpawns.values()) {
      for (const sequence of spawn.idleSequences ?? []) {
        for (const action of sequence.actions) {
          if (action.target !== NpcContentIdleActionTarget.StableSpawn) continue;
          const targetSpawnId = action.targetSpawnId ?? 0;
          const targetOwner = this.spawnOwners.get(targetSpawnId);
          if (!pendingSpawns.has(targetSpawnId) && targetOwner !== owner) {
            throw new Error(
              `NPC spawn ${spawn.id} idle action ${action.id} references missing or foreign spawn ${targetSpawnId}`,
            );
          }
        }
      }
    }

    for (const [id, definition] of pendingDefinitions) {
      this.definitions.set(id, definition);
      this.definitionOwners.set(id, owner);
    }
    for (const [id, spawn] of pendingSpawns) {
      this.spawns.set(id, spawn);
      this.spawnOwners.set(id, owner);
    }
  }

  Seal(): void {
    this.sealed = true;
  }

  TryGetDefinition(id: number): Readonly<NpcContentDefinition> | undefined {
    return this.definitions.get(id);
  }

  GetDefinitions(): readonly Readonly<NpcContentDefinition>[] {
    return Object.freeze([...this.definitions.values()].sort((left, right) => left.id - right.id));
  }

  GetSpawns(): readonly Readonly<NpcContentSpawn>[] {
    return Object.freeze([...this.spawns.values()].sort((left, right) => left.id - right.id));
  }

  DefinitionOwnerOf(id: number): string | undefined {
    return this.definitionOwners.get(id);
  }

  SpawnOwnerOf(id: number): string | undefined {
    return this.spawnOwners.get(id);
  }

  get ColdContentReplacementOwner(): string | undefined {
    return this.coldContentReplacementOwner || undefined;
  }
}

function freezeDefinition(definition: NpcContentDefinition): Readonly<NpcContentDefinition> {
  if (!definition || typeof definition !== "object") {
    throw new Error("NPC definition must be an object");
  }
  requirePositiveInteger(definition.id, "NPC definition id");
  const name = definition.name?.trim();
  if (!name) throw new Error(`NPC definition ${definition.id} name must not be empty`);
  if ((definition.minimumLevel === undefined) !== (definition.maximumLevel === undefined)) {
    throw new Error(`NPC definition ${definition.id} level bounds must be provided together`);
  }
  if (definition.minimumLevel !== undefined && definition.maximumLevel !== undefined) {
    requirePositiveInteger(definition.minimumLevel, `NPC definition ${definition.id} minimum level`);
    requirePositiveInteger(definition.maximumLevel, `NPC definition ${definition.id} maximum level`);
    if (definition.minimumLevel > definition.maximumLevel) {
      throw new Error(`NPC definition ${definition.id} minimum level must not exceed maximum level`);
    }
  }
  const presentationModelId = normalizeOptionalPresentationId(
    definition.presentationModelId,
    definition.id,
    "model",
  );
  const presentationLoadoutId = normalizeOptionalPresentationId(
    definition.presentationLoadoutId,
    definition.id,
    "loadout",
  );
  const presentationStateId = normalizeOptionalPresentationStateId(
    definition.presentationStateId,
    definition.id,
  );
  const initialBuffDefinitionIds = freezeBuffDefinitionIds(
    definition.initialBuffDefinitionIds,
    definition.id,
  );
  const questStarterConfigIds = freezeQuestConfigIds(
    definition.questStarterConfigIds,
    definition.id,
    "starter",
  );
  const questEnderConfigIds = freezeQuestConfigIds(
    definition.questEnderConfigIds,
    definition.id,
    "ender",
  );
  const shopItemConfigIds = freezePositiveIds(
    definition.shopItemConfigIds,
    definition.id,
    "shop item config",
  );
  requireNonNegativeInteger(definition.trainerId, `NPC definition ${definition.id} trainer id`);
  if (typeof definition.shopEnabled !== "boolean") {
    throw new Error(`NPC definition ${definition.id} shopEnabled must be boolean`);
  }
  const repairEnabled = definition.repairEnabled ?? false;
  if (typeof repairEnabled !== "boolean") {
    throw new Error(`NPC definition ${definition.id} repairEnabled must be boolean`);
  }
  const conversationEnabled = definition.conversationEnabled ?? false;
  const trainingEnabled = definition.trainingEnabled ?? definition.trainerId > 0;
  const recoveryEnabled = definition.recoveryEnabled ?? false;
  const combatProfile = freezeCombatProfile(
    definition.id,
    definition.combatProfile,
    definition.minimumLevel,
    definition.maximumLevel,
  );
  for (const [label, value] of [
    ["conversationEnabled", conversationEnabled],
    ["trainingEnabled", trainingEnabled],
    ["recoveryEnabled", recoveryEnabled],
  ] as const) {
    if (typeof value !== "boolean") {
      throw new Error(`NPC definition ${definition.id} ${label} must be boolean`);
    }
  }
  if (trainingEnabled && definition.trainerId <= 0) {
    throw new Error(`NPC definition ${definition.id} cannot enable training without trainerId`);
  }
  return Object.freeze({
    id: definition.id,
    name,
    ...(definition.minimumLevel === undefined ? {} : {
      minimumLevel: definition.minimumLevel,
      maximumLevel: definition.maximumLevel,
    }),
    ...(presentationModelId === undefined ? {} : { presentationModelId }),
    ...(presentationLoadoutId === undefined ? {} : { presentationLoadoutId }),
    ...(presentationStateId === undefined ? {} : { presentationStateId }),
    ...(initialBuffDefinitionIds === undefined ? {} : { initialBuffDefinitionIds }),
    questStarterConfigIds,
    questEnderConfigIds,
    shopItemConfigIds,
    trainerId: definition.trainerId,
    shopEnabled: definition.shopEnabled,
    repairEnabled,
    conversationEnabled,
    trainingEnabled,
    recoveryEnabled,
    ...(combatProfile === undefined ? {} : { combatProfile }),
  });
}

function freezeCombatProfile(
  definitionId: number,
  profile: NpcCombatProfile | undefined,
  minimumLevel: number | undefined,
  maximumLevel: number | undefined,
): Readonly<NpcCombatProfile> | undefined {
  if (profile === undefined) return undefined;
  if (!profile || typeof profile !== "object") {
    throw new Error(`NPC definition ${definitionId} combat profile must be an object`);
  }
  for (const [label, value] of [
    ["maxHp", profile.maxHp],
    ["maxMp", profile.maxMp],
    ["attackDamage", profile.attackDamage],
    ["attackIntervalMs", profile.attackIntervalMs],
  ] as const) {
    requireNonNegativeInteger(value, `NPC definition ${definitionId} combat ${label}`);
  }
  if (profile.maxHp <= 0 || profile.attackDamage <= 0 || profile.attackIntervalMs <= 0) {
    throw new Error(`NPC definition ${definitionId} combat HP, damage, and attack interval must be positive`);
  }
  for (const [label, value] of [
    ["moveSpeed", profile.moveSpeed],
    ["attackRange", profile.attackRange],
    ["acquireRangeMeters", profile.acquireRangeMeters],
    ["leashRangeMeters", profile.leashRangeMeters],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`NPC definition ${definitionId} combat ${label} must be positive and finite`);
    }
  }
  if (profile.leashRangeMeters < profile.attackRange) {
    throw new Error(`NPC definition ${definitionId} combat leash range cannot be below attack range`);
  }
  const resourceRegenAmount = profile.resourceRegenAmount ?? 0;
  const resourceRegenIntervalMs = profile.resourceRegenIntervalMs ?? 0;
  const resourceRegenDelayAfterSpendMs = profile.resourceRegenDelayAfterSpendMs ?? 0;
  for (const [label, value] of [
    ["resourceRegenAmount", resourceRegenAmount],
    ["resourceRegenIntervalMs", resourceRegenIntervalMs],
    ["resourceRegenDelayAfterSpendMs", resourceRegenDelayAfterSpendMs],
  ] as const) {
    requireNonNegativeInteger(value, `NPC definition ${definitionId} combat ${label}`);
  }
  const hasResourceRegen = resourceRegenAmount > 0
    || resourceRegenIntervalMs > 0
    || resourceRegenDelayAfterSpendMs > 0;
  if (hasResourceRegen && (
    profile.maxMp <= 0 || resourceRegenAmount <= 0 || resourceRegenIntervalMs <= 0
  )) {
    throw new Error(
      `NPC definition ${definitionId} combat resource regeneration requires maxMp, amount, and interval`,
    );
  }
  const attackablePlayerConfigIds = freezePositiveIds(
    profile.attackablePlayerConfigIds,
    definitionId,
    "combat attackable player config",
  );
  const aggressivePlayerConfigIds = freezePositiveIds(
    profile.aggressivePlayerConfigIds,
    definitionId,
    "combat aggressive player config",
  );
  const attackable = new Set(attackablePlayerConfigIds);
  for (const playerConfigId of aggressivePlayerConfigIds) {
    if (!attackable.has(playerConfigId)) {
      throw new Error(
        `NPC definition ${definitionId} aggressive player config ${playerConfigId} is not attackable`,
      );
    }
  }
  const behaviorRules = freezeNpcCombatBehaviorRules(definitionId, profile.behaviorRules);
  const combatStatsByLevel = FreezeContentCombatLevelStats(
    profile.combatStatsByLevel,
    minimumLevel,
    maximumLevel,
    `NPC definition ${definitionId}`,
  );
  return Object.freeze({
    maxHp: profile.maxHp,
    maxMp: profile.maxMp,
    attackDamage: profile.attackDamage,
    moveSpeed: profile.moveSpeed,
    attackRange: profile.attackRange,
    attackIntervalMs: profile.attackIntervalMs,
    ...(combatStatsByLevel.length === 0 ? {} : { combatStatsByLevel }),
    acquireRangeMeters: profile.acquireRangeMeters,
    leashRangeMeters: profile.leashRangeMeters,
    ...(hasResourceRegen ? {
      resourceRegenAmount,
      resourceRegenIntervalMs,
      resourceRegenDelayAfterSpendMs,
    } : {}),
    attackablePlayerConfigIds,
    aggressivePlayerConfigIds,
    ...(behaviorRules.length === 0 ? {} : { behaviorRules }),
  });
}

function freezeNpcCombatBehaviorRules(
  definitionId: number,
  values: readonly NpcCombatBehaviorRule[] | undefined,
): readonly Readonly<NpcCombatBehaviorRule>[] {
  if (values === undefined) return Object.freeze([]);
  if (!Array.isArray(values)) {
    throw new Error(`NPC definition ${definitionId} combat behavior rules must be an array`);
  }
  const ids = new Set<number>();
  return Object.freeze(values.map((rule, ruleIndex) => {
    const owner = `NPC definition ${definitionId} combat behavior rule ${ruleIndex}`;
    if (!rule || typeof rule !== "object") throw new Error(`${owner} must be an object`);
    requirePositiveInteger(rule.id, `${owner} id`);
    if (ids.has(rule.id)) throw new Error(`${owner} id ${rule.id} is duplicated`);
    ids.add(rule.id);
    if (!Object.values(NpcCombatBehaviorTrigger).includes(rule.trigger)) {
      throw new Error(`${owner} trigger is unsupported`);
    }
    requirePermille(rule.chancePermille, `${owner} chance`);
    const requiredStateMask = rule.requiredStateMask ?? 0;
    if (!Number.isSafeInteger(requiredStateMask) || requiredStateMask < 0 || requiredStateMask > 0x7fff_ffff) {
      throw new Error(`${owner} state mask must be a non-negative 31-bit integer`);
    }
    const oncePerEngagement = rule.oncePerEngagement ?? false;
    if (typeof oncePerEngagement !== "boolean") {
      throw new Error(`${owner} oncePerEngagement must be boolean`);
    }
    const usesValueRange = rule.trigger === NpcCombatBehaviorTrigger.HealthRange
      || rule.trigger === NpcCombatBehaviorTrigger.ResourceRange;
    const minValuePermille = rule.minValuePermille ?? 0;
    const maxValuePermille = rule.maxValuePermille ?? 1_000;
    if (usesValueRange) {
      requirePermille(minValuePermille, `${owner} minimum value`);
      requirePermille(maxValuePermille, `${owner} maximum value`);
      if (minValuePermille > maxValuePermille) throw new Error(`${owner} value range is inverted`);
    } else if (rule.minValuePermille !== undefined || rule.maxValuePermille !== undefined) {
      throw new Error(`${owner} value bounds require a health or resource trigger`);
    }
    const usesDistanceRange = rule.trigger === NpcCombatBehaviorTrigger.TargetDistanceRange;
    const minDistanceMeters = rule.minDistanceMeters ?? 0;
    const maxDistanceMeters = rule.maxDistanceMeters ?? 0;
    if (usesDistanceRange) {
      if (!Number.isFinite(minDistanceMeters) || minDistanceMeters < 0
        || !Number.isFinite(maxDistanceMeters) || maxDistanceMeters < minDistanceMeters) {
        throw new Error(`${owner} distance range is invalid`);
      }
    } else if (rule.minDistanceMeters !== undefined || rule.maxDistanceMeters !== undefined) {
      throw new Error(`${owner} distance bounds require a target-distance trigger`);
    }
    const usesTimer = rule.trigger === NpcCombatBehaviorTrigger.CombatInterval;
    const initialDelayMinMs = rule.initialDelayMinMs ?? 0;
    const initialDelayMaxMs = rule.initialDelayMaxMs ?? initialDelayMinMs;
    const repeatDelayMinMs = rule.repeatDelayMinMs ?? 0;
    const repeatDelayMaxMs = rule.repeatDelayMaxMs ?? repeatDelayMinMs;
    for (const [label, value] of [
      ["initial minimum delay", initialDelayMinMs],
      ["initial maximum delay", initialDelayMaxMs],
      ["repeat minimum delay", repeatDelayMinMs],
      ["repeat maximum delay", repeatDelayMaxMs],
    ] as const) requireNonNegativeInteger(value, `${owner} ${label}`);
    if (initialDelayMinMs > initialDelayMaxMs || repeatDelayMinMs > repeatDelayMaxMs) {
      throw new Error(`${owner} delay range is inverted`);
    }
    if (!usesTimer && (rule.initialDelayMinMs !== undefined || rule.initialDelayMaxMs !== undefined)) {
      throw new Error(`${owner} initial delays require a combat-interval trigger`);
    }
    if (!Array.isArray(rule.actions) || rule.actions.length === 0) {
      throw new Error(`${owner} must contain actions`);
    }
    const actions = Object.freeze(rule.actions.map((
      action: NpcCombatBehaviorAction,
      actionIndex: number,
    ) => {
      const actionOwner = `${owner} action ${actionIndex}`;
      if (!action || typeof action !== "object") throw new Error(`${actionOwner} must be an object`);
      if (!Object.values(NpcCombatBehaviorActionType).includes(action.type)) {
        throw new Error(`${actionOwner} type is unsupported`);
      }
      if (!Object.values(NpcCombatBehaviorTarget).includes(action.target)) {
        throw new Error(`${actionOwner} target is unsupported`);
      }
      if (action.type === NpcCombatBehaviorActionType.ExecuteAbility) {
        requirePositiveInteger(action.abilityId ?? 0, `${actionOwner} ability id`);
      } else if (action.type === NpcCombatBehaviorActionType.SetCombatMovement) {
        if (typeof action.enabled !== "boolean") throw new Error(`${actionOwner} requires enabled`);
      } else if (action.type === NpcCombatBehaviorActionType.SetState) {
        if (!Number.isSafeInteger(action.state) || action.state! < 0 || action.state! > 30) {
          throw new Error(`${actionOwner} state must be 0..30`);
        }
      } else if (action.type === NpcCombatBehaviorActionType.ChangeState) {
        if (!Number.isSafeInteger(action.stateDelta) || action.stateDelta === 0
          || action.stateDelta! < -30 || action.stateDelta! > 30) {
          throw new Error(`${actionOwner} state delta must be -30..30 and non-zero`);
        }
      } else if (action.type === NpcCombatBehaviorActionType.Flee) {
        if (!Number.isFinite(action.fleeDistanceMeters) || action.fleeDistanceMeters! <= 0) {
          throw new Error(`${actionOwner} requires a positive flee distance`);
        }
      }
      return Object.freeze({ ...action });
    }));
    return Object.freeze({
      id: rule.id,
      trigger: rule.trigger,
      chancePermille: rule.chancePermille,
      ...(requiredStateMask === 0 ? {} : { requiredStateMask }),
      ...(oncePerEngagement ? { oncePerEngagement: true } : {}),
      ...(usesValueRange ? { minValuePermille, maxValuePermille } : {}),
      ...(usesDistanceRange ? { minDistanceMeters, maxDistanceMeters } : {}),
      ...(usesTimer ? { initialDelayMinMs, initialDelayMaxMs } : {}),
      ...(rule.repeatDelayMinMs === undefined ? {} : { repeatDelayMinMs, repeatDelayMaxMs }),
      actions,
    });
  }).sort((left, right) => left.id - right.id));
}

function normalizeOptionalPresentationId(
  value: string | undefined,
  definitionId: number,
  label: "model" | "loadout",
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`NPC definition ${definitionId} presentation ${label} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 128) {
    throw new Error(`NPC definition ${definitionId} presentation ${label} must be 1..128 characters`);
  }
  return normalized;
}

function normalizeOptionalPresentationStateId(
  value: number | undefined,
  ownerId: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`NPC ${ownerId} presentation state must be a non-negative integer`);
  }
  return value;
}

function freezePositiveIds(
  values: readonly number[],
  definitionId: number,
  label: string,
): readonly number[] {
  if (!Array.isArray(values)) throw new Error(`NPC definition ${definitionId} ${label} IDs must be an array`);
  const result = [...new Set(values)];
  for (const value of result) requirePositiveInteger(value, `NPC definition ${definitionId} ${label} ID`);
  return Object.freeze(result.sort((left, right) => left - right));
}

function freezeBuffDefinitionIds(
  values: readonly number[] | undefined,
  ownerId: number,
): readonly number[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) {
    throw new Error(`NPC ${ownerId} initial Buff definition IDs must be an array`);
  }
  const result = [...new Set(values)];
  for (const value of result) {
    requirePositiveInteger(value, `NPC ${ownerId} initial Buff definition ID`);
  }
  return Object.freeze(result.sort((left, right) => left - right));
}

function freezeQuestConfigIds(
  values: readonly number[],
  definitionId: number,
  relation: "starter" | "ender",
): readonly number[] {
  if (!Array.isArray(values)) {
    throw new Error(`NPC definition ${definitionId} quest ${relation} config IDs must be an array`);
  }
  const result: number[] = [];
  const seenQuestIds = new Set<number>();
  for (const questConfigId of values) {
    requirePositiveInteger(
      questConfigId,
      `NPC definition ${definitionId} quest ${relation} config ID`,
    );
    if (seenQuestIds.has(questConfigId)) {
      throw new Error(
        `NPC definition ${definitionId} contains duplicate ${relation} quest ${questConfigId}`,
      );
    }
    seenQuestIds.add(questConfigId);
    result.push(questConfigId);
  }
  return Object.freeze(result);
}

function freezeSpawn(spawn: NpcContentSpawn): Readonly<NpcContentSpawn> {
  if (!spawn || typeof spawn !== "object") throw new Error("NPC spawn must be an object");
  requirePositiveInteger(spawn.id, "NPC spawn id");
  requirePositiveInteger(spawn.npcDefinitionId, `NPC spawn ${spawn.id} definition id`);
  for (const [label, value] of [
    ["x", spawn.spawnX],
    ["y", spawn.spawnY],
    ["z", spawn.spawnZ],
    ["yaw", spawn.spawnYaw],
  ] as const) {
    if (!Number.isFinite(value)) throw new Error(`NPC spawn ${spawn.id} ${label} must be finite`);
  }
  if (typeof spawn.initialSpawn !== "boolean") {
    throw new Error(`NPC spawn ${spawn.id} initialSpawn must be boolean`);
  }
  const respawnSeconds = spawn.respawnSeconds ?? 0;
  requireNonNegativeInteger(respawnSeconds, `NPC spawn ${spawn.id} respawn seconds`);
  const waypoints = freezeWaypoints(spawn.waypoints, spawn.id);
  const interactionRules = freezeInteractionRules(spawn.id, spawn.interactionRules);
  const idleSequences = freezeIdleSequences(spawn.id, spawn.idleSequences);
  const combatBehaviorRules = spawn.combatBehaviorRules === undefined
    ? undefined
    : freezeNpcCombatBehaviorRules(spawn.id, spawn.combatBehaviorRules);
  const presentationLoadoutId = normalizeOptionalPresentationId(
    spawn.presentationLoadoutId,
    spawn.id,
    "loadout",
  );
  const presentationStateId = normalizeOptionalPresentationStateId(
    spawn.presentationStateId,
    spawn.id,
  );
  const initialBuffDefinitionIds = freezeBuffDefinitionIds(
    spawn.initialBuffDefinitionIds,
    spawn.id,
  );
  return Object.freeze({
    id: spawn.id,
    npcDefinitionId: spawn.npcDefinitionId,
    ...(presentationLoadoutId === undefined ? {} : { presentationLoadoutId }),
    ...(presentationStateId === undefined ? {} : { presentationStateId }),
    ...(initialBuffDefinitionIds === undefined ? {} : { initialBuffDefinitionIds }),
    spawnX: spawn.spawnX,
    spawnY: spawn.spawnY,
    spawnZ: spawn.spawnZ,
    spawnYaw: spawn.spawnYaw,
    initialSpawn: spawn.initialSpawn,
    ...(spawn.respawnSeconds === undefined ? {} : { respawnSeconds }),
    ...(combatBehaviorRules === undefined ? {} : { combatBehaviorRules }),
    ...(waypoints === undefined ? {} : { waypoints }),
    ...(interactionRules.length === 0 ? {} : { interactionRules }),
    ...(idleSequences.length === 0 ? {} : { idleSequences }),
  });
}

function freezeInteractionRules(
  spawnId: number,
  values: readonly NpcContentInteractionRule[] | undefined,
): readonly Readonly<NpcContentInteractionRule>[] {
  if (values === undefined) return Object.freeze([]);
  if (!Array.isArray(values)) throw new Error(`NPC spawn ${spawnId} interaction rules must be an array`);
  const ruleIds = new Set<number>();
  return Object.freeze(values.map((rule: NpcContentInteractionRule, ruleIndex: number) => {
    const owner = `NPC spawn ${spawnId} interaction rule ${ruleIndex}`;
    if (!rule || typeof rule !== "object") throw new Error(`${owner} must be an object`);
    requirePositiveInteger(rule.id, `${owner} id`);
    if (ruleIds.has(rule.id)) throw new Error(`${owner} id ${rule.id} is duplicated`);
    ruleIds.add(rule.id);
    if (
      rule.trigger !== NpcContentInteractionTrigger.QuestAccepted
      && rule.trigger !== NpcContentInteractionTrigger.QuestRewarded
      && rule.trigger !== NpcContentInteractionTrigger.GossipSelected
    ) throw new Error(`${owner} trigger is unsupported`);
    const triggerValue = rule.triggerValue ?? 0;
    requireNonNegativeInteger(triggerValue, `${owner} trigger value`);
    requirePermille(rule.chancePermille, `${owner} chance`);
    if (!Array.isArray(rule.actions) || rule.actions.length === 0) {
      throw new Error(`${owner} must contain actions`);
    }
    const actionIds = new Set<number>();
    const actions: Readonly<NpcContentInteractionAction>[] = rule.actions.map((
      action: NpcContentInteractionAction,
      actionIndex: number,
    ) => {
      const actionOwner = `${owner} action ${actionIndex}`;
      if (!action || typeof action !== "object") throw new Error(`${actionOwner} must be an object`);
      requirePositiveInteger(action.id, `${actionOwner} id`);
      if (actionIds.has(action.id)) throw new Error(`${actionOwner} id ${action.id} is duplicated`);
      actionIds.add(action.id);
      if (
        action.type !== NpcContentInteractionActionType.Emote
        && action.type !== NpcContentInteractionActionType.Say
        && action.type !== NpcContentInteractionActionType.ExecuteAbility
      ) throw new Error(`${actionOwner} type is unsupported`);
      if (
        action.target !== NpcContentInteractionActionTarget.Self
        && action.target !== NpcContentInteractionActionTarget.Player
      ) throw new Error(`${actionOwner} target is unsupported`);
      requireNonNegativeInteger(action.delayMs, `${actionOwner} delay`);
      const delayMaxMs = action.delayMaxMs ?? action.delayMs;
      requireNonNegativeInteger(delayMaxMs, `${actionOwner} maximum delay`);
      if (action.delayMs > delayMaxMs) throw new Error(`${actionOwner} delay range is inverted`);
      requirePermille(action.chancePermille, `${actionOwner} chance`);
      const presentationIds = freezePresentationIds(action.presentationIds, actionOwner);
      if (action.type === NpcContentInteractionActionType.Emote) {
        if (action.presentationId !== undefined && presentationIds !== undefined) {
          throw new Error(`${actionOwner} must declare presentationId or presentationIds, not both`);
        }
        if (action.presentationId === undefined && presentationIds === undefined) {
          throw new Error(`${actionOwner} requires presentationId or presentationIds`);
        }
        if (action.presentationId !== undefined) {
          requirePositiveInteger(action.presentationId, `${actionOwner} presentation id`);
        }
        if (action.textChoices !== undefined) {
          throw new Error(`${actionOwner} emote must not declare text choices`);
        }
        if (action.abilityId !== undefined) {
          throw new Error(`${actionOwner} emote must not declare ability id`);
        }
      } else if (action.type === NpcContentInteractionActionType.Say) {
        if (action.presentationId !== undefined || presentationIds !== undefined) {
          throw new Error(`${actionOwner} say must not declare presentation ids`);
        }
        if (action.abilityId !== undefined) {
          throw new Error(`${actionOwner} say must not declare ability id`);
        }
        if (!Array.isArray(action.textChoices) || action.textChoices.length === 0) {
          throw new Error(`${actionOwner} say requires text choices`);
        }
      } else {
        if (action.presentationId !== undefined || presentationIds !== undefined) {
          throw new Error(`${actionOwner} ability must not declare presentation ids`);
        }
        if (action.textChoices !== undefined) {
          throw new Error(`${actionOwner} ability must not declare text choices`);
        }
        requirePositiveInteger(action.abilityId ?? 0, `${actionOwner} ability id`);
      }
      const textChoices = action.textChoices === undefined
        ? undefined
        : Object.freeze(action.textChoices.map((text: string, textIndex: number) => {
          if (typeof text !== "string" || text.trim().length === 0) {
            throw new Error(`${actionOwner} text choice ${textIndex} must not be empty`);
          }
          return text;
        }));
      return Object.freeze({
        id: action.id,
        type: action.type,
        target: action.target,
        delayMs: action.delayMs,
        ...(action.delayMaxMs === undefined ? {} : { delayMaxMs }),
        chancePermille: action.chancePermille,
        ...(action.presentationId === undefined ? {} : { presentationId: action.presentationId }),
        ...(presentationIds === undefined ? {} : { presentationIds }),
        ...(textChoices === undefined ? {} : { textChoices }),
        ...(action.abilityId === undefined ? {} : { abilityId: action.abilityId }),
      });
    }).sort((left, right) => left.delayMs - right.delayMs || left.id - right.id);
    return Object.freeze({
      id: rule.id,
      trigger: rule.trigger,
      ...(triggerValue === 0 ? {} : { triggerValue }),
      chancePermille: rule.chancePermille,
      actions: Object.freeze(actions),
    });
  }).sort((left, right) => left.id - right.id));
}

function freezeWaypoints(
  values: readonly NpcContentWaypoint[] | undefined,
  spawnId: number,
): readonly NpcContentWaypoint[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) throw new Error(`NPC spawn ${spawnId} waypoints must be an array`);
  if (values.length === 0) return Object.freeze([]);
  const waypoints = values.map((waypoint, index) => {
    if (!waypoint || typeof waypoint !== "object") {
      throw new Error(`NPC spawn ${spawnId} waypoint ${index} must be an object`);
    }
    for (const [label, value] of [
      ["x", waypoint.x],
      ["y", waypoint.y],
      ["z", waypoint.z],
    ] as const) {
      if (!Number.isFinite(value)) {
        throw new Error(`NPC spawn ${spawnId} waypoint ${index} ${label} must be finite`);
      }
    }
    if (waypoint.yaw !== undefined && !Number.isFinite(waypoint.yaw)) {
      throw new Error(`NPC spawn ${spawnId} waypoint ${index} yaw must be finite`);
    }
    if (!Number.isSafeInteger(waypoint.delayMs) || waypoint.delayMs < 0) {
      throw new Error(`NPC spawn ${spawnId} waypoint ${index} delayMs must not be negative`);
    }
    if (waypoint.moveSpeed !== undefined
      && (!Number.isFinite(waypoint.moveSpeed) || waypoint.moveSpeed <= 0)) {
      throw new Error(`NPC spawn ${spawnId} waypoint ${index} moveSpeed must be positive`);
    }
    return Object.freeze({
      x: waypoint.x,
      y: waypoint.y,
      z: waypoint.z,
      ...(waypoint.yaw === undefined ? {} : { yaw: waypoint.yaw }),
      delayMs: waypoint.delayMs,
      ...(waypoint.moveSpeed === undefined ? {} : { moveSpeed: waypoint.moveSpeed }),
    });
  });
  return Object.freeze(waypoints);
}

function freezeIdleSequences(
  spawnId: number,
  values: readonly NpcContentIdleSequence[] | undefined,
): readonly Readonly<NpcContentIdleSequence>[] {
  if (values === undefined) return Object.freeze([]);
  if (!Array.isArray(values)) throw new Error(`NPC spawn ${spawnId} idle sequences must be an array`);
  const sequenceIds = new Set<number>();
  return Object.freeze(values.map((sequence, sequenceIndex) => {
    if (!sequence || typeof sequence !== "object") {
      throw new Error(`NPC spawn ${spawnId} idle sequence ${sequenceIndex} must be an object`);
    }
    requirePositiveInteger(sequence.id, `NPC spawn ${spawnId} idle sequence id`);
    if (sequenceIds.has(sequence.id)) {
      throw new Error(`NPC spawn ${spawnId} idle sequence ${sequence.id} is duplicated`);
    }
    sequenceIds.add(sequence.id);
    requirePermille(sequence.chancePermille, `NPC spawn ${spawnId} idle sequence ${sequence.id} chance`);
    requireNonNegativeInteger(
      sequence.initialDelayMinMs,
      `NPC spawn ${spawnId} idle sequence ${sequence.id} initial minimum delay`,
    );
    requireNonNegativeInteger(
      sequence.initialDelayMaxMs,
      `NPC spawn ${spawnId} idle sequence ${sequence.id} initial maximum delay`,
    );
    requirePositiveInteger(
      sequence.repeatDelayMinMs,
      `NPC spawn ${spawnId} idle sequence ${sequence.id} repeat minimum delay`,
    );
    requirePositiveInteger(
      sequence.repeatDelayMaxMs,
      `NPC spawn ${spawnId} idle sequence ${sequence.id} repeat maximum delay`,
    );
    if (sequence.initialDelayMinMs > sequence.initialDelayMaxMs) {
      throw new Error(`NPC spawn ${spawnId} idle sequence ${sequence.id} initial delay is inverted`);
    }
    if (sequence.repeatDelayMinMs > sequence.repeatDelayMaxMs) {
      throw new Error(`NPC spawn ${spawnId} idle sequence ${sequence.id} repeat delay is inverted`);
    }
    if (!Array.isArray(sequence.actions) || sequence.actions.length === 0) {
      throw new Error(`NPC spawn ${spawnId} idle sequence ${sequence.id} must contain actions`);
    }
    const actionIds = new Set<number>();
    const actions: Readonly<NpcContentIdleAction>[] = sequence.actions.map((
      action: NpcContentIdleAction,
      actionIndex: number,
    ) => {
      const owner = `NPC spawn ${spawnId} idle sequence ${sequence.id} action ${actionIndex}`;
      if (!action || typeof action !== "object") throw new Error(`${owner} must be an object`);
      requirePositiveInteger(action.id, `${owner} id`);
      if (actionIds.has(action.id)) throw new Error(`${owner} id ${action.id} is duplicated`);
      actionIds.add(action.id);
      if (
        action.type !== NpcContentIdleActionType.Emote
        && action.type !== NpcContentIdleActionType.ExecuteAbility
        && action.type !== NpcContentIdleActionType.Say
        && action.type !== NpcContentIdleActionType.EmoteState
      ) {
        throw new Error(`${owner} type is unsupported`);
      }
      if (
        action.target !== NpcContentIdleActionTarget.Self
        && action.target !== NpcContentIdleActionTarget.StableSpawn
      ) throw new Error(`${owner} target is unsupported`);
      requireNonNegativeInteger(action.delayMs, `${owner} delay`);
      const delayMaxMs = action.delayMaxMs ?? action.delayMs;
      requireNonNegativeInteger(delayMaxMs, `${owner} maximum delay`);
      if (action.delayMs > delayMaxMs) {
        throw new Error(`${owner} delay range is inverted`);
      }
      if (delayMaxMs > sequence.repeatDelayMinMs) {
        throw new Error(`${owner} delay must not exceed the minimum repeat delay`);
      }
      requirePermille(action.chancePermille, `${owner} chance`);
      const presentationIds = freezePresentationIds(action.presentationIds, owner);
      const textChoices = freezeTextChoices(action.textChoices, owner);
      if (action.type === NpcContentIdleActionType.Emote) {
        if (action.presentationId !== undefined && presentationIds !== undefined) {
          throw new Error(`${owner} must declare presentationId or presentationIds, not both`);
        }
        if (action.presentationId === undefined && presentationIds === undefined) {
          throw new Error(`${owner} requires presentationId or presentationIds`);
        }
        if (action.presentationId !== undefined) {
          requirePositiveInteger(action.presentationId, `${owner} presentation id`);
        }
        if (action.abilityId !== undefined) {
          throw new Error(`${owner} emote must not declare ability id`);
        }
        if (textChoices !== undefined) {
          throw new Error(`${owner} emote must not declare text choices`);
        }
      } else if (action.type === NpcContentIdleActionType.ExecuteAbility) {
        if (action.presentationId !== undefined || presentationIds !== undefined) {
          throw new Error(`${owner} ability must not declare presentation ids`);
        }
        if (textChoices !== undefined) {
          throw new Error(`${owner} ability must not declare text choices`);
        }
        requirePositiveInteger(action.abilityId ?? 0, `${owner} ability id`);
      } else if (action.type === NpcContentIdleActionType.Say) {
        if (action.presentationId !== undefined || presentationIds !== undefined) {
          throw new Error(`${owner} speech must not declare presentation ids`);
        }
        if (action.abilityId !== undefined) {
          throw new Error(`${owner} speech must not declare ability id`);
        }
        if (textChoices === undefined) {
          throw new Error(`${owner} speech requires text choices`);
        }
      } else if (action.type === NpcContentIdleActionType.EmoteState) {
        if (presentationIds !== undefined) {
          throw new Error(`${owner} emote state must not declare presentation ids array`);
        }
        if (action.abilityId !== undefined || textChoices !== undefined) {
          throw new Error(`${owner} emote state must not declare ability or text choices`);
        }
        requireNonNegativeInteger(
          action.presentationId ?? -1,
          `${owner} emote state id`,
        );
      } else {
        throw new Error(`${owner} type is unsupported`);
      }
      if (action.target === NpcContentIdleActionTarget.StableSpawn) {
        requirePositiveInteger(action.targetSpawnId ?? 0, `${owner} target spawn id`);
      } else if (action.targetSpawnId !== undefined) {
        throw new Error(`${owner} self target must not declare a target spawn id`);
      }
      return Object.freeze({
        id: action.id,
        type: action.type,
        target: action.target,
        ...(action.targetSpawnId === undefined ? {} : { targetSpawnId: action.targetSpawnId }),
        delayMs: action.delayMs,
        ...(action.delayMaxMs === undefined ? {} : { delayMaxMs }),
        chancePermille: action.chancePermille,
        ...(action.presentationId === undefined ? {} : { presentationId: action.presentationId }),
        ...(presentationIds === undefined ? {} : { presentationIds }),
        ...(action.abilityId === undefined ? {} : { abilityId: action.abilityId }),
        ...(textChoices === undefined ? {} : { textChoices }),
      });
    }).sort((left: Readonly<NpcContentIdleAction>, right: Readonly<NpcContentIdleAction>) => (
      left.delayMs - right.delayMs || left.id - right.id
    ));
    return Object.freeze({
      id: sequence.id,
      chancePermille: sequence.chancePermille,
      initialDelayMinMs: sequence.initialDelayMinMs,
      initialDelayMaxMs: sequence.initialDelayMaxMs,
      repeatDelayMinMs: sequence.repeatDelayMinMs,
      repeatDelayMaxMs: sequence.repeatDelayMaxMs,
      actions: Object.freeze(actions),
    });
  }));
}

function freezePresentationIds(
  values: readonly number[] | undefined,
  owner: string,
): readonly number[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${owner} presentationIds must be a non-empty array`);
  }
  for (const [index, value] of values.entries()) {
    requirePositiveInteger(value, `${owner} presentationIds[${index}]`);
  }
  return Object.freeze([...values]);
}

function freezeTextChoices(
  values: readonly string[] | undefined,
  owner: string,
): readonly string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${owner} textChoices must be a non-empty array`);
  }
  const choices = values.map((value, index) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`${owner} textChoices[${index}] must be non-empty text`);
    }
    return value.trim();
  });
  return Object.freeze(choices);
}

function requireOwnerId(value: string): string {
  const owner = value?.trim();
  if (!owner) throw new Error("NPC content owner id must not be empty");
  return owner;
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
}

function requireNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must not be negative`);
}

function requirePermille(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000) {
    throw new Error(`${label} must be 0..1000 permille`);
  }
}

function freezeRuntimePositiveIds(values: readonly number[], label: string): readonly number[] {
  if (!Array.isArray(values)) throw new Error(`NPC runtime ${label} IDs must be an array`);
  const result = [...new Set(values)];
  for (const value of result) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`NPC runtime ${label} ID must be positive`);
  }
  return Object.freeze(result.sort((left, right) => left - right));
}

function freezeRuntimeCapabilities(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values)) throw new Error("NPC runtime extension capabilities must be an array");
  const result = [...new Set(values.map((value) => value.trim()))];
  for (const value of result) {
    if (!value || value.length > 160 || !value.includes(".")) {
      throw new Error("NPC runtime extension capability must be a namespaced key of at most 160 characters");
    }
  }
  return Object.freeze(result.sort((left, right) => left.localeCompare(right, "en")));
}
