import { Component, component } from "../../../core/public";

/** 由模块持有、供背包、商店、奖励和物品使用运行时消费的中立物品模板。 / A module-owned neutral item template consumed by inventory, shop, reward, and item-use runtimes. */
export interface ItemContentDefinition {
  readonly id: number;
  readonly name: string;
  readonly quality: number;
  readonly level: number;
  readonly maxStack: number;
  readonly useEffect: number;
  readonly useParams: readonly number[];
  readonly cooldownMs: number;
  readonly globalCooldownMs: number;
  readonly buyPrice: number;
  readonly sellPrice: number;
  /** 新物品实例的中立最大耐久；0 表示该物品没有耐久。 / Neutral maximum durability for new instances; zero means the item has no durability. */
  readonly maxDurability?: number;
  /** 每损失一点耐久的百万分比修理成本；最终单件费用向下取整且至少为 1。 / Per-million repair cost for each lost durability point; each repaired item is floored and costs at least one. */
  readonly repairCostPerMillion?: number;
  /** 单次商店购买操作发放的物品数量。 / Number of item units granted by one shop purchase operation. */
  readonly purchaseCount?: number;
}

/**
 * 地图场景发布前由外置模块组装的不可变物品目录；物品实体与背包事务仍归TiangZ现有运行时所有。
 * Immutable item catalog assembled by external modules before a MapScene is published; item entities and inventory transactions remain owned by the existing TiangZ runtime.
 */
@component()
export class ItemContentProfileComponent extends Component {
  private readonly definitions = new Map<number, Readonly<ItemContentDefinition>>();
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
    if (this.sealed) throw new Error("item content profile is sealed");
    const owner = requireOwnerId(ownerId);
    if (this.coldContentReplacementOwner) {
      throw new Error(`cold item content already belongs to ${this.coldContentReplacementOwner}`);
    }
    this.coldContentReplacementOwner = owner;
  }

  Register(ownerId: string, definitions: readonly ItemContentDefinition[]): void {
    if (this.sealed) throw new Error("item content profile is sealed");
    const owner = requireOwnerId(ownerId);
    if (!Array.isArray(definitions)) throw new Error("item content definitions must be an array");
    const pending = new Map<number, Readonly<ItemContentDefinition>>();
    for (const definition of definitions) {
      const frozen = freezeDefinition(definition);
      if (this.definitions.has(frozen.id) || pending.has(frozen.id)) {
        const previousOwner = this.definitionOwners.get(frozen.id) ?? owner;
        throw new Error(`item definition ${frozen.id} already belongs to ${previousOwner}`);
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

  TryGetDefinition(id: number): Readonly<ItemContentDefinition> | undefined {
    return this.definitions.get(id);
  }

  GetDefinitions(): readonly Readonly<ItemContentDefinition>[] {
    return Object.freeze([...this.definitions.values()].sort((left, right) => left.id - right.id));
  }

  DefinitionOwnerOf(id: number): string | undefined {
    return this.definitionOwners.get(id);
  }

  get ColdContentReplacementOwner(): string | undefined {
    return this.coldContentReplacementOwner || undefined;
  }
}

function freezeDefinition(definition: ItemContentDefinition): Readonly<ItemContentDefinition> {
  if (!definition || typeof definition !== "object") throw new Error("item definition must be an object");
  requirePositiveInteger(definition.id, "item definition id");
  const name = definition.name?.trim();
  if (!name) throw new Error(`item definition ${definition.id} name must not be empty`);
  requireNonNegativeInteger(definition.quality, `item definition ${definition.id} quality`);
  requireNonNegativeInteger(definition.level, `item definition ${definition.id} level`);
  requirePositiveInteger(definition.maxStack, `item definition ${definition.id} max stack`);
  requireNonNegativeInteger(definition.useEffect, `item definition ${definition.id} use effect`);
  if (!Array.isArray(definition.useParams)) {
    throw new Error(`item definition ${definition.id} use params must be an array`);
  }
  const useParams = definition.useParams.map((value) => {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`item definition ${definition.id} use parameter must be a safe integer`);
    }
    return value;
  });
  requireNonNegativeInteger(definition.cooldownMs, `item definition ${definition.id} cooldown`);
  requireNonNegativeInteger(
    definition.globalCooldownMs,
    `item definition ${definition.id} global cooldown`,
  );
  requireNonNegativeInteger(definition.buyPrice, `item definition ${definition.id} buy price`);
  requireNonNegativeInteger(definition.sellPrice, `item definition ${definition.id} sell price`);
  const maxDurability = definition.maxDurability ?? 0;
  requireNonNegativeInteger(maxDurability, `item definition ${definition.id} max durability`);
  const repairCostPerMillion = definition.repairCostPerMillion ?? 0;
  requireNonNegativeInteger(
    repairCostPerMillion,
    `item definition ${definition.id} repair cost per million`,
  );
  const purchaseCount = definition.purchaseCount ?? 1;
  requirePositiveInteger(purchaseCount, `item definition ${definition.id} purchase count`);
  return Object.freeze({
    id: definition.id,
    name,
    quality: definition.quality,
    level: definition.level,
    maxStack: definition.maxStack,
    useEffect: definition.useEffect,
    useParams: Object.freeze(useParams),
    cooldownMs: definition.cooldownMs,
    globalCooldownMs: definition.globalCooldownMs,
    buyPrice: definition.buyPrice,
    sellPrice: definition.sellPrice,
    maxDurability,
    repairCostPerMillion,
    purchaseCount,
  });
}

function requireOwnerId(value: string): string {
  const owner = value?.trim();
  if (!owner) throw new Error("item content owner id must not be empty");
  return owner;
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
}

function requireNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must not be negative`);
}
