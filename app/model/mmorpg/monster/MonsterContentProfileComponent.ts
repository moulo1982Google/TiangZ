import { Component, component } from "../../../core/public";
import {
  FreezeContentCombatLevelStats,
  type ContentCombatLevelStats,
} from "../combat/ContentCombatLevelStats";

/** 中立怪物内容契约支持的运行时触发器。 / Runtime triggers supported by the neutral monster content contract. */
export const MonsterContentBehaviorTrigger = {
  Engage: 1,
  HealthRange: 2,
  /** 模块持有的Buff状态发生变化，Buff编号对TiangZ保持不透明。 / A module-owned Buff state changed; the Buff id is opaque to TiangZ. */
  AuraState: 3,
  /** 怪物死亡已提交前的最后一次模块行为边界。 / The final module behavior boundary before monster death is committed. */
  Death: 4,
  /** 在战斗中按内容声明的首次及重复间隔进行求值。 / Evaluated in combat using content-declared initial and repeat intervals. */
  CombatInterval: 5,
  /** 每次创建新的怪物运行实例后求值一次，包括首次生成与重生。 / Evaluated once after each monster runtime instance is created, including initial spawn and respawn. */
  Spawned: 6,
  /** 由外部游戏适配器提交的不透明内容信号；编号及含义完全归模块所有。 / An opaque content signal submitted by an external game adapter; the module owns its id and meaning. */
  ExternalSignal: 7,
} as const;

export type MonsterContentBehaviorTriggerValue =
  (typeof MonsterContentBehaviorTrigger)[keyof typeof MonsterContentBehaviorTrigger];

/** 怪物运行时当前可呈现的协议中立动作。 / Protocol-neutral actions that the monster runtime can currently present. */
export const MonsterContentBehaviorActionType = {
  Say: 1,
  Emote: 2,
  ApplyBuff: 3,
  /** 请求所属游戏模块执行不透明的能力编号。 / Ask the owning game module to execute an opaque ability identifier. */
  ExecuteAbility: 4,
  /** 清理仇恨并将怪物回归出生点。 / Reset threat and return the monster to its home point. */
  Evade: 5,
} as const;

export type MonsterContentBehaviorActionTypeValue =
  (typeof MonsterContentBehaviorActionType)[keyof typeof MonsterContentBehaviorActionType];

export const MonsterContentBehaviorTarget = {
  Self: 1,
  CombatTarget: 2,
} as const;

export type MonsterContentBehaviorTargetValue =
  (typeof MonsterContentBehaviorTarget)[keyof typeof MonsterContentBehaviorTarget];

/** 到达巡逻路径点后调度的中立动作。 / Neutral actions scheduled after a patrol waypoint is reached. */
export const MonsterContentWaypointActionType = {
  SetEmoteState: 1,
  SetModel: 2,
  BeginWander: 3,
  RestartRoute: 4,
} as const;

export type MonsterContentWaypointActionTypeValue =
  (typeof MonsterContentWaypointActionType)[keyof typeof MonsterContentWaypointActionType];

/** 脱战空闲序列可执行的中立动作。 / Neutral actions available to out-of-combat idle sequences. */
export const MonsterContentIdleActionType = {
  Emote: 1,
  /** 鍙戝竷涓€娆′腑绔嬫枃鏈〃鐜帮紱鏈湴鍖栧拰鍗忚缂栫爜鐢卞唴瀹归€傞厤鍣ㄨ礋璐ｃ€?/ Publishes neutral speech; content adapters own localization and protocol encoding. */
  Say: 2,
} as const;

export type MonsterContentIdleActionTypeValue =
  (typeof MonsterContentIdleActionType)[keyof typeof MonsterContentIdleActionType];

/** 空闲动作的执行者可以是自身或同一内容所有者的稳定刷点。 / An idle action actor can be self or a stable spawn owned by the same content package. */
export const MonsterContentIdleActionTarget = {
  Self: 1,
  StableSpawn: 2,
} as const;

export type MonsterContentIdleActionTargetValue =
  (typeof MonsterContentIdleActionTarget)[keyof typeof MonsterContentIdleActionTarget];

export interface MonsterContentIdleAction {
  readonly id: number;
  readonly type: MonsterContentIdleActionTypeValue;
  readonly target: MonsterContentIdleActionTargetValue;
  /** StableSpawn目标使用的模块刷点编号。 / Module spawn identifier used by a StableSpawn target. */
  readonly targetSpawnId?: number;
  /** 相对于本轮空闲序列触发时刻的延迟。 / Delay relative to this idle-sequence execution. */
  readonly delayMs: number;
  readonly chancePermille: number;
  /** Emote动作使用的适配器表现编号。 / Adapter-defined presentation identifier used by an Emote action. */
  readonly presentationId?: number;
  /** Say动作使用的文本候选；每次执行会确定性选择一项。 / Text choices used by a Say action; one value is selected deterministically per execution. */
  readonly textChoices?: readonly string[];
}

/** 仅在怪物脱战时推进的可重复、确定性空闲动作序列。 / A repeatable deterministic action sequence advanced only while a monster is out of combat. */
export interface MonsterContentIdleSequence {
  readonly id: number;
  readonly chancePermille: number;
  readonly initialDelayMinMs: number;
  readonly initialDelayMaxMs: number;
  readonly repeatDelayMinMs: number;
  readonly repeatDelayMaxMs: number;
  readonly actions: readonly MonsterContentIdleAction[];
}

export interface MonsterContentWaypointAction {
  /** 源数据持有、用于确定性概率判定的稳定编号。 / Stable source-owned identifier used for deterministic chance evaluation. */
  readonly id: number;
  readonly type: MonsterContentWaypointActionTypeValue;
  /** 相对于到达所属路径点的延迟。 / Delay relative to arrival at the containing waypoint. */
  readonly delayMs: number;
  readonly chancePermille: number;
  /** SetEmoteState使用的动画状态；零表示清除。 / Animation state for SetEmoteState; zero clears the state. */
  readonly presentationId?: number;
  /** SetModel使用的协议中立模型标识。 / Protocol-neutral model identifier for SetModel. */
  readonly modelId?: string;
  /** BeginWander围绕已到达路径点的半径。 / Radius around the reached waypoint for BeginWander. */
  readonly wanderRadius?: number;
}

export interface MonsterContentBehaviorAction {
  readonly type: MonsterContentBehaviorActionTypeValue;
  readonly target: MonsterContentBehaviorTargetValue;
  /** 仅当动作目标缺少该不透明 Buff 时执行；具体 Buff 含义仍归内容模块所有。 / Executes only while the action target lacks this opaque Buff; the content module still owns its meaning. */
  readonly requiredAbsentBuffDefinitionId?: number;
  /** Say动作在每次触发时确定性选择一项。 / A Say action deterministically selects one entry per trigger. */
  readonly textChoices?: readonly string[];
  /** Emote动作使用适配器定义的动画编号。 / An Emote action uses the adapter-defined animation identifier. */
  readonly presentationId?: number;
  /** 由地图Buff定义资料解析的模块私有Buff编号。 / Module-private Buff identifier resolved by the map's Buff definition profile. */
  readonly buffDefinitionId?: number;
  /** 在Buff与战斗遥测中保留的可选源能力编号。 / Optional source ability retained in Buff and combat telemetry. */
  readonly sourceAbilityId?: number;
  /** 传递给所属游戏适配器的模块私有能力编号。 / Module-private ability identifier carried to the owning game adapter. */
  readonly abilityId?: number;
}

/**
 * 小型、游戏中立的行为规则；SmartAI等源引擎由游戏模块投影成此结构，不向TiangZ泄露源枚举值。
 * A small, game-neutral behavior rule; game modules project source engines such as SmartAI into this shape without leaking source enum values into TiangZ.
 */
export interface MonsterContentBehaviorRule {
  readonly id: number;
  readonly trigger: MonsterContentBehaviorTriggerValue;
  readonly chancePermille: number;
  /** 仅供HealthRange使用的闭区间生命边界，以0..1000千分比表示。 / Inclusive health bounds used only by HealthRange, expressed as 0..1000 permille. */
  readonly minHealthPermille?: number;
  readonly maxHealthPermille?: number;
  /** AuraState触发器观察的不透明Buff编号。 / Opaque Buff identifier observed by an AuraState trigger. */
  readonly requiredBuffDefinitionId?: number;
  /** AuraState触发器是否要求Buff存在。 / Whether the AuraState trigger requires the Buff to be present. */
  readonly requiredBuffPresent?: boolean;
  /** ExternalSignal触发器匹配的模块私有信号编号。 / Module-private signal identifier matched by an ExternalSignal trigger. */
  readonly requiredSignalId?: number;
  /** 首次CombatInterval求值延迟的下界。 / Lower bound for the first CombatInterval evaluation. */
  readonly initialDelayMinMs?: number;
  /** 首次CombatInterval求值延迟的上界。 / Upper bound for the first CombatInterval evaluation. */
  readonly initialDelayMaxMs?: number;
  /** AuraState或可重复HealthRange匹配后的下一次计时延迟。允许为0以表示每一帧检查。 / Delay before the next matched AuraState or repeatable HealthRange evaluation; zero polls every simulation tick. */
  readonly repeatDelayMinMs?: number;
  /** 匹配后延迟的上界；运行时在区间内确定性选择。 / Upper bound for the matched delay; runtime selects deterministically within this interval. */
  readonly repeatDelayMaxMs?: number;
  readonly actions: readonly MonsterContentBehaviorAction[];
}

/** 模块拥有、由现有地图战斗运行时消费的怪物模板。 / A module-owned monster template consumed by the existing map combat runtime. */
/** 某玩家等级击败怪物时获得的中立经验；游戏模块在构建期计算整条曲线。 / Neutral experience granted for defeating a monster at one player level; game modules calculate the curve at build time. */
export interface MonsterContentExperienceReward {
  readonly playerLevel: number;
  readonly experience: number;
}

export interface MonsterContentDefinition {
  readonly id: number;
  readonly name: string;
  readonly modelId: string;
  /** 可选的生成等级闭区间；省略时兼容为1级，具体游戏只负责物化区间。 / Optional inclusive spawn-level range; omission preserves level 1 while games only materialize the range. */
  readonly minimumLevel?: number;
  readonly maximumLevel?: number;
  /** 可选完整逐级战斗数值；计算公式由内容模块拥有。 / Optional complete per-level combat stats whose formula is owned by content. */
  readonly combatStatsByLevel?: readonly ContentCombatLevelStats[];
  /** Optional persistent presentation state; the owning adapter gives the value its meaning. / 可选持久表现状态，具体含义由所属适配器负责。 */
  readonly presentationStateId?: number;
  readonly maxHp: number;
  readonly maxMp: number;
  /** 可选的主资源恢复参数；恢复公式由内容模块在构建期投影。 / Optional primary-resource regeneration projected by the content module at build time. */
  readonly resourceRegenAmount?: number;
  readonly resourceRegenIntervalMs?: number;
  readonly resourceRegenDelayAfterSpendMs?: number;
  readonly attackDamage: number;
  readonly moveSpeed: number;
  readonly attackRange: number;
  readonly attackIntervalMs: number;
  readonly attackMode: number;
  /** 省略时保留旧行为；提供时表示完整玩家模板允许列表。 / Omitted preserves legacy behavior; a present list is the complete player-template allowlist. */
  readonly attackablePlayerConfigIds?: readonly number[];
  /** 省略时主动attackMode可选取任意玩家；提供时限制主动仇恨范围。 / Omitted lets active attackMode acquire any player; a present list scopes proactive aggro. */
  readonly aggressivePlayerConfigIds?: readonly number[];
  readonly skillId: number;
  readonly dropTableId: number;
  /** Content-declared buffs applied when a fresh monster instance is spawned. / 内容声明的怪物初始Buff；每次新刷出时应用。 */
  readonly initialBuffDefinitionIds?: readonly number[];
  /** 怪物死亡时独立发放的铜币范围；省略或全为零表示不掉落金币。 / Optional copper range granted independently when the monster dies; omitted or all-zero means no template gold. */
  readonly minGold?: number;
  readonly maxGold?: number;
  /** 按玩家等级预计算的击败奖励；Core只持久化选中值，不解释来源游戏公式。 / Precomputed defeat rewards by player level; Core persists the selected value without interpreting source-game formulas. */
  readonly rewardExperienceByPlayerLevel?: readonly MonsterContentExperienceReward[];
  /** 未被刷点显式覆盖时使用的模板级规则。 / Entry-level rules used unless a spawn supplies an explicit override. */
  readonly behaviorRules?: readonly MonsterContentBehaviorRule[];
}

/** 模块持有的一个中立地图坐标路径点。 / One module-owned waypoint in neutral map coordinates. */
export interface MonsterContentWaypoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** 到达后应用的可选朝向。 / Optional facing applied after arrival. */
  readonly yaw?: number;
  readonly delayMs: number;
  /** 省略时使用共享怪物模板移动速度。 / Omitted uses the shared monster-template movement speed. */
  readonly moveSpeed?: number;
  /** 在此路径点延迟期间判定的有序动作。 / Ordered actions evaluated while this waypoint's delay is active. */
  readonly actions?: readonly MonsterContentWaypointAction[];
}

/** 稳定地图刷点；重生周期属于刷点而不是共享模板。 / A stable map slot whose respawn period belongs to the slot instead of the shared template. */
/**
 * 随机游走连续路段之间的配置化停顿策略；来源游戏负责选择参数，MMORPG运行时只执行中立调度。
 * Configurable pause policy between random-wander legs; source games choose
 * the parameters while the MMORPG runtime only executes neutral scheduling.
 */
export interface MonsterContentWanderSchedule {
  readonly initialDelayMinMs: number;
  readonly initialDelayMaxMs: number;
  readonly pauseMinMs: number;
  readonly pauseMaxMs: number;
  readonly firstLegPauseChancePermille: number;
  readonly additionalLegPauseChancePermille: number;
}

export interface MonsterContentSpawn {
  readonly id: number;
  readonly monsterDefinitionId: number;
  /** Optional spawn override; zero explicitly clears the template state. / 可选刷点覆盖；零表示显式清除模板状态。 */
  readonly presentationStateId?: number;
  /** Optional spawn override; an empty list explicitly clears template buffs. / 可选刷点覆盖；空数组显式清除模板Buff。 */
  readonly initialBuffDefinitionIds?: readonly number[];
  readonly spawnX: number;
  readonly spawnY: number;
  readonly spawnZ: number;
  readonly spawnYaw: number;
  readonly initialSpawn: boolean;
  readonly respawnSeconds: number;
  /** 围绕固定刷点进行确定性环境游走的半径。 / Radius around the fixed spawn used for deterministic ambient wandering. */
  readonly wanderRadius?: number;
  /** 省略时使用共享怪物模板移动速度。 / Omitted uses the shared monster-template movement speed. */
  readonly wanderMoveSpeed?: number;
  /** 游走路段的初始错峰和概率停顿；省略时保留每段到达后停顿的兼容行为。 / Initial staggering and probabilistic pauses for wander legs; omission preserves the compatible pause-after-each-leg behavior. */
  readonly wanderSchedule?: Readonly<MonsterContentWanderSchedule>;
  /** 有序循环路径；路径点优先于游走。 / Ordered, repeating route; waypoints take precedence over wandering. */
  readonly waypoints?: readonly MonsterContentWaypoint[];
  /** 刷点级规则替换模板级规则，以匹配逐刷点脚本归属。 / Spawn-level rules replace entry-level rules, matching per-spawn script ownership. */
  readonly behaviorRules?: readonly MonsterContentBehaviorRule[];
  /** 脱战时执行的刷点级定时表现序列。 / Spawn-level timed presentation sequences executed out of combat. */
  readonly idleSequences?: readonly MonsterContentIdleSequence[];
}

export interface MonsterContentRegistration {
  readonly definitions: readonly MonsterContentDefinition[];
  readonly spawns: readonly MonsterContentSpawn[];
}

/**
 * 地图工厂与外置内容包之间的中立资料目录。模块在MapScene发布前原子登记模板和固定刷点，MapHost随后冻结目录；
 * MonsterComponent继续拥有Unit、AOI、战斗、尸体和重生，不把运行态交给内容包。
 *
 * Neutral map content catalog for external game packages. Modules atomically
 * register templates and stable slots before MapScene publication; MapHost then
 * seals the catalog while MonsterComponent retains all runtime ownership.
 */
@component()
export class MonsterContentProfileComponent extends Component {
  private readonly definitions = new Map<number, Readonly<MonsterContentDefinition>>();
  private readonly definitionOwners = new Map<number, string>();
  private readonly spawns = new Map<number, Readonly<MonsterContentSpawn>>();
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

  /** 声明完整外置内容包拥有该地图目录，避免混入演示冷刷点。 / Claims this map catalog so demo cold slots are not merged into a complete external data pack. */
  ReplaceColdContent(ownerId: string): void {
    if (this.sealed) throw new Error("monster content profile is sealed");
    const owner = requireOwnerId(ownerId);
    if (this.coldContentReplacementOwner) {
      throw new Error(
        `cold monster content already belongs to ${this.coldContentReplacementOwner}`,
      );
    }
    this.coldContentReplacementOwner = owner;
  }

  Register(ownerId: string, registration: MonsterContentRegistration): void {
    if (this.sealed) throw new Error("monster content profile is sealed");
    const owner = requireOwnerId(ownerId);
    if (!registration || typeof registration !== "object") {
      throw new Error("monster content registration must be an object");
    }
    if (!Array.isArray(registration.definitions) || !Array.isArray(registration.spawns)) {
      throw new Error("monster content registration must contain definition and spawn arrays");
    }

    const pendingDefinitions = new Map<number, Readonly<MonsterContentDefinition>>();
    for (const definition of registration.definitions) {
      const frozen = freezeDefinition(definition);
      if (this.definitions.has(frozen.id) || pendingDefinitions.has(frozen.id)) {
        const previousOwner = this.definitionOwners.get(frozen.id) ?? owner;
        throw new Error(`monster definition ${frozen.id} already belongs to ${previousOwner}`);
      }
      pendingDefinitions.set(frozen.id, frozen);
    }

    const pendingSpawns = new Map<number, Readonly<MonsterContentSpawn>>();
    for (const spawn of registration.spawns) {
      const frozen = freezeSpawn(spawn);
      if (this.spawns.has(frozen.id) || pendingSpawns.has(frozen.id)) {
        const previousOwner = this.spawnOwners.get(frozen.id) ?? owner;
        throw new Error(`monster spawn ${frozen.id} already belongs to ${previousOwner}`);
      }
      const definitionOwner = this.definitionOwners.get(frozen.monsterDefinitionId);
      if (definitionOwner && definitionOwner !== owner) {
        throw new Error(
          `monster spawn ${frozen.id} cannot reference definition ${frozen.monsterDefinitionId} owned by ${definitionOwner}`,
        );
      }
      if (!pendingDefinitions.has(frozen.monsterDefinitionId) && definitionOwner !== owner) {
        throw new Error(
          `monster spawn ${frozen.id} references missing definition ${frozen.monsterDefinitionId}`,
        );
      }
      pendingSpawns.set(frozen.id, frozen);
    }

    for (const spawn of pendingSpawns.values()) {
      for (const sequence of spawn.idleSequences ?? []) {
        for (const action of sequence.actions) {
          if (action.target !== MonsterContentIdleActionTarget.StableSpawn) continue;
          const targetSpawnId = action.targetSpawnId ?? 0;
          const targetOwner = this.spawnOwners.get(targetSpawnId);
          if (!pendingSpawns.has(targetSpawnId) && targetOwner !== owner) {
            throw new Error(
              `monster spawn ${spawn.id} idle action ${action.id} references missing or foreign spawn ${targetSpawnId}`,
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

  TryGetDefinition(id: number): Readonly<MonsterContentDefinition> | undefined {
    return this.definitions.get(id);
  }

  GetDefinitions(): readonly Readonly<MonsterContentDefinition>[] {
    return Object.freeze([...this.definitions.values()].sort((left, right) => left.id - right.id));
  }

  GetSpawns(): readonly Readonly<MonsterContentSpawn>[] {
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

function freezeDefinition(definition: MonsterContentDefinition): Readonly<MonsterContentDefinition> {
  if (!definition || typeof definition !== "object") {
    throw new Error("monster definition must be an object");
  }
  requirePositiveInteger(definition.id, "monster definition id");
  const name = definition.name?.trim();
  if (!name) throw new Error(`monster definition ${definition.id} name must not be empty`);
  const modelId = definition.modelId?.trim();
  if (!modelId) throw new Error(`monster definition ${definition.id} model id must not be empty`);
  const minimumLevel = definition.minimumLevel;
  const maximumLevel = definition.maximumLevel;
  if ((minimumLevel === undefined) !== (maximumLevel === undefined)) {
    throw new Error(`monster definition ${definition.id} level range requires both bounds`);
  }
  if (minimumLevel !== undefined && maximumLevel !== undefined) {
    requirePositiveInteger(minimumLevel, `monster definition ${definition.id} minimum level`);
    requirePositiveInteger(maximumLevel, `monster definition ${definition.id} maximum level`);
    if (minimumLevel > maximumLevel) {
      throw new Error(`monster definition ${definition.id} level range is inverted`);
    }
  }
  const combatStatsByLevel = FreezeContentCombatLevelStats(
    definition.combatStatsByLevel,
    minimumLevel,
    maximumLevel,
    `monster definition ${definition.id}`,
  );
  const presentationStateId = definition.presentationStateId;
  if (presentationStateId !== undefined) {
    requireNonNegativeInteger(
      presentationStateId,
      `monster definition ${definition.id} presentation state id`,
    );
  }
  const initialBuffDefinitionIds = freezeBuffDefinitionIds(
    definition.initialBuffDefinitionIds,
    `monster definition ${definition.id}`,
  );
  requirePositiveInteger(definition.maxHp, `monster definition ${definition.id} max hp`);
  requireNonNegativeInteger(definition.maxMp, `monster definition ${definition.id} max mp`);
  const resourceRegenAmount = definition.resourceRegenAmount ?? 0;
  const resourceRegenIntervalMs = definition.resourceRegenIntervalMs ?? 0;
  const resourceRegenDelayAfterSpendMs = definition.resourceRegenDelayAfterSpendMs ?? 0;
  for (const [name, value] of [
    ["resourceRegenAmount", resourceRegenAmount],
    ["resourceRegenIntervalMs", resourceRegenIntervalMs],
    ["resourceRegenDelayAfterSpendMs", resourceRegenDelayAfterSpendMs],
  ] as const) {
    requireNonNegativeInteger(value, `monster definition ${definition.id} ${name}`);
  }
  const hasResourceRegen = resourceRegenAmount > 0
    || resourceRegenIntervalMs > 0
    || resourceRegenDelayAfterSpendMs > 0;
  if (hasResourceRegen && (
    definition.maxMp <= 0 || resourceRegenAmount <= 0 || resourceRegenIntervalMs <= 0
  )) {
    throw new Error(
      `monster definition ${definition.id} resource regeneration requires maxMp, amount, and interval`,
    );
  }
  requireNonNegativeInteger(definition.attackDamage, `monster definition ${definition.id} attack damage`);
  requirePositiveFinite(definition.moveSpeed, `monster definition ${definition.id} move speed`);
  requirePositiveFinite(definition.attackRange, `monster definition ${definition.id} attack range`);
  requirePositiveInteger(
    definition.attackIntervalMs,
    `monster definition ${definition.id} attack interval`,
  );
  if (definition.attackMode !== 0 && definition.attackMode !== 1) {
    throw new Error(`monster definition ${definition.id} attack mode must be passive or active`);
  }
  requireNonNegativeInteger(definition.skillId, `monster definition ${definition.id} skill id`);
  requireNonNegativeInteger(definition.dropTableId, `monster definition ${definition.id} drop table id`);
  const minGold = definition.minGold ?? 0;
  const maxGold = definition.maxGold ?? 0;
  requireNonNegativeInteger(minGold, `monster definition ${definition.id} minimum gold`);
  requireNonNegativeInteger(maxGold, `monster definition ${definition.id} maximum gold`);
  if (minGold > maxGold) {
    throw new Error(`monster definition ${definition.id} gold range is inverted`);
  }
  const rewardExperienceByPlayerLevel = freezeExperienceRewards(
    definition.rewardExperienceByPlayerLevel,
    definition.id,
  );
  const attackablePlayerConfigIds = freezePlayerConfigIds(
    definition.attackablePlayerConfigIds,
    `monster definition ${definition.id} attackable player config id`,
  );
  const aggressivePlayerConfigIds = freezePlayerConfigIds(
    definition.aggressivePlayerConfigIds,
    `monster definition ${definition.id} aggressive player config id`,
  );
  const behaviorRules = freezeBehaviorRules(
    definition.behaviorRules,
    `monster definition ${definition.id}`,
  );
  return Object.freeze({
    id: definition.id,
    name,
    modelId,
    ...(minimumLevel === undefined ? {} : { minimumLevel, maximumLevel }),
    ...(combatStatsByLevel.length === 0 ? {} : { combatStatsByLevel }),
    ...(presentationStateId === undefined ? {} : { presentationStateId }),
    ...(initialBuffDefinitionIds === undefined ? {} : { initialBuffDefinitionIds }),
    maxHp: definition.maxHp,
    maxMp: definition.maxMp,
    ...(hasResourceRegen ? {
      resourceRegenAmount,
      resourceRegenIntervalMs,
      resourceRegenDelayAfterSpendMs,
    } : {}),
    attackDamage: definition.attackDamage,
    moveSpeed: definition.moveSpeed,
    attackRange: definition.attackRange,
    attackIntervalMs: definition.attackIntervalMs,
    attackMode: definition.attackMode,
    ...(attackablePlayerConfigIds === undefined ? {} : { attackablePlayerConfigIds }),
    ...(aggressivePlayerConfigIds === undefined ? {} : { aggressivePlayerConfigIds }),
    skillId: definition.skillId,
    dropTableId: definition.dropTableId,
    ...(minGold === 0 && maxGold === 0 ? {} : { minGold, maxGold }),
    ...(rewardExperienceByPlayerLevel.length === 0 ? {} : { rewardExperienceByPlayerLevel }),
    ...(behaviorRules.length === 0 ? {} : { behaviorRules }),
  });
}

function freezeExperienceRewards(
  values: readonly MonsterContentExperienceReward[] | undefined,
  definitionId: number,
): readonly Readonly<MonsterContentExperienceReward>[] {
  if (values === undefined) return Object.freeze([]);
  if (!Array.isArray(values)) {
    throw new Error(`monster definition ${definitionId} experience rewards must be an array`);
  }
  const levels = new Set<number>();
  const rewards = values.map((value, index) => {
    if (!value || typeof value !== "object") {
      throw new Error(`monster definition ${definitionId} experience reward ${index} must be an object`);
    }
    requirePositiveInteger(
      value.playerLevel,
      `monster definition ${definitionId} experience reward player level`,
    );
    requireNonNegativeInteger(
      value.experience,
      `monster definition ${definitionId} experience reward`,
    );
    if (levels.has(value.playerLevel)) {
      throw new Error(
        `monster definition ${definitionId} experience reward player level ${value.playerLevel} is duplicated`,
      );
    }
    levels.add(value.playerLevel);
    return Object.freeze({ playerLevel: value.playerLevel, experience: value.experience });
  });
  return Object.freeze(rewards.sort((left, right) => left.playerLevel - right.playerLevel));
}

function freezePlayerConfigIds(
  values: readonly number[] | undefined,
  label: string,
): readonly number[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) throw new Error(`${label}s must be an array`);
  const result = [...new Set(values)];
  for (const value of result) requirePositiveInteger(value, label);
  return Object.freeze(result.sort((left, right) => left - right));
}

function freezeBuffDefinitionIds(
  values: readonly number[] | undefined,
  owner: string,
): readonly number[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) throw new Error(`${owner} initial Buff definition IDs must be an array`);
  const result = [...new Set(values)];
  for (const value of result) {
    requirePositiveInteger(value, `${owner} initial Buff definition ID`);
  }
  return Object.freeze(result.sort((left, right) => left - right));
}

function freezeSpawn(spawn: MonsterContentSpawn): Readonly<MonsterContentSpawn> {
  if (!spawn || typeof spawn !== "object") throw new Error("monster spawn must be an object");
  requirePositiveInteger(spawn.id, "monster spawn id");
  requirePositiveInteger(spawn.monsterDefinitionId, `monster spawn ${spawn.id} definition id`);
  const presentationStateId = spawn.presentationStateId;
  if (presentationStateId !== undefined) {
    requireNonNegativeInteger(
      presentationStateId,
      `monster spawn ${spawn.id} presentation state id`,
    );
  }
  const initialBuffDefinitionIds = freezeBuffDefinitionIds(
    spawn.initialBuffDefinitionIds,
    `monster spawn ${spawn.id}`,
  );
  for (const [label, value] of [
    ["x", spawn.spawnX],
    ["y", spawn.spawnY],
    ["z", spawn.spawnZ],
    ["yaw", spawn.spawnYaw],
  ] as const) {
    if (!Number.isFinite(value)) throw new Error(`monster spawn ${spawn.id} ${label} must be finite`);
  }
  if (typeof spawn.initialSpawn !== "boolean") {
    throw new Error(`monster spawn ${spawn.id} initial spawn must be boolean`);
  }
  requireNonNegativeInteger(spawn.respawnSeconds, `monster spawn ${spawn.id} respawn seconds`);
  const wanderRadius = spawn.wanderRadius ?? 0;
  requireNonNegativeFinite(wanderRadius, `monster spawn ${spawn.id} wander radius`);
  const wanderMoveSpeed = spawn.wanderMoveSpeed;
  if (wanderMoveSpeed !== undefined) {
    requirePositiveFinite(wanderMoveSpeed, `monster spawn ${spawn.id} wander move speed`);
  }
  const wanderSchedule = freezeWanderSchedule(spawn.id, wanderRadius, spawn.wanderSchedule);
  const waypoints = freezeWaypoints(spawn.id, spawn.waypoints);
  const behaviorRules = freezeBehaviorRules(spawn.behaviorRules, `monster spawn ${spawn.id}`);
  const idleSequences = freezeIdleSequences(spawn.id, spawn.idleSequences);
  return Object.freeze({
    id: spawn.id,
    monsterDefinitionId: spawn.monsterDefinitionId,
    ...(presentationStateId === undefined ? {} : { presentationStateId }),
    ...(initialBuffDefinitionIds === undefined ? {} : { initialBuffDefinitionIds }),
    spawnX: spawn.spawnX,
    spawnY: spawn.spawnY,
    spawnZ: spawn.spawnZ,
    spawnYaw: spawn.spawnYaw,
    initialSpawn: spawn.initialSpawn,
    respawnSeconds: spawn.respawnSeconds,
    ...(wanderRadius === 0 ? {} : { wanderRadius }),
    ...(wanderMoveSpeed === undefined ? {} : { wanderMoveSpeed }),
    ...(wanderSchedule === undefined ? {} : { wanderSchedule }),
    ...(waypoints.length === 0 ? {} : { waypoints }),
    ...(spawn.behaviorRules === undefined ? {} : { behaviorRules }),
    ...(idleSequences.length === 0 ? {} : { idleSequences }),
  });
}

function freezeWanderSchedule(
  spawnId: number,
  wanderRadius: number,
  value: Readonly<MonsterContentWanderSchedule> | undefined,
): Readonly<MonsterContentWanderSchedule> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") {
    throw new Error(`monster spawn ${spawnId} wander schedule must be an object`);
  }
  if (wanderRadius <= 0) {
    throw new Error(`monster spawn ${spawnId} wander schedule requires a positive wander radius`);
  }
  requireNonNegativeInteger(value.initialDelayMinMs, `monster spawn ${spawnId} initial wander delay minimum`);
  requireNonNegativeInteger(value.initialDelayMaxMs, `monster spawn ${spawnId} initial wander delay maximum`);
  requireNonNegativeInteger(value.pauseMinMs, `monster spawn ${spawnId} wander pause minimum`);
  requireNonNegativeInteger(value.pauseMaxMs, `monster spawn ${spawnId} wander pause maximum`);
  if (value.initialDelayMinMs > value.initialDelayMaxMs) {
    throw new Error(`monster spawn ${spawnId} initial wander delay range is reversed`);
  }
  if (value.pauseMinMs > value.pauseMaxMs) {
    throw new Error(`monster spawn ${spawnId} wander pause range is reversed`);
  }
  requirePermille(
    value.firstLegPauseChancePermille,
    `monster spawn ${spawnId} first wander leg pause chance`,
  );
  requirePermille(
    value.additionalLegPauseChancePermille,
    `monster spawn ${spawnId} additional wander leg pause chance`,
  );
  return Object.freeze({
    initialDelayMinMs: value.initialDelayMinMs,
    initialDelayMaxMs: value.initialDelayMaxMs,
    pauseMinMs: value.pauseMinMs,
    pauseMaxMs: value.pauseMaxMs,
    firstLegPauseChancePermille: value.firstLegPauseChancePermille,
    additionalLegPauseChancePermille: value.additionalLegPauseChancePermille,
  });
}

function freezeIdleSequences(
  spawnId: number,
  values: readonly MonsterContentIdleSequence[] | undefined,
): readonly Readonly<MonsterContentIdleSequence>[] {
  if (values === undefined) return Object.freeze([]);
  if (!Array.isArray(values)) throw new Error(`monster spawn ${spawnId} idle sequences must be an array`);
  const sequenceIds = new Set<number>();
  return Object.freeze(values.map((sequence, sequenceIndex) => {
    if (!sequence || typeof sequence !== "object") {
      throw new Error(`monster spawn ${spawnId} idle sequence ${sequenceIndex} must be an object`);
    }
    requirePositiveInteger(sequence.id, `monster spawn ${spawnId} idle sequence id`);
    if (sequenceIds.has(sequence.id)) {
      throw new Error(`monster spawn ${spawnId} idle sequence ${sequence.id} is duplicated`);
    }
    sequenceIds.add(sequence.id);
    requirePermille(sequence.chancePermille, `monster spawn ${spawnId} idle sequence ${sequence.id} chance`);
    requireNonNegativeInteger(
      sequence.initialDelayMinMs,
      `monster spawn ${spawnId} idle sequence ${sequence.id} initial minimum delay`,
    );
    requireNonNegativeInteger(
      sequence.initialDelayMaxMs,
      `monster spawn ${spawnId} idle sequence ${sequence.id} initial maximum delay`,
    );
    requirePositiveInteger(
      sequence.repeatDelayMinMs,
      `monster spawn ${spawnId} idle sequence ${sequence.id} repeat minimum delay`,
    );
    requirePositiveInteger(
      sequence.repeatDelayMaxMs,
      `monster spawn ${spawnId} idle sequence ${sequence.id} repeat maximum delay`,
    );
    if (sequence.initialDelayMinMs > sequence.initialDelayMaxMs) {
      throw new Error(`monster spawn ${spawnId} idle sequence ${sequence.id} initial delay is inverted`);
    }
    if (sequence.repeatDelayMinMs > sequence.repeatDelayMaxMs) {
      throw new Error(`monster spawn ${spawnId} idle sequence ${sequence.id} repeat delay is inverted`);
    }
    if (!Array.isArray(sequence.actions) || sequence.actions.length === 0) {
      throw new Error(`monster spawn ${spawnId} idle sequence ${sequence.id} must contain actions`);
    }
    const actionIds = new Set<number>();
    const actions: Readonly<MonsterContentIdleAction>[] = sequence.actions.map((
      action: MonsterContentIdleAction,
      actionIndex: number,
    ) => {
      const owner = `monster spawn ${spawnId} idle sequence ${sequence.id} action ${actionIndex}`;
      if (!action || typeof action !== "object") throw new Error(`${owner} must be an object`);
      requirePositiveInteger(action.id, `${owner} id`);
      if (actionIds.has(action.id)) throw new Error(`${owner} id ${action.id} is duplicated`);
      actionIds.add(action.id);
      if (
        action.type !== MonsterContentIdleActionType.Emote
        && action.type !== MonsterContentIdleActionType.Say
      ) {
        throw new Error(`${owner} type is unsupported`);
      }
      if (
        action.target !== MonsterContentIdleActionTarget.Self
        && action.target !== MonsterContentIdleActionTarget.StableSpawn
      ) throw new Error(`${owner} target is unsupported`);
      requireNonNegativeInteger(action.delayMs, `${owner} delay`);
      if (action.delayMs > sequence.repeatDelayMinMs) {
        throw new Error(`${owner} delay must not exceed the minimum repeat delay`);
      }
      requirePermille(action.chancePermille, `${owner} chance`);
      let presentationId: number | undefined;
      let textChoices: readonly string[] | undefined;
      if (action.type === MonsterContentIdleActionType.Emote) {
        requirePositiveInteger(action.presentationId ?? 0, `${owner} presentation id`);
        if (action.textChoices !== undefined) {
          throw new Error(`${owner} Emote must not declare text choices`);
        }
        presentationId = action.presentationId;
      } else {
        if (action.presentationId !== undefined) {
          throw new Error(`${owner} Say must not declare a presentation id`);
        }
        if (!Array.isArray(action.textChoices) || action.textChoices.length === 0) {
          throw new Error(`${owner} Say requires text choices`);
        }
        textChoices = Object.freeze(action.textChoices.map((text, textIndex) => {
          const normalized = text?.trim();
          if (!normalized) throw new Error(`${owner} text choice ${textIndex} must not be empty`);
          return normalized;
        }));
      }
      if (action.target === MonsterContentIdleActionTarget.StableSpawn) {
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
        chancePermille: action.chancePermille,
        ...(presentationId === undefined ? {} : { presentationId }),
        ...(textChoices === undefined ? {} : { textChoices }),
      });
    }).sort((
      left: Readonly<MonsterContentIdleAction>,
      right: Readonly<MonsterContentIdleAction>,
    ) => left.delayMs - right.delayMs || left.id - right.id);
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

function freezeBehaviorRules(
  values: readonly MonsterContentBehaviorRule[] | undefined,
  owner: string,
): readonly Readonly<MonsterContentBehaviorRule>[] {
  if (values === undefined) return Object.freeze([]);
  if (!Array.isArray(values)) throw new Error(`${owner} behavior rules must be an array`);
  const ids = new Set<number>();
  return Object.freeze(values.map((rule, index) => {
    if (!rule || typeof rule !== "object") {
      throw new Error(`${owner} behavior rule ${index} must be an object`);
    }
    requirePositiveInteger(rule.id, `${owner} behavior rule id`);
    if (ids.has(rule.id)) throw new Error(`${owner} behavior rule ${rule.id} is duplicated`);
    ids.add(rule.id);
    if (
      rule.trigger !== MonsterContentBehaviorTrigger.Engage
      && rule.trigger !== MonsterContentBehaviorTrigger.HealthRange
      && rule.trigger !== MonsterContentBehaviorTrigger.AuraState
      && rule.trigger !== MonsterContentBehaviorTrigger.Death
      && rule.trigger !== MonsterContentBehaviorTrigger.CombatInterval
      && rule.trigger !== MonsterContentBehaviorTrigger.Spawned
      && rule.trigger !== MonsterContentBehaviorTrigger.ExternalSignal
    ) {
      throw new Error(`${owner} behavior rule ${rule.id} trigger is unsupported`);
    }
    if (!Number.isSafeInteger(rule.chancePermille)
      || rule.chancePermille < 0
      || rule.chancePermille > 1_000) {
      throw new Error(`${owner} behavior rule ${rule.id} chance must be 0..1000 permille`);
    }
    if (!Array.isArray(rule.actions) || rule.actions.length === 0) {
      throw new Error(`${owner} behavior rule ${rule.id} must contain actions`);
    }
    let minHealthPermille: number | undefined;
    let maxHealthPermille: number | undefined;
    let requiredBuffDefinitionId: number | undefined;
    let requiredBuffPresent: boolean | undefined;
    let requiredSignalId: number | undefined;
    let initialDelayMinMs: number | undefined;
    let initialDelayMaxMs: number | undefined;
    let repeatDelayMinMs: number | undefined;
    let repeatDelayMaxMs: number | undefined;
    if (rule.trigger === MonsterContentBehaviorTrigger.CombatInterval) {
      if (
        rule.minHealthPermille !== undefined
        || rule.maxHealthPermille !== undefined
        || rule.requiredBuffDefinitionId !== undefined
        || rule.requiredBuffPresent !== undefined
        || rule.requiredSignalId !== undefined
      ) {
        throw new Error(`${owner} behavior rule ${rule.id} interval trigger has incompatible fields`);
      }
      requireNonNegativeInteger(
        rule.initialDelayMinMs as number,
        `${owner} behavior rule ${rule.id} initial minimum delay`,
      );
      requireNonNegativeInteger(
        rule.initialDelayMaxMs as number,
        `${owner} behavior rule ${rule.id} initial maximum delay`,
      );
      requireNonNegativeInteger(
        rule.repeatDelayMinMs as number,
        `${owner} behavior rule ${rule.id} repeat minimum delay`,
      );
      requireNonNegativeInteger(
        rule.repeatDelayMaxMs as number,
        `${owner} behavior rule ${rule.id} repeat maximum delay`,
      );
      initialDelayMinMs = rule.initialDelayMinMs as number;
      initialDelayMaxMs = rule.initialDelayMaxMs as number;
      repeatDelayMinMs = rule.repeatDelayMinMs as number;
      repeatDelayMaxMs = rule.repeatDelayMaxMs as number;
      if (initialDelayMinMs > initialDelayMaxMs || repeatDelayMinMs > repeatDelayMaxMs) {
        throw new Error(`${owner} behavior rule ${rule.id} interval delay is inverted`);
      }
    } else if (rule.trigger === MonsterContentBehaviorTrigger.HealthRange) {
      minHealthPermille = rule.minHealthPermille;
      maxHealthPermille = rule.maxHealthPermille;
      requirePermille(minHealthPermille, `${owner} behavior rule ${rule.id} minimum health`);
      requirePermille(maxHealthPermille, `${owner} behavior rule ${rule.id} maximum health`);
      if (minHealthPermille > maxHealthPermille) {
        throw new Error(`${owner} behavior rule ${rule.id} health range is inverted`);
      }
      if (rule.requiredBuffDefinitionId !== undefined || rule.requiredBuffPresent !== undefined
        || rule.requiredSignalId !== undefined
        || rule.initialDelayMinMs !== undefined || rule.initialDelayMaxMs !== undefined) {
        throw new Error(`${owner} behavior rule ${rule.id} Buff-state fields require AuraState trigger`);
      }
      if ((rule.repeatDelayMinMs === undefined) !== (rule.repeatDelayMaxMs === undefined)) {
        throw new Error(`${owner} behavior rule ${rule.id} repeat delay bounds must be supplied together`);
      }
      if (rule.repeatDelayMinMs !== undefined) {
        const validatedRepeatMinMs = rule.repeatDelayMinMs;
        const validatedRepeatMaxMs = rule.repeatDelayMaxMs as number;
        requireNonNegativeInteger(
          validatedRepeatMinMs,
          `${owner} behavior rule ${rule.id} repeat minimum delay`,
        );
        requireNonNegativeInteger(
          validatedRepeatMaxMs,
          `${owner} behavior rule ${rule.id} repeat maximum delay`,
        );
        repeatDelayMinMs = validatedRepeatMinMs;
        repeatDelayMaxMs = validatedRepeatMaxMs;
        if (validatedRepeatMinMs > validatedRepeatMaxMs) {
          throw new Error(`${owner} behavior rule ${rule.id} repeat delay is inverted`);
        }
      }
    } else if (rule.trigger === MonsterContentBehaviorTrigger.AuraState) {
      requirePositiveInteger(
        rule.requiredBuffDefinitionId ?? 0,
        `${owner} behavior rule ${rule.id} required Buff definition id`,
      );
      if (typeof rule.requiredBuffPresent !== "boolean") {
        throw new Error(`${owner} behavior rule ${rule.id} required Buff presence must be boolean`);
      }
      requiredBuffDefinitionId = rule.requiredBuffDefinitionId;
      requiredBuffPresent = rule.requiredBuffPresent;
      requireNonNegativeInteger(
        rule.repeatDelayMinMs as number,
        `${owner} behavior rule ${rule.id} repeat minimum delay`,
      );
      requireNonNegativeInteger(
        rule.repeatDelayMaxMs as number,
        `${owner} behavior rule ${rule.id} repeat maximum delay`,
      );
      const validatedRepeatMinMs = rule.repeatDelayMinMs as number;
      const validatedRepeatMaxMs = rule.repeatDelayMaxMs as number;
      repeatDelayMinMs = validatedRepeatMinMs;
      repeatDelayMaxMs = validatedRepeatMaxMs;
      if (validatedRepeatMinMs > validatedRepeatMaxMs) {
        throw new Error(`${owner} behavior rule ${rule.id} repeat delay is inverted`);
      }
      if (rule.minHealthPermille !== undefined || rule.maxHealthPermille !== undefined
        || rule.requiredSignalId !== undefined
        || rule.initialDelayMinMs !== undefined || rule.initialDelayMaxMs !== undefined) {
        throw new Error(`${owner} behavior rule ${rule.id} health bounds require HealthRange trigger`);
      }
    } else if (rule.trigger === MonsterContentBehaviorTrigger.ExternalSignal) {
      requirePositiveInteger(
        rule.requiredSignalId ?? 0,
        `${owner} behavior rule ${rule.id} required signal id`,
      );
      requiredSignalId = rule.requiredSignalId;
      requireNonNegativeInteger(
        rule.repeatDelayMinMs as number,
        `${owner} behavior rule ${rule.id} repeat minimum delay`,
      );
      requireNonNegativeInteger(
        rule.repeatDelayMaxMs as number,
        `${owner} behavior rule ${rule.id} repeat maximum delay`,
      );
      repeatDelayMinMs = rule.repeatDelayMinMs as number;
      repeatDelayMaxMs = rule.repeatDelayMaxMs as number;
      if (repeatDelayMinMs > repeatDelayMaxMs) {
        throw new Error(`${owner} behavior rule ${rule.id} repeat delay is inverted`);
      }
      if (
        rule.minHealthPermille !== undefined
        || rule.maxHealthPermille !== undefined
        || rule.requiredBuffDefinitionId !== undefined
        || rule.requiredBuffPresent !== undefined
        || rule.initialDelayMinMs !== undefined
        || rule.initialDelayMaxMs !== undefined
      ) {
        throw new Error(`${owner} behavior rule ${rule.id} external signal has incompatible fields`);
      }
    } else if (
      rule.minHealthPermille !== undefined
      || rule.maxHealthPermille !== undefined
      || rule.requiredBuffDefinitionId !== undefined
      || rule.requiredBuffPresent !== undefined
      || rule.requiredSignalId !== undefined
      || rule.initialDelayMinMs !== undefined
      || rule.initialDelayMaxMs !== undefined
      || rule.repeatDelayMinMs !== undefined
      || rule.repeatDelayMaxMs !== undefined
    ) {
      throw new Error(`${owner} behavior rule ${rule.id} trigger-specific fields are not allowed`);
    }
    const actions = Object.freeze(rule.actions.map((
      action: MonsterContentBehaviorAction,
      actionIndex: number,
    ) => (
      freezeBehaviorAction(action, `${owner} behavior rule ${rule.id} action ${actionIndex}`)
    )));
    return Object.freeze({
      id: rule.id,
      trigger: rule.trigger,
      chancePermille: rule.chancePermille,
      ...(minHealthPermille === undefined ? {} : { minHealthPermille, maxHealthPermille }),
      ...(requiredBuffDefinitionId === undefined
        ? {}
        : { requiredBuffDefinitionId, requiredBuffPresent }),
      ...(requiredSignalId === undefined ? {} : { requiredSignalId }),
      ...(initialDelayMinMs === undefined
        ? {}
        : { initialDelayMinMs, initialDelayMaxMs }),
      ...(repeatDelayMinMs === undefined
        ? {}
        : { repeatDelayMinMs, repeatDelayMaxMs }),
      actions,
    });
  }));
}

function freezeBehaviorAction(
  action: MonsterContentBehaviorAction,
  owner: string,
): Readonly<MonsterContentBehaviorAction> {
  if (!action || typeof action !== "object") throw new Error(`${owner} must be an object`);
  if (
    action.target !== MonsterContentBehaviorTarget.Self
    && action.target !== MonsterContentBehaviorTarget.CombatTarget
  ) throw new Error(`${owner} target is unsupported`);
  const requiredAbsentBuffDefinitionId = action.requiredAbsentBuffDefinitionId;
  if (requiredAbsentBuffDefinitionId !== undefined) {
    requirePositiveInteger(requiredAbsentBuffDefinitionId, `${owner} required absent Buff id`);
  }
  const condition = requiredAbsentBuffDefinitionId === undefined
    ? {}
    : { requiredAbsentBuffDefinitionId };
  if (action.type === MonsterContentBehaviorActionType.Say) {
    if (!Array.isArray(action.textChoices) || action.textChoices.length === 0) {
      throw new Error(`${owner} Say requires text choices`);
    }
    const textChoices = Object.freeze(action.textChoices.map((text, index) => {
      const value = text?.trim();
      if (!value) throw new Error(`${owner} text choice ${index} must not be empty`);
      return value;
    }));
    return Object.freeze({ type: action.type, target: action.target, ...condition, textChoices });
  }
  if (action.type === MonsterContentBehaviorActionType.Emote) {
    requirePositiveInteger(action.presentationId ?? 0, `${owner} presentation id`);
    return Object.freeze({
      type: action.type,
      target: action.target,
      ...condition,
      presentationId: action.presentationId,
    });
  }
  if (action.type === MonsterContentBehaviorActionType.ApplyBuff) {
    requirePositiveInteger(action.buffDefinitionId ?? 0, `${owner} Buff definition id`);
    requireNonNegativeInteger(action.sourceAbilityId ?? 0, `${owner} source ability id`);
    return Object.freeze({
      type: action.type,
      target: action.target,
      ...condition,
      buffDefinitionId: action.buffDefinitionId,
      sourceAbilityId: action.sourceAbilityId ?? 0,
    });
  }
  if (action.type === MonsterContentBehaviorActionType.ExecuteAbility) {
    requirePositiveInteger(action.abilityId ?? 0, `${owner} ability id`);
    return Object.freeze({
      type: action.type,
      target: action.target,
      ...condition,
      abilityId: action.abilityId,
    });
  }
  if (action.type === MonsterContentBehaviorActionType.Evade) {
    return Object.freeze({ type: action.type, target: action.target, ...condition });
  }
  throw new Error(`${owner} type is unsupported`);
}

function requirePermille(value: number | undefined, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1_000) {
    throw new Error(`${label} must be 0..1000 permille`);
  }
}

function freezeWaypoints(
  spawnId: number,
  values: readonly MonsterContentWaypoint[] | undefined,
): readonly Readonly<MonsterContentWaypoint>[] {
  if (values === undefined) return Object.freeze([]);
  if (!Array.isArray(values)) throw new Error(`monster spawn ${spawnId} waypoints must be an array`);
  return Object.freeze(values.map((waypoint, index) => {
    if (!waypoint || typeof waypoint !== "object") {
      throw new Error(`monster spawn ${spawnId} waypoint ${index} must be an object`);
    }
    for (const [label, value] of [
      ["x", waypoint.x],
      ["y", waypoint.y],
      ["z", waypoint.z],
    ] as const) {
      if (!Number.isFinite(value)) {
        throw new Error(`monster spawn ${spawnId} waypoint ${index} ${label} must be finite`);
      }
    }
    if (waypoint.yaw !== undefined && !Number.isFinite(waypoint.yaw)) {
      throw new Error(`monster spawn ${spawnId} waypoint ${index} yaw must be finite`);
    }
    requireNonNegativeInteger(
      waypoint.delayMs,
      `monster spawn ${spawnId} waypoint ${index} delay`,
    );
    if (waypoint.moveSpeed !== undefined) {
      requirePositiveFinite(
        waypoint.moveSpeed,
        `monster spawn ${spawnId} waypoint ${index} move speed`,
      );
    }
    const actions = freezeWaypointActions(spawnId, index, waypoint.actions);
    return Object.freeze({
      x: waypoint.x,
      y: waypoint.y,
      z: waypoint.z,
      ...(waypoint.yaw === undefined ? {} : { yaw: waypoint.yaw }),
      delayMs: waypoint.delayMs,
      ...(waypoint.moveSpeed === undefined ? {} : { moveSpeed: waypoint.moveSpeed }),
      ...(actions.length === 0 ? {} : { actions }),
    });
  }));
}

function freezeWaypointActions(
  spawnId: number,
  waypointIndex: number,
  values: readonly MonsterContentWaypointAction[] | undefined,
): readonly Readonly<MonsterContentWaypointAction>[] {
  if (values === undefined) return Object.freeze([]);
  if (!Array.isArray(values)) {
    throw new Error(`monster spawn ${spawnId} waypoint ${waypointIndex} actions must be an array`);
  }
  const ids = new Set<number>();
  const actions = values.map((action, actionIndex) => {
    const owner = `monster spawn ${spawnId} waypoint ${waypointIndex} action ${actionIndex}`;
    if (!action || typeof action !== "object") throw new Error(`${owner} must be an object`);
    requirePositiveInteger(action.id, `${owner} id`);
    if (ids.has(action.id)) throw new Error(`${owner} id ${action.id} is duplicated`);
    ids.add(action.id);
    requireNonNegativeInteger(action.delayMs, `${owner} delay`);
    if (!Number.isSafeInteger(action.chancePermille)
      || action.chancePermille < 0
      || action.chancePermille > 1_000) {
      throw new Error(`${owner} chance must be 0..1000 permille`);
    }
    const common = {
      id: action.id,
      type: action.type,
      delayMs: action.delayMs,
      chancePermille: action.chancePermille,
    };
    if (action.type === MonsterContentWaypointActionType.SetEmoteState) {
      requireNonNegativeInteger(action.presentationId ?? -1, `${owner} presentation id`);
      return Object.freeze({ ...common, presentationId: action.presentationId });
    }
    if (action.type === MonsterContentWaypointActionType.SetModel) {
      const modelId = action.modelId?.trim();
      if (!modelId) throw new Error(`${owner} model id must not be empty`);
      return Object.freeze({ ...common, modelId });
    }
    if (action.type === MonsterContentWaypointActionType.BeginWander) {
      requirePositiveFinite(action.wanderRadius ?? 0, `${owner} wander radius`);
      return Object.freeze({ ...common, wanderRadius: action.wanderRadius });
    }
    if (action.type === MonsterContentWaypointActionType.RestartRoute) {
      return Object.freeze(common);
    }
    throw new Error(`${owner} type is unsupported`);
  });
  return Object.freeze(actions.sort((left, right) => (
    left.delayMs - right.delayMs || left.id - right.id
  )));
}

function requireOwnerId(value: string): string {
  const owner = value?.trim();
  if (!owner) throw new Error("monster content owner id must not be empty");
  return owner;
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
}

function requireNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must not be negative`);
}

function requirePositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
}

function requireNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must not be negative`);
}
