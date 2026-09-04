import { Component, component } from "../../../core/public";

/** 外部游戏训练师目录发布的中立技能报价。 / A neutral skill offer published by an external game's trainer catalog. */
export interface TrainerSkillOfferDefinition {
  readonly skillConfigId: number;
  /** 课程成功后实际加入玩家技能集合的技能；省略时默认授予报价技能本身。/ Skills actually added after learning; omission defaults to the offered skill itself. */
  readonly grantedSkillConfigIds?: readonly number[];
  readonly price: number;
  readonly requiredLevel: number;
  readonly requiredSkillLineId: number;
  readonly requiredSkillRank: number;
  readonly prerequisiteSkillConfigIds: readonly number[];
  /** 此课程可选解锁或升级的通用熟练度。/ Optional generic proficiency unlocked or upgraded by this offer. */
  readonly grantedProficiencyId?: number;
  readonly grantedProficiencyMinimumRank?: number;
  readonly grantedProficiencyMaximumRank?: number;
}

/** 由模块持有、通过训练师编号关联NPC定义的训练师元数据。 / Module-owned trainer metadata linked from an NPC definition by trainer ID. */
export interface TrainerContentDefinition {
  readonly id: number;
  readonly kind: number;
  readonly requirementId: number;
  readonly greeting: string;
  /** 为空时把玩家模板资格判定委托给外部适配器。 / Empty means that player-template eligibility is delegated to the external adapter. */
  readonly eligiblePlayerConfigIds?: readonly number[];
  readonly offers: readonly TrainerSkillOfferDefinition[];
}

/**
 * 地图场景发布前组装的不可变训练师目录；它只持有通用要求与技能报价，交互、付款和学习仍由运行时负责。
 * Immutable trainer catalog assembled before a MapScene is published; it owns only generic requirements and skill offers, while interaction, payment, and learning remain runtime responsibilities.
 */
@component()
export class TrainerContentProfileComponent extends Component {
  private readonly definitions = new Map<number, Readonly<TrainerContentDefinition>>();
  private readonly definitionOwners = new Map<number, string>();
  private coldContentReplacementOwner = "";
  private sealed = false;

  get DefinitionCount(): number {
    return this.definitions.size;
  }

  get IncludesColdContent(): boolean {
    return this.coldContentReplacementOwner.length === 0;
  }

  ReplaceColdContent(ownerId: string): void {
    if (this.sealed) throw new Error("trainer content profile is sealed");
    const owner = requireOwnerId(ownerId);
    if (this.coldContentReplacementOwner) {
      throw new Error(`cold trainer content already belongs to ${this.coldContentReplacementOwner}`);
    }
    this.coldContentReplacementOwner = owner;
  }

  Register(ownerId: string, definitions: readonly TrainerContentDefinition[]): void {
    if (this.sealed) throw new Error("trainer content profile is sealed");
    const owner = requireOwnerId(ownerId);
    if (!Array.isArray(definitions)) throw new Error("trainer content definitions must be an array");
    const pending = new Map<number, Readonly<TrainerContentDefinition>>();
    for (const definition of definitions) {
      const frozen = freezeDefinition(definition);
      if (this.definitions.has(frozen.id) || pending.has(frozen.id)) {
        const previousOwner = this.definitionOwners.get(frozen.id) ?? owner;
        throw new Error(`trainer definition ${frozen.id} already belongs to ${previousOwner}`);
      }
      pending.set(frozen.id, frozen);
    }
    for (const [id, definition] of pending) {
      this.definitions.set(id, definition);
      this.definitionOwners.set(id, owner);
    }
  }

  Seal(): void {
    this.sealed = true;
  }

  TryGetDefinition(id: number): Readonly<TrainerContentDefinition> | undefined {
    return this.definitions.get(id);
  }

  GetDefinitions(): readonly Readonly<TrainerContentDefinition>[] {
    return Object.freeze([...this.definitions.values()].sort((left, right) => left.id - right.id));
  }

  DefinitionOwnerOf(id: number): string | undefined {
    return this.definitionOwners.get(id);
  }

  get ColdContentReplacementOwner(): string | undefined {
    return this.coldContentReplacementOwner || undefined;
  }
}

function freezeDefinition(definition: TrainerContentDefinition): Readonly<TrainerContentDefinition> {
  if (!definition || typeof definition !== "object") {
    throw new Error("trainer definition must be an object");
  }
  requirePositiveInteger(definition.id, "trainer definition id");
  requireNonNegativeInteger(definition.kind, `trainer definition ${definition.id} kind`);
  requireNonNegativeInteger(
    definition.requirementId,
    `trainer definition ${definition.id} requirement id`,
  );
  if (typeof definition.greeting !== "string") {
    throw new Error(`trainer definition ${definition.id} greeting must be text`);
  }
  if (!Array.isArray(definition.offers)) {
    throw new Error(`trainer definition ${definition.id} offers must be an array`);
  }
  const eligiblePlayerConfigIds = [
    ...new Set<number>(definition.eligiblePlayerConfigIds ?? []),
  ];
  for (const playerConfigId of eligiblePlayerConfigIds) {
    requirePositiveInteger(playerConfigId, `trainer definition ${definition.id} player config id`);
  }
  const offerIds = new Set<number>();
  const offers: Readonly<TrainerSkillOfferDefinition>[] = definition.offers.map((offer) => {
    if (!offer || typeof offer !== "object") {
      throw new Error(`trainer definition ${definition.id} offer must be an object`);
    }
    requirePositiveInteger(
      offer.skillConfigId,
      `trainer definition ${definition.id} skill config id`,
    );
    if (offerIds.has(offer.skillConfigId)) {
      throw new Error(
        `trainer definition ${definition.id} has duplicate skill offer ${offer.skillConfigId}`,
      );
    }
    offerIds.add(offer.skillConfigId);
    requireNonNegativeInteger(offer.price, `trainer skill ${offer.skillConfigId} price`);
    requireNonNegativeInteger(
      offer.requiredLevel,
      `trainer skill ${offer.skillConfigId} required level`,
    );
    requireNonNegativeInteger(
      offer.requiredSkillLineId,
      `trainer skill ${offer.skillConfigId} required skill line`,
    );
    requireNonNegativeInteger(
      offer.requiredSkillRank,
      `trainer skill ${offer.skillConfigId} required skill rank`,
    );
    const grantedProficiencyId = offer.grantedProficiencyId ?? 0;
    const grantedProficiencyMinimumRank = offer.grantedProficiencyMinimumRank ?? 0;
    const grantedProficiencyMaximumRank = offer.grantedProficiencyMaximumRank ?? 0;
    requireNonNegativeInteger(
      grantedProficiencyId,
      `trainer skill ${offer.skillConfigId} granted proficiency`,
    );
    requireNonNegativeInteger(
      grantedProficiencyMinimumRank,
      `trainer skill ${offer.skillConfigId} granted proficiency minimum rank`,
    );
    requireNonNegativeInteger(
      grantedProficiencyMaximumRank,
      `trainer skill ${offer.skillConfigId} granted proficiency maximum rank`,
    );
    if (
      (grantedProficiencyId === 0 && (
        grantedProficiencyMinimumRank !== 0 || grantedProficiencyMaximumRank !== 0
      )) ||
      (grantedProficiencyId > 0 && (
        grantedProficiencyMaximumRank <= 0 ||
        grantedProficiencyMinimumRank > grantedProficiencyMaximumRank
      ))
    ) {
      throw new Error(`trainer skill ${offer.skillConfigId} has invalid proficiency grant`);
    }
    if (!Array.isArray(offer.prerequisiteSkillConfigIds)) {
      throw new Error(`trainer skill ${offer.skillConfigId} prerequisites must be an array`);
    }
    const prerequisiteSkillConfigIds: number[] = [
      ...new Set<number>(offer.prerequisiteSkillConfigIds),
    ];
    for (const prerequisiteId of prerequisiteSkillConfigIds) {
      requirePositiveInteger(prerequisiteId, `trainer skill ${offer.skillConfigId} prerequisite`);
      if (prerequisiteId === offer.skillConfigId) {
        throw new Error(`trainer skill ${offer.skillConfigId} cannot require itself`);
      }
    }
    if (offer.grantedSkillConfigIds !== undefined && !Array.isArray(offer.grantedSkillConfigIds)) {
      throw new Error(`trainer skill ${offer.skillConfigId} grants must be an array`);
    }
    const grantedSkillConfigIds = [
      ...new Set<number>(offer.grantedSkillConfigIds ?? [offer.skillConfigId]),
    ];
    if (grantedSkillConfigIds.length === 0) {
      throw new Error(`trainer skill ${offer.skillConfigId} must grant at least one skill`);
    }
    for (const grantedSkillId of grantedSkillConfigIds) {
      requirePositiveInteger(grantedSkillId, `trainer skill ${offer.skillConfigId} grant`);
    }
    return Object.freeze({
      skillConfigId: offer.skillConfigId,
      grantedSkillConfigIds: Object.freeze(grantedSkillConfigIds.sort(numberSort)),
      price: offer.price,
      requiredLevel: offer.requiredLevel,
      requiredSkillLineId: offer.requiredSkillLineId,
      requiredSkillRank: offer.requiredSkillRank,
      prerequisiteSkillConfigIds: Object.freeze(prerequisiteSkillConfigIds.sort(numberSort)),
      grantedProficiencyId,
      grantedProficiencyMinimumRank,
      grantedProficiencyMaximumRank,
    });
  });
  return Object.freeze({
    id: definition.id,
    kind: definition.kind,
    requirementId: definition.requirementId,
    greeting: definition.greeting,
    eligiblePlayerConfigIds: Object.freeze(eligiblePlayerConfigIds.sort(numberSort)),
    offers: Object.freeze(offers.sort((left, right) => left.skillConfigId - right.skillConfigId)),
  });
}

function requireOwnerId(value: string): string {
  const owner = value?.trim();
  if (!owner) throw new Error("trainer content owner id must not be empty");
  return owner;
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
}

function requireNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must not be negative`);
}

function numberSort(left: number, right: number): number {
  return left - right;
}
