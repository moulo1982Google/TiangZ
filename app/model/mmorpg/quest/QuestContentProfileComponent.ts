import { Component, component } from "../../../core/public";
import { ActionType, type ActionDefinition } from "../action/ActionType";

/** 模块拥有、由现有任务运行时消费的中立任务目标。 / A module-owned neutral objective consumed by the existing quest runtime. */
export interface QuestContentObjectiveDefinition {
  readonly id: number;
  readonly objectiveType: number;
  readonly targetConfigId: number;
  readonly requiredCount: number;
  /** 完成任务时是否上交并移除所需背包数量。 / Whether completion delivers and removes the required inventory count. */
  readonly consumeOnComplete?: boolean;
}

export interface QuestContentExperienceRewardDefinition {
  readonly playerLevel: number;
  readonly experience: number;
}

/** 一个由调用方选择的稳定奖励分支；选择编号由内容持有且协议中立。 / One stable, caller-selected reward branch; choice IDs are content-owned and protocol-neutral. */
export interface QuestContentRewardChoiceDefinition {
  readonly id: number;
  readonly actions: readonly ActionDefinition[];
}

/** 模块拥有的中立任务定义，不包含外部数据库或客户端协议字段。 / A module-owned neutral quest definition without external database or client protocol fields. */
export interface QuestContentDefinition {
  readonly id: number;
  readonly name: string;
  readonly objectives: readonly QuestContentObjectiveDefinition[];
  readonly acceptActions: readonly ActionDefinition[];
  readonly rewardActions: readonly ActionDefinition[];
  readonly rewardChoices?: readonly QuestContentRewardChoiceDefinition[];
  readonly rewardCurrency?: number;
  readonly rewardExperience?: number;
  readonly rewardExperienceByLevel?: readonly QuestContentExperienceRewardDefinition[];
  readonly autoAccept: boolean;
  readonly requiredQuestIds: readonly number[];
  readonly minimumLevel: number;
  /** 省略时表示全部玩家模板；提供时是完整稳定编号允许列表。 / Omitted means all player templates; a present list is the complete stable-ID allowlist. */
  readonly eligiblePlayerConfigIds?: readonly number[];
}

/**
 * 地图工厂与外置内容包之间的中立任务目录；注册只允许发生在 MapScene 发布前。
 * QuestComponent 继续拥有活动任务、进度、交付事务和持久化状态。
 *
 * Neutral quest catalog between map creation and external content packages.
 * Registration is limited to pre-publication MapScene assembly, while
 * QuestComponent retains active state, progress, reward transactions, and persistence.
 */
@component()
export class QuestContentProfileComponent extends Component {
  private readonly definitions = new Map<number, Readonly<QuestContentDefinition>>();
  private readonly definitionOwners = new Map<number, string>();
  private readonly objectives = new Map<number, Readonly<QuestContentObjectiveDefinition>>();
  private coldContentReplacementOwner = "";
  private sealed = false;

  get DefinitionCount(): number {
    return this.definitions.size;
  }

  get IncludesColdContent(): boolean {
    return this.coldContentReplacementOwner.length === 0;
  }

  /** 声明一个完整外置任务包替换演示任务。 / Claims replacement of demo quests for one complete external content package. */
  ReplaceColdContent(ownerId: string): void {
    if (this.sealed) throw new Error("quest content profile is sealed");
    const owner = requireOwnerId(ownerId);
    if (this.coldContentReplacementOwner) {
      throw new Error(
        `cold quest content already belongs to ${this.coldContentReplacementOwner}`,
      );
    }
    this.coldContentReplacementOwner = owner;
  }

  /** 完整校验后一次发布任务定义，失败时不会留下部分目录。 / Validates and publishes definitions atomically. */
  Register(ownerId: string, definitions: readonly QuestContentDefinition[]): void {
    if (this.sealed) throw new Error("quest content profile is sealed");
    const owner = requireOwnerId(ownerId);
    if (!Array.isArray(definitions)) {
      throw new Error("quest content definitions must be an array");
    }
    const pending = new Map<number, Readonly<QuestContentDefinition>>();
    const pendingObjectiveIds = new Set<number>();
    for (const definition of definitions) {
      const frozen = freezeDefinition(definition);
      if (this.definitions.has(frozen.id) || pending.has(frozen.id)) {
        const previousOwner = this.definitionOwners.get(frozen.id) ?? owner;
        throw new Error(`quest definition ${frozen.id} already belongs to ${previousOwner}`);
      }
      for (const objective of frozen.objectives) {
        if (this.objectives.has(objective.id) || pendingObjectiveIds.has(objective.id)) {
          throw new Error(`quest objective ${objective.id} is already registered`);
        }
        pendingObjectiveIds.add(objective.id);
      }
      pending.set(frozen.id, frozen);
    }
    for (const [id, definition] of pending) {
      this.definitions.set(id, definition);
      this.definitionOwners.set(id, owner);
      for (const objective of definition.objectives) this.objectives.set(objective.id, objective);
    }
  }

  Seal(): void {
    this.sealed = true;
  }

  TryGetDefinition(id: number): Readonly<QuestContentDefinition> | undefined {
    return this.definitions.get(id);
  }

  TryGetObjective(id: number): Readonly<QuestContentObjectiveDefinition> | undefined {
    return this.objectives.get(id);
  }

  GetDefinitions(): readonly Readonly<QuestContentDefinition>[] {
    return Object.freeze([...this.definitions.values()].sort((left, right) => left.id - right.id));
  }

  DefinitionOwnerOf(id: number): string | undefined {
    return this.definitionOwners.get(id);
  }

  get ColdContentReplacementOwner(): string | undefined {
    return this.coldContentReplacementOwner || undefined;
  }
}

function freezeDefinition(definition: QuestContentDefinition): Readonly<QuestContentDefinition> {
  if (!definition || typeof definition !== "object") {
    throw new Error("quest definition must be an object");
  }
  requirePositiveInteger(definition.id, "quest definition id");
  const name = definition.name?.trim();
  if (!name) throw new Error(`quest definition ${definition.id} name must not be empty`);
  if (!Array.isArray(definition.objectives)) {
    throw new Error(`quest definition ${definition.id} objectives must be an array`);
  }
  const objectiveIds = new Set<number>();
  const objectives = definition.objectives.map((objective) => {
    requirePositiveInteger(objective.id, `quest definition ${definition.id} objective id`);
    if (objectiveIds.has(objective.id)) {
      throw new Error(`quest definition ${definition.id} contains duplicate objective ${objective.id}`);
    }
    objectiveIds.add(objective.id);
    requirePositiveInteger(
      objective.objectiveType,
      `quest definition ${definition.id} objective ${objective.id} type`,
    );
    requirePositiveInteger(
      objective.targetConfigId,
      `quest definition ${definition.id} objective ${objective.id} target config id`,
    );
    requirePositiveInteger(
      objective.requiredCount,
      `quest definition ${definition.id} objective ${objective.id} required count`,
    );
    if (objective.consumeOnComplete !== undefined && typeof objective.consumeOnComplete !== "boolean") {
      throw new Error(
        `quest definition ${definition.id} objective ${objective.id} consumeOnComplete must be boolean`,
      );
    }
    return Object.freeze({
      ...objective,
      ...(objective.consumeOnComplete ? { consumeOnComplete: true } : {}),
    });
  });
  if (!Array.isArray(definition.rewardActions)) {
    throw new Error(`quest definition ${definition.id} reward actions must be an array`);
  }
  if (!Array.isArray(definition.acceptActions)) {
    throw new Error(`quest definition ${definition.id} accept actions must be an array`);
  }
  const acceptActions = definition.acceptActions.map((action) => freezeItemAction(
    action,
    definition.id,
    "accept",
  ));
  const rewardActions = definition.rewardActions.map((action) => freezeItemAction(
    action,
    definition.id,
    "reward",
  ));
  const rewardChoices = freezeRewardChoices(definition.rewardChoices ?? [], definition.id);
  const rewardCurrency = requireNonNegativeInteger(
    definition.rewardCurrency ?? 0,
    `quest definition ${definition.id} reward currency`,
  );
  const rewardExperience = requireNonNegativeInteger(
    definition.rewardExperience ?? 0,
    `quest definition ${definition.id} reward experience`,
  );
  const rewardExperienceByLevel = freezeExperienceRewards(
    definition.rewardExperienceByLevel ?? [],
    definition.id,
  );
  if (typeof definition.autoAccept !== "boolean") {
    throw new Error(`quest definition ${definition.id} autoAccept must be boolean`);
  }
  const requiredQuestIds = freezeRequiredQuestIds(definition.requiredQuestIds, definition.id);
  const eligiblePlayerConfigIds = definition.eligiblePlayerConfigIds === undefined
    ? undefined
    : freezePositiveIntegerSet(
      definition.eligiblePlayerConfigIds,
      `quest definition ${definition.id} eligible player config id`,
    );
  if (!Number.isSafeInteger(definition.minimumLevel) || definition.minimumLevel < 0) {
    throw new Error(`quest definition ${definition.id} minimum level must be a non-negative safe integer`);
  }
  return Object.freeze({
    id: definition.id,
    name,
    objectives: Object.freeze(objectives),
    acceptActions: Object.freeze(acceptActions),
    rewardActions: Object.freeze(rewardActions),
    rewardChoices,
    rewardCurrency,
    rewardExperience,
    rewardExperienceByLevel,
    autoAccept: definition.autoAccept,
    requiredQuestIds,
    minimumLevel: definition.minimumLevel,
    ...(eligiblePlayerConfigIds === undefined ? {} : { eligiblePlayerConfigIds }),
  });
}

function freezeExperienceRewards(
  values: readonly QuestContentExperienceRewardDefinition[],
  questId: number,
): readonly Readonly<QuestContentExperienceRewardDefinition>[] {
  if (!Array.isArray(values)) {
    throw new Error(`quest definition ${questId} level experience rewards must be an array`);
  }
  const levels = new Set<number>();
  return Object.freeze(values.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`quest definition ${questId} level experience reward must be an object`);
    }
    requirePositiveInteger(entry.playerLevel, `quest definition ${questId} reward player level`);
    const experience = requireNonNegativeInteger(
      entry.experience,
      `quest definition ${questId} level ${entry.playerLevel} reward experience`,
    );
    if (levels.has(entry.playerLevel)) {
      throw new Error(`quest definition ${questId} contains duplicate reward level ${entry.playerLevel}`);
    }
    levels.add(entry.playerLevel);
    return Object.freeze({ playerLevel: entry.playerLevel, experience });
  }).sort((left, right) => left.playerLevel - right.playerLevel));
}

function freezePositiveIntegerSet(values: readonly number[], label: string): readonly number[] {
  if (!Array.isArray(values)) throw new Error(`${label}s must be an array`);
  const result = [...new Set(values)];
  for (const value of result) requirePositiveInteger(value, label);
  return Object.freeze(result.sort((left, right) => left - right));
}

function freezeRewardChoices(
  values: readonly QuestContentRewardChoiceDefinition[],
  questId: number,
): readonly Readonly<QuestContentRewardChoiceDefinition>[] {
  if (!Array.isArray(values)) {
    throw new Error(`quest definition ${questId} reward choices must be an array`);
  }
  const ids = new Set<number>();
  return Object.freeze(values.map((choice) => {
    if (!choice || typeof choice !== "object") {
      throw new Error(`quest definition ${questId} reward choice must be an object`);
    }
    requirePositiveInteger(choice.id, `quest definition ${questId} reward choice id`);
    if (ids.has(choice.id)) {
      throw new Error(`quest definition ${questId} contains duplicate reward choice ${choice.id}`);
    }
    ids.add(choice.id);
    if (!Array.isArray(choice.actions) || choice.actions.length === 0) {
      throw new Error(`quest definition ${questId} reward choice ${choice.id} must contain actions`);
    }
    return Object.freeze({
      id: choice.id,
      actions: Object.freeze((choice.actions as readonly ActionDefinition[]).map((action) => freezeItemAction(
        action,
        questId,
        "reward",
      ))),
    });
  }));
}

function freezeItemAction(
  action: ActionDefinition,
  questId: number,
  phase: "accept" | "reward",
): Readonly<ActionDefinition> {
  if (!action || typeof action !== "object") {
    throw new Error(`quest definition ${questId} ${phase} action must be an object`);
  }
  if (action.type !== ActionType.GrantItem) {
    throw new Error(`quest definition ${questId} ${phase} only supports GrantItem actions`);
  }
  if (!Array.isArray(action.parameters) || action.parameters.length !== 2) {
    throw new Error(`quest definition ${questId} ${phase} GrantItem requires two parameters`);
  }
  for (const value of action.parameters) {
    if (typeof value !== "bigint" || value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`quest definition ${questId} ${phase} parameters must be positive safe integers`);
    }
  }
  return Object.freeze({ type: action.type, parameters: Object.freeze([...action.parameters]) });
}

function freezeRequiredQuestIds(values: readonly number[], questId: number): readonly number[] {
  if (!Array.isArray(values)) {
    throw new Error(`quest definition ${questId} required quest IDs must be an array`);
  }
  const result: number[] = [];
  const seen = new Set<number>();
  for (const value of values) {
    requirePositiveInteger(value, `quest definition ${questId} required quest id`);
    if (value === questId) throw new Error(`quest definition ${questId} cannot require itself`);
    if (seen.has(value)) {
      throw new Error(`quest definition ${questId} contains duplicate required quest ${value}`);
    }
    seen.add(value);
    result.push(value);
  }
  return Object.freeze(result);
}

function requireOwnerId(value: string): string {
  const owner = value?.trim();
  if (!owner) throw new Error("quest content owner id must not be empty");
  return owner;
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
}

function requireNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}
