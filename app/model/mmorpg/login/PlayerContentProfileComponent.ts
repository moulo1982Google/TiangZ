import { Component, component } from "../../../core/public";
import type { InventorySeed } from "../../domains/item/ItemTypes";

/** 外置游戏包登记的中立玩家模板身份；具体种族、职业和表现规则仍属于模块。 / Neutral player-template identity registered by an external game package; race, class, and presentation remain module-owned. */
export interface PlayerContentNumericDefinition {
  readonly numericType: number;
  readonly value: number;
}

/** 由数据持有的累计经验曲线，以及单级可选的中立Numeric值。 / A data-owned cumulative experience curve and optional neutral Numeric values for one level. */
export interface PlayerProgressionLevelDefinition {
  readonly level: number;
  readonly experienceToNextLevel: number;
  readonly numerics: readonly PlayerContentNumericDefinition[];
}

/** 控制内容包如何接纳持久状态为死亡的玩家。 / Controls how a content package admits a player whose persisted state is dead. */
export type DeadPlayerAdmissionPolicy = "revive-at-spawn" | "preserve";

export interface PlayerContentDefinition {
  readonly id: number;
  /** 仅在全新玩家聚合体创建时发放一次的中立物品实例。 / Neutral item instances seeded exactly once for a newly created player aggregate. */
  readonly initialItems?: readonly InventorySeed[];
  /** 被环境击败时对已放置耐久物品应用的千分比损耗。 / Permille durability loss applied to placed durable items when the environment defeats the player. */
  readonly deathDurabilityLossPermille?: number;
  /** 新玩家聚合体装配时仅发放一次的技能。 / Skills granted exactly once when a new player aggregate is composed. */
  readonly initialSkillConfigIds?: readonly number[];
  /** 内容所有者拥有的接纳策略；Core不推断特定游戏的尸体规则。 / Content-owned admission policy; Core does not infer game-specific corpse rules. */
  readonly deadAdmissionPolicy?: DeadPlayerAdmissionPolicy;
  /** 由模块持有的可选曲线；TiangZ只解释累计经验和Numeric编号。 / Optional module-owned curve; TiangZ only interprets cumulative XP and Numeric IDs. */
  readonly progressionLevels?: readonly PlayerProgressionLevelDefinition[];
}

/**
 * Login创建角色时使用的外置玩家模板目录。目录只扩展可接受的稳定模板ID，
 * 不复制冷PlayerConfig，也不把具体游戏职业字段放进TiangZ。
 *
 * External player-template catalog used during character creation. It extends
 * accepted stable IDs without copying cold PlayerConfig rows or introducing
 * game-specific class fields into TiangZ.
 */
@component()
export class PlayerContentProfileComponent extends Component {
  private readonly definitions = new Map<number, Readonly<PlayerContentDefinition>>();
  private readonly owners = new Map<number, string>();
  private sealed = false;

  get Count(): number {
    return this.definitions.size;
  }

  /** 先完整校验再发布，冲突或非法ID不会留下半份目录。 / Validates the whole registration before atomically publishing it. */
  Register(ownerId: string, definitions: readonly PlayerContentDefinition[]): void {
    if (this.sealed) throw new Error("player content profile is sealed");
    const owner = requireOwnerId(ownerId);
    if (!Array.isArray(definitions)) throw new Error("player content definitions must be an array");
    const pending = new Map<number, Readonly<PlayerContentDefinition>>();
    for (const definition of definitions) {
      if (!definition || typeof definition !== "object") {
        throw new Error("player content definition must be an object");
      }
      if (!Number.isSafeInteger(definition.id) || definition.id <= 0) {
        throw new Error("player content definition id must be positive");
      }
      if (this.definitions.has(definition.id) || pending.has(definition.id)) {
        const previousOwner = this.owners.get(definition.id) ?? owner;
        throw new Error(`player content ${definition.id} already belongs to ${previousOwner}`);
      }
      const initialSkillConfigIds = [
        ...new Set<number>((definition as PlayerContentDefinition).initialSkillConfigIds ?? []),
      ];
      const initialItems = freezeInitialItems(definition.initialItems ?? [], definition.id);
      const deathDurabilityLossPermille = definition.deathDurabilityLossPermille ?? 0;
      if (
        !Number.isSafeInteger(deathDurabilityLossPermille) ||
        deathDurabilityLossPermille < 0 ||
        deathDurabilityLossPermille > 1_000
      ) {
        throw new Error(`player content ${definition.id} death durability loss must be 0..1000 permille`);
      }
      for (const skillConfigId of initialSkillConfigIds) {
        if (!Number.isSafeInteger(skillConfigId) || skillConfigId <= 0) {
          throw new Error(
            `player content ${definition.id} initial skill id must be positive`,
          );
        }
      }
      const progressionLevels = freezeProgressionLevels(
        definition.progressionLevels ?? [],
        definition.id,
      );
      const deadAdmissionPolicy = definition.deadAdmissionPolicy ?? "revive-at-spawn";
      if (deadAdmissionPolicy !== "revive-at-spawn" && deadAdmissionPolicy !== "preserve") {
        throw new Error(
          `player content ${definition.id} dead admission policy must be revive-at-spawn or preserve`,
        );
      }
      pending.set(definition.id, Object.freeze({
        id: definition.id,
        initialItems,
        deathDurabilityLossPermille,
        initialSkillConfigIds: Object.freeze(initialSkillConfigIds.sort(numberSort)),
        deadAdmissionPolicy,
        progressionLevels,
      }));
    }
    for (const [id, definition] of pending) {
      this.definitions.set(id, definition);
      this.owners.set(id, owner);
    }
  }

  Seal(): void {
    this.sealed = true;
  }

  IsRegistered(id: number): boolean {
    return this.definitions.has(id);
  }

  TryGet(id: number): Readonly<PlayerContentDefinition> | undefined {
    return this.definitions.get(id);
  }

  OwnerOf(id: number): string | undefined {
    return this.owners.get(id);
  }

  GetDefinitions(): readonly Readonly<PlayerContentDefinition>[] {
    return Object.freeze([...this.definitions.values()].sort((left, right) => left.id - right.id));
  }
}

/** 校验并冻结模块提供的一次性物品种子。 / Validates and freezes module-provided one-time item seeds. */
function freezeInitialItems(
  values: readonly InventorySeed[],
  playerContentId: number,
): readonly Readonly<Required<InventorySeed>>[] {
  if (!Array.isArray(values)) {
    throw new Error(`player content ${playerContentId} initial items must be an array`);
  }
  const placements = new Set<number>();
  return Object.freeze(values.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`player content ${playerContentId} initial item must be an object`);
    }
    if (!Number.isSafeInteger(entry.configId) || entry.configId <= 0) {
      throw new Error(`player content ${playerContentId} initial item id must be positive`);
    }
    if (!Number.isSafeInteger(entry.count) || entry.count <= 0) {
      throw new Error(`player content ${playerContentId} initial item count must be positive`);
    }
    const placementId = entry.placementId ?? 0;
    if (!Number.isSafeInteger(placementId) || placementId < 0) {
      throw new Error(`player content ${playerContentId} initial item placement must not be negative`);
    }
    if (placementId > 0 && placements.has(placementId)) {
      throw new Error(`player content ${playerContentId} contains duplicate placement ${placementId}`);
    }
    if (placementId > 0) placements.add(placementId);
    return Object.freeze({
      configId: entry.configId,
      count: entry.count,
      placementId,
    });
  }));
}

function freezeProgressionLevels(
  values: readonly PlayerProgressionLevelDefinition[],
  playerContentId: number,
): readonly Readonly<PlayerProgressionLevelDefinition>[] {
  if (!Array.isArray(values)) {
    throw new Error(`player content ${playerContentId} progression levels must be an array`);
  }
  return Object.freeze(values.map((entry, index) => {
    if (!entry || typeof entry !== "object" || entry.level !== index + 1) {
      throw new Error(
        `player content ${playerContentId} progression levels must be contiguous from level 1`,
      );
    }
    if (!Number.isSafeInteger(entry.experienceToNextLevel) || entry.experienceToNextLevel < 0) {
      throw new Error(
        `player content ${playerContentId} level ${entry.level} experience must be non-negative`,
      );
    }
    if (index + 1 < values.length && entry.experienceToNextLevel === 0) {
      throw new Error(
        `player content ${playerContentId} level ${entry.level} must require experience`,
      );
    }
    if (index + 1 === values.length && entry.experienceToNextLevel !== 0) {
      throw new Error(
        `player content ${playerContentId} final level must have zero next-level experience`,
      );
    }
    if (!Array.isArray(entry.numerics)) {
      throw new Error(`player content ${playerContentId} level ${entry.level} numerics must be an array`);
    }
    const numericTypes = new Set<number>();
    const numerics = (entry.numerics as readonly PlayerContentNumericDefinition[]).map((numeric) => {
      if (
        !numeric ||
        !Number.isSafeInteger(numeric.numericType) ||
        numeric.numericType <= 0 ||
        !Number.isSafeInteger(numeric.value) ||
        numeric.value < 0
      ) {
        throw new Error(`player content ${playerContentId} level ${entry.level} has invalid numeric`);
      }
      if (numericTypes.has(numeric.numericType)) {
        throw new Error(
          `player content ${playerContentId} level ${entry.level} contains duplicate numeric ${numeric.numericType}`,
        );
      }
      numericTypes.add(numeric.numericType);
      return Object.freeze({ ...numeric });
    });
    return Object.freeze({
      level: entry.level,
      experienceToNextLevel: entry.experienceToNextLevel,
      numerics: Object.freeze(numerics),
    });
  }));
}

function requireOwnerId(value: string): string {
  const owner = value?.trim();
  if (!owner) throw new Error("player content owner id must not be empty");
  return owner;
}

function numberSort(left: number, right: number): number {
  return left - right;
}
