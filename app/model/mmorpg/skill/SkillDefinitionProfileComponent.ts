import { Component, component } from "../../../core/public";
import { ActionType, type ActionDefinition } from "../action/ActionType";
import type { BuffAddOptions } from "../buff/BuffComponent";
import {
  AllNumericTypes,
  IsDerivedNumericType,
  type NumericTypeValue,
} from "../numeric/NumericType";
import {
  SkillAutoAttackPolicy,
  SkillDelivery,
  SkillEffectTarget,
  SkillMovementPolicy,
  SkillTargetRelation,
  type SkillDefinition,
  type SkillEffectDefinition,
  type SkillResourceCostDefinition,
} from "./SkillDefinition";

/**
 * 地图级外置技能资料入口。外置游戏模块可以登记新的技能定义，但不能覆盖主工程冷配置，
 * 也不能依赖模块加载顺序覆盖另一个模块。资料属于地图Component，不保存在模块级全局变量中。
 *
 * Map-scoped external skill data boundary. External game modules may register
 * new definitions, but may not override cold data or another module by load
 * order. Definitions belong to this map component rather than module globals.
 */
@component()
export class SkillDefinitionProfileComponent extends Component {
  private readonly definitions = new Map<number, SkillDefinition>();
  private readonly owners = new Map<number, string>();

  /** 返回本地图已登记的外置技能数量。 / Returns the number of external skills registered for this map. */
  get Count(): number {
    return this.definitions.size;
  }

  /** 原子登记一个模块的技能定义；任意一条无效时不保留部分结果。 / Atomically registers one module's definitions without retaining partial results on failure. */
  Register(ownerId: string, definitions: readonly SkillDefinition[]): void {
    const owner = ownerId?.trim();
    if (!owner) throw new Error("external skill definition owner id must not be empty");
    if (!Array.isArray(definitions) || definitions.length === 0) {
      throw new Error(`external skill definition list must not be empty: ${owner}`);
    }

    const staged = definitions.map((definition) => freezeSkillDefinition(definition));
    const stagedIds = new Set<number>();
    for (const definition of staged) {
      if (stagedIds.has(definition.id)) {
        throw new Error(`duplicate external skill definition in ${owner}: ${definition.id}`);
      }
      stagedIds.add(definition.id);
      const currentOwner = this.owners.get(definition.id);
      if (currentOwner) {
        throw new Error(`external skill definition ${definition.id} already belongs to ${currentOwner}`);
      }
    }

    for (const definition of staged) {
      this.definitions.set(definition.id, definition);
      this.owners.set(definition.id, owner);
    }
  }

  /** 按模块私有技能ID读取只读定义。 / Reads an immutable definition by its module-private skill ID. */
  TryGet(skillId: number): SkillDefinition | undefined {
    return this.definitions.get(skillId);
  }

  /** 返回技能资料的模块所有者，用于冲突诊断。 / Returns a definition's module owner for conflict diagnostics. */
  OwnerOf(skillId: number): string | undefined {
    return this.owners.get(skillId);
  }
}

function freezeSkillDefinition(definition: SkillDefinition): SkillDefinition {
  if (!definition || typeof definition !== "object") {
    throw new Error("external skill definition must be an object");
  }
  requirePositiveSafeInteger(definition.id, "id");
  requireText(definition.name, `skill ${definition.id} name`);
  requireText(definition.description, `skill ${definition.id} description`);
  requireEnum(definition.relation, [SkillTargetRelation.Enemy, SkillTargetRelation.Friendly], "relation");
  requireEnum(definition.delivery, [SkillDelivery.Direct, SkillDelivery.Projectile], "delivery");
  requireEnum(
    definition.movementPolicy,
    [SkillMovementPolicy.Allow, SkillMovementPolicy.InterruptWhileCasting],
    "movementPolicy",
  );
  requireEnum(
    definition.autoAttackPolicy,
    [
      SkillAutoAttackPolicy.Keep,
      SkillAutoAttackPolicy.ResetOnStart,
      SkillAutoAttackPolicy.ResetOnComplete,
      SkillAutoAttackPolicy.Cancel,
    ],
    "autoAttackPolicy",
  );
  for (const [name, value] of [
    ["castTimeMs", definition.castTimeMs],
    ["cooldownMs", definition.cooldownMs],
    ["globalCooldownMs", definition.globalCooldownMs],
    ["rangeMeters", definition.rangeMeters],
    ["projectileSpeedMetersPerSecond", definition.projectileSpeedMetersPerSecond],
    ["requiredAbsentBuffConfigId", definition.requiredAbsentBuffConfigId],
    ["queueWindowMs", definition.queueWindowMs],
    ["channelTickMs", definition.channelTickMs],
    ["channelTicks", definition.channelTicks],
  ] as const) {
    requireNonNegativeFinite(value, `skill ${definition.id} ${name}`);
  }
  if (definition.delivery === SkillDelivery.Projectile && definition.projectileSpeedMetersPerSecond <= 0) {
    throw new Error(`external projectile skill ${definition.id} requires positive projectile speed`);
  }
  if ((definition.channelTickMs === 0) !== (definition.channelTicks === 0)) {
    throw new Error(`external skill ${definition.id} channel interval and ticks must both be zero or positive`);
  }
  if (!Array.isArray(definition.effects) || definition.effects.length === 0) {
    throw new Error(`external skill ${definition.id} must contain at least one effect`);
  }
  const effects = definition.effects.map((effect, index) => freezeEffect(definition.id, index, effect));
  const resourceCosts = freezeResourceCosts(definition.id, definition.resourceCosts);
  return Object.freeze({
    ...definition,
    ...(resourceCosts.length === 0 ? { resourceCosts: undefined } : { resourceCosts }),
    effects: Object.freeze(effects),
  });
}

function freezeResourceCosts(
  skillId: number,
  values: readonly SkillResourceCostDefinition[] | undefined,
): readonly SkillResourceCostDefinition[] {
  if (values === undefined) return Object.freeze([]);
  if (!Array.isArray(values)) throw new Error(`external skill ${skillId} resourceCosts must be an array`);
  const currentTypes = new Set<number>();
  return Object.freeze(values.map((cost, index) => {
    if (!cost || typeof cost !== "object") {
      throw new Error(`external skill ${skillId} resource cost ${index} must be an object`);
    }
    requireWritableNumericType(
      cost.currentNumericType,
      `external skill ${skillId} resource cost ${index} currentNumericType`,
    );
    if (currentTypes.has(cost.currentNumericType)) {
      throw new Error(`external skill ${skillId} duplicates resource ${cost.currentNumericType}`);
    }
    currentTypes.add(cost.currentNumericType);
    if (typeof cost.fixedAmount !== "bigint" || cost.fixedAmount < 0n) {
      throw new Error(`external skill ${skillId} resource cost ${index} fixedAmount must be a non-negative bigint`);
    }
    const basisNumericType = cost.basisNumericType;
    const basisPermille = cost.basisPermille;
    if ((basisNumericType === undefined) !== (basisPermille === undefined)) {
      throw new Error(`external skill ${skillId} resource cost ${index} basis fields must be supplied together`);
    }
    if (basisNumericType !== undefined) {
      requireReadableNumericType(
        basisNumericType,
        `external skill ${skillId} resource cost ${index} basisNumericType`,
      );
      if (!Number.isSafeInteger(basisPermille) || basisPermille! < 0 || basisPermille! > 1_000) {
        throw new Error(`external skill ${skillId} resource cost ${index} basisPermille must be 0..1000`);
      }
    }
    if (cost.fixedAmount === 0n && (basisPermille ?? 0) === 0) {
      throw new Error(`external skill ${skillId} resource cost ${index} must consume a positive amount`);
    }
    return Object.freeze({
      currentNumericType: cost.currentNumericType,
      fixedAmount: cost.fixedAmount,
      ...(basisNumericType === undefined ? {} : { basisNumericType, basisPermille }),
    });
  }));
}

function requireReadableNumericType(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || !AllNumericTypes.includes(value as NumericTypeValue)) {
    throw new Error(`${label} is unknown: ${value}`);
  }
}

function requireWritableNumericType(value: number, label: string): void {
  requireReadableNumericType(value, label);
  if (IsDerivedNumericType(value)) throw new Error(`${label} cannot be derived: ${value}`);
}

function freezeEffect(skillId: number, index: number, effect: SkillEffectDefinition): SkillEffectDefinition {
  if (!effect || typeof effect !== "object") {
    throw new Error(`external skill ${skillId} effect ${index} must be an object`);
  }
  requireEnum(
    effect.target,
    [SkillEffectTarget.Caster, SkillEffectTarget.PrimaryTarget],
    `skill ${skillId} effect ${index} target`,
  );
  const action = freezeAction(skillId, index, effect.action);
  return Object.freeze({
    target: effect.target,
    action,
    ...(effect.buffOptions ? { buffOptions: freezeBuffOptions(skillId, index, effect.buffOptions) } : {}),
  });
}

function freezeAction(skillId: number, index: number, action: ActionDefinition): ActionDefinition {
  if (!action || typeof action !== "object") {
    throw new Error(`external skill ${skillId} effect ${index} action must be an object`);
  }
  if (!Number.isSafeInteger(action.type) || action.type < ActionType.None || action.type >= ActionType.Max) {
    throw new Error(`external skill ${skillId} effect ${index} has invalid action type: ${action.type}`);
  }
  if (!Array.isArray(action.parameters) || action.parameters.some((value) => typeof value !== "bigint")) {
    throw new Error(`external skill ${skillId} effect ${index} action parameters must be bigint values`);
  }
  return Object.freeze({ type: action.type, parameters: Object.freeze([...action.parameters]) });
}

function freezeBuffOptions(skillId: number, index: number, options: BuffAddOptions): BuffAddOptions {
  const result: BuffAddOptions = {
    ...options,
    ...(options.addAction ? { addAction: freezeAction(skillId, index, options.addAction) } : {}),
    ...(options.tickAction ? { tickAction: freezeAction(skillId, index, options.tickAction) } : {}),
    ...(options.removeAction ? { removeAction: freezeAction(skillId, index, options.removeAction) } : {}),
  };
  return Object.freeze(result);
}

function requirePositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`external skill ${name} must be positive: ${value}`);
}

function requireNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative: ${value}`);
}

function requireText(value: string, name: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
}

function requireEnum(value: number, allowed: readonly number[], name: string): void {
  if (!allowed.includes(value)) throw new Error(`external skill ${name} is invalid: ${value}`);
}
