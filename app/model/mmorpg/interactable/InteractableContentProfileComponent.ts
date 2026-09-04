import { Component, component } from "../../../core/public";

/** 可交互物体发放的中立道具奖励；任务进度由当前活动目标自动派生。 / Neutral item reward whose quest progress is derived from active objectives. */
export interface InteractableContentRewardDefinition {
  readonly itemConfigId: number;
  readonly count: number;
}

/** 模块提供的中立可交互物体定义，不包含任何客户端协议字段。 / Module-owned neutral interactable definition without client protocol fields. */
export interface InteractableContentDefinition {
  readonly id: number;
  readonly name: string;
  readonly presentationModelId: string;
  /** 是否允许调用权威交互事务；为false时实体只参与位置与AOI表现。 / Whether authoritative interaction transactions are allowed; false keeps the entity presentation-only in position and AOI. */
  readonly interactionEnabled?: boolean;
  /** Core 校验可用性与距离后请求的可选模块动作。/ Optional module-owned action requested after Core validates availability and range. */
  readonly interactionActionId?: number;
  readonly useRangeMeters: number;
  readonly respawnDelayMs: number;
  /** 可选的中立概率掉落表；表行由 LootContentProfileComponent 独立注册。 / Optional neutral probability loot table registered separately by LootContentProfileComponent. */
  readonly lootTableId?: number;
  /** 交互时发出的中立任务目标。 / Optional neutral quest target emitted when this interactable is used. */
  readonly questObjectiveTargetConfigId?: number;
  /** 成功交互所要求并推进的通用熟练度。/ Generic proficiency required and advanced by a successful interaction. */
  readonly proficiencyId?: number;
  readonly requiredProficiencyRank?: number;
  readonly proficiencyGain?: number;
  readonly rewards: readonly InteractableContentRewardDefinition[];
  /** 作为任务来源时提供的中立任务配置。 / Neutral quest configurations offered when this object acts as a quest source. */
  readonly questStarterConfigIds?: readonly number[];
}

/** 可逆的低频可交互物内容增量。 / Reversible low-frequency interactable content delta. */
export interface InteractableRuntimeContentPatch {
  readonly questStarterConfigIds?: readonly number[];
}

export function NormalizeInteractableRuntimeContentPatch(
  patch: InteractableRuntimeContentPatch,
): Readonly<InteractableRuntimeContentPatch> {
  if (!patch || typeof patch !== "object") {
    throw new Error("interactable runtime content patch must be an object");
  }
  return Object.freeze({
    questStarterConfigIds: freezeRuntimePositiveIds(
      patch.questStarterConfigIds ?? [],
      "interactable runtime quest starter",
    ),
  });
}

/** 稳定可交互物体刷点；运行实体仍由地图生命周期拥有。 / Stable interactable spawn whose runtime Unit remains map-owned. */
export interface InteractableContentSpawn {
  readonly id: number;
  readonly interactableDefinitionId: number;
  readonly spawnX: number;
  readonly spawnY: number;
  readonly spawnZ: number;
  readonly spawnYaw: number;
  readonly initialSpawn: boolean;
}

export interface InteractableContentRegistration {
  readonly definitions: readonly InteractableContentDefinition[];
  readonly spawns: readonly InteractableContentSpawn[];
}

/**
 * 地图发布前由外置模块原子注册并冻结可交互物体资料；目录不认识来源数据库或游戏协议。
 * External modules atomically register and seal interactable content before map publication;
 * the catalog knows neither source databases nor game protocols.
 */
@component()
export class InteractableContentProfileComponent extends Component {
  private readonly definitions = new Map<number, Readonly<InteractableContentDefinition>>();
  private readonly definitionOwners = new Map<number, string>();
  private readonly spawns = new Map<number, Readonly<InteractableContentSpawn>>();
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

  /** 声明由一个完整外置内容包替换演示物体。 / Claims replacement of demo interactables for one complete external package. */
  ReplaceColdContent(ownerId: string): void {
    if (this.sealed) throw new Error("interactable content profile is sealed");
    const owner = requireOwnerId(ownerId);
    if (this.coldContentReplacementOwner) {
      throw new Error(
        `cold interactable content already belongs to ${this.coldContentReplacementOwner}`,
      );
    }
    this.coldContentReplacementOwner = owner;
  }

  /** 完整校验后一次发布定义和刷点，失败时不留下部分目录。 / Validates and publishes definitions and spawns atomically. */
  Register(ownerId: string, registration: InteractableContentRegistration): void {
    if (this.sealed) throw new Error("interactable content profile is sealed");
    const owner = requireOwnerId(ownerId);
    if (!registration || typeof registration !== "object") {
      throw new Error("interactable content registration must be an object");
    }
    if (!Array.isArray(registration.definitions) || !Array.isArray(registration.spawns)) {
      throw new Error("interactable content registration requires definition and spawn arrays");
    }

    const pendingDefinitions = new Map<number, Readonly<InteractableContentDefinition>>();
    for (const definition of registration.definitions) {
      const frozen = freezeDefinition(definition);
      if (this.definitions.has(frozen.id) || pendingDefinitions.has(frozen.id)) {
        const previousOwner = this.definitionOwners.get(frozen.id) ?? owner;
        throw new Error(`interactable definition ${frozen.id} already belongs to ${previousOwner}`);
      }
      pendingDefinitions.set(frozen.id, frozen);
    }

    const pendingSpawns = new Map<number, Readonly<InteractableContentSpawn>>();
    for (const spawn of registration.spawns) {
      const frozen = freezeSpawn(spawn);
      if (this.spawns.has(frozen.id) || pendingSpawns.has(frozen.id)) {
        const previousOwner = this.spawnOwners.get(frozen.id) ?? owner;
        throw new Error(`interactable spawn ${frozen.id} already belongs to ${previousOwner}`);
      }
      const definitionOwner = this.definitionOwners.get(frozen.interactableDefinitionId);
      if (definitionOwner && definitionOwner !== owner) {
        throw new Error(
          `interactable spawn ${frozen.id} cannot reference definition ${frozen.interactableDefinitionId} owned by ${definitionOwner}`,
        );
      }
      if (!pendingDefinitions.has(frozen.interactableDefinitionId) && definitionOwner !== owner) {
        throw new Error(
          `interactable spawn ${frozen.id} references missing definition ${frozen.interactableDefinitionId}`,
        );
      }
      pendingSpawns.set(frozen.id, frozen);
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

  TryGetDefinition(id: number): Readonly<InteractableContentDefinition> | undefined {
    return this.definitions.get(id);
  }

  GetDefinitions(): readonly Readonly<InteractableContentDefinition>[] {
    return Object.freeze([...this.definitions.values()].sort((left, right) => left.id - right.id));
  }

  GetSpawns(): readonly Readonly<InteractableContentSpawn>[] {
    return Object.freeze([...this.spawns.values()].sort((left, right) => left.id - right.id));
  }

  get ColdContentReplacementOwner(): string | undefined {
    return this.coldContentReplacementOwner || undefined;
  }
}

function freezeDefinition(
  definition: InteractableContentDefinition,
): Readonly<InteractableContentDefinition> {
  if (!definition || typeof definition !== "object") {
    throw new Error("interactable definition must be an object");
  }
  requirePositiveInteger(definition.id, "interactable definition id");
  const name = definition.name?.trim();
  if (!name) throw new Error(`interactable definition ${definition.id} name must not be empty`);
  const presentationModelId = definition.presentationModelId?.trim();
  if (!presentationModelId) {
    throw new Error(`interactable definition ${definition.id} presentation model id must not be empty`);
  }
  if (!Number.isFinite(definition.useRangeMeters) || definition.useRangeMeters <= 0) {
    throw new Error(`interactable definition ${definition.id} use range must be positive`);
  }
  requireNonNegativeInteger(
    definition.respawnDelayMs,
    `interactable definition ${definition.id} respawn delay`,
  );
  const questObjectiveTargetConfigId = definition.questObjectiveTargetConfigId;
  const lootTableId = definition.lootTableId;
  const proficiencyId = definition.proficiencyId;
  const requiredProficiencyRank = definition.requiredProficiencyRank ?? 0;
  const proficiencyGain = definition.proficiencyGain ?? 0;
  const questStarterConfigIds = freezeRuntimePositiveIds(
    definition.questStarterConfigIds ?? [],
    `interactable definition ${definition.id} quest starter`,
  );
  const interactionEnabled = definition.interactionEnabled ?? true;
  const interactionActionId = definition.interactionActionId;
  if (typeof interactionEnabled !== "boolean") {
    throw new Error(`interactable definition ${definition.id} interactionEnabled must be boolean`);
  }
  if (
    interactionActionId !== undefined
    && (!Number.isSafeInteger(interactionActionId) || interactionActionId <= 0)
  ) {
    throw new Error(`interactable definition ${definition.id} action id must be positive`);
  }
  if (
    lootTableId !== undefined
    && (!Number.isSafeInteger(lootTableId) || lootTableId <= 0)
  ) {
    throw new Error(`interactable definition ${definition.id} loot table id must be positive`);
  }
  if (
    proficiencyId !== undefined &&
    (!Number.isSafeInteger(proficiencyId) || proficiencyId <= 0)
  ) {
    throw new Error(`interactable definition ${definition.id} proficiency id must be positive`);
  }
  requireNonNegativeInteger(
    requiredProficiencyRank,
    `interactable definition ${definition.id} required proficiency rank`,
  );
  requireNonNegativeInteger(
    proficiencyGain,
    `interactable definition ${definition.id} proficiency gain`,
  );
  if (
    (proficiencyId === undefined && (requiredProficiencyRank !== 0 || proficiencyGain !== 0)) ||
    (proficiencyId !== undefined && requiredProficiencyRank <= 0)
  ) {
    throw new Error(`interactable definition ${definition.id} has invalid proficiency rules`);
  }
  if (
    questObjectiveTargetConfigId !== undefined
    && (!Number.isSafeInteger(questObjectiveTargetConfigId) || questObjectiveTargetConfigId <= 0)
  ) {
    throw new Error(
      `interactable definition ${definition.id} quest objective target config id must be positive`,
    );
  }
  if (!Array.isArray(definition.rewards)) {
    throw new Error(`interactable definition ${definition.id} rewards must be an array`);
  }
  const hasInteraction = definition.rewards.length > 0
    || questObjectiveTargetConfigId !== undefined
    || lootTableId !== undefined
    || questStarterConfigIds.length > 0
    || interactionActionId !== undefined;
  const hasDurableInteraction = definition.rewards.length > 0
    || questObjectiveTargetConfigId !== undefined
    || lootTableId !== undefined
    || questStarterConfigIds.length > 0
    || proficiencyId !== undefined;
  if (interactionActionId !== undefined && hasDurableInteraction) {
    throw new Error(
      `interactable definition ${definition.id} action cannot share durable reward declarations`,
    );
  }
  if (!interactionEnabled && hasInteraction) {
    throw new Error(
      `interactable definition ${definition.id} cannot disable declared gameplay interactions`,
    );
  }
  if (definition.interactionEnabled === undefined && !hasInteraction) {
    throw new Error(
      `interactable definition ${definition.id} must explicitly disable interaction when it has no gameplay declarations`,
    );
  }
  const rewards = new Map<number, number>();
  for (const reward of definition.rewards) {
    requirePositiveInteger(
      reward.itemConfigId,
      `interactable definition ${definition.id} reward item config id`,
    );
    requirePositiveInteger(
      reward.count,
      `interactable definition ${definition.id} reward count`,
    );
    const count = (rewards.get(reward.itemConfigId) ?? 0) + reward.count;
    if (!Number.isSafeInteger(count)) {
      throw new Error(`interactable definition ${definition.id} reward count exceeds safe integer`);
    }
    rewards.set(reward.itemConfigId, count);
  }
  return Object.freeze({
    id: definition.id,
    name,
    presentationModelId,
    interactionEnabled,
    ...(interactionActionId === undefined ? {} : { interactionActionId }),
    useRangeMeters: definition.useRangeMeters,
    respawnDelayMs: definition.respawnDelayMs,
    ...(lootTableId === undefined ? {} : { lootTableId }),
    ...(questObjectiveTargetConfigId === undefined ? {} : { questObjectiveTargetConfigId }),
    ...(proficiencyId === undefined ? {} : {
      proficiencyId,
      requiredProficiencyRank,
      proficiencyGain,
    }),
    rewards: Object.freeze(
      [...rewards]
        .sort(([left], [right]) => left - right)
        .map(([itemConfigId, count]) => Object.freeze({ itemConfigId, count })),
    ),
    questStarterConfigIds,
  });
}

function freezeSpawn(spawn: InteractableContentSpawn): Readonly<InteractableContentSpawn> {
  if (!spawn || typeof spawn !== "object") throw new Error("interactable spawn must be an object");
  requirePositiveInteger(spawn.id, "interactable spawn id");
  requirePositiveInteger(
    spawn.interactableDefinitionId,
    `interactable spawn ${spawn.id} definition id`,
  );
  for (const [label, value] of [
    ["x", spawn.spawnX],
    ["y", spawn.spawnY],
    ["z", spawn.spawnZ],
    ["yaw", spawn.spawnYaw],
  ] as const) {
    if (!Number.isFinite(value)) throw new Error(`interactable spawn ${spawn.id} ${label} must be finite`);
  }
  if (typeof spawn.initialSpawn !== "boolean") {
    throw new Error(`interactable spawn ${spawn.id} initialSpawn must be boolean`);
  }
  return Object.freeze({
    id: spawn.id,
    interactableDefinitionId: spawn.interactableDefinitionId,
    spawnX: spawn.spawnX,
    spawnY: spawn.spawnY,
    spawnZ: spawn.spawnZ,
    spawnYaw: spawn.spawnYaw,
    initialSpawn: spawn.initialSpawn,
  });
}

function requireOwnerId(value: string): string {
  const owner = value?.trim();
  if (!owner) throw new Error("interactable content owner id must not be empty");
  return owner;
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
}

function requireNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must not be negative`);
}

function freezeRuntimePositiveIds(values: readonly number[], label: string): readonly number[] {
  if (!Array.isArray(values)) throw new Error(`${label} IDs must be an array`);
  const result = [...new Set(values)];
  for (const value of result) requirePositiveInteger(value, `${label} ID`);
  return Object.freeze(result.sort((left, right) => left - right));
}
