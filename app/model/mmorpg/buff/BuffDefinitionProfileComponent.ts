import { Component, component } from "../../../core/public";
import {
  ActionType,
  BuffConflictPolicy,
  BuffRefreshStatePolicy,
  BuffRefreshTickPolicy,
  BuffStackScope,
} from "../../../generated/model/config";
import type { ActionDefinition } from "../action/ActionType";

/**
 * 地图模块可注册的中立 Buff 定义；协议编号和具体游戏规则由外部模块负责映射。
 * A neutral, map-scoped Buff definition registered by an external game module.
 */
export interface BuffDefinition {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  /** 0 表示永久。/ Zero means permanent. */
  readonly durationMs: number;
  /** 0 表示没有周期效果。/ Zero disables periodic ticks. */
  readonly tickIntervalMs: number;
  readonly stackGroup: number;
  readonly stackScope: BuffStackScope;
  readonly conflictPolicy: BuffConflictPolicy;
  readonly conflictPriority: number;
  readonly refreshSource: boolean;
  readonly refreshTickPolicy: BuffRefreshTickPolicy;
  readonly refreshRuntimeState: BuffRefreshStatePolicy;
  /** 由内容模块定义的不透明正整数标签；领域层只提供任一标签匹配。 / Opaque positive tags owned by content modules; the domain only provides match-any semantics. */
  readonly effectTags?: readonly number[];
  readonly addAction?: ActionDefinition;
  readonly tickAction?: ActionDefinition;
  readonly removeAction?: ActionDefinition;
}

/**
 * 外部 Buff 资料在 MapScene 发布前原子注册并冻结，不能依靠模块加载顺序覆盖其他模块。
 * External Buff data is atomically registered and frozen before MapScene publication;
 * module load order can never overwrite an existing definition.
 */
@component()
export class BuffDefinitionProfileComponent extends Component {
  private readonly definitions = new Map<number, Readonly<BuffDefinition>>();
  private readonly owners = new Map<number, string>();
  private sealed = false;

  get Count(): number {
    return this.definitions.size;
  }

  Register(ownerId: string, definitions: readonly BuffDefinition[]): void {
    if (this.sealed) throw new Error("buff definition profile is sealed");
    const owner = requireOwnerId(ownerId);
    if (!Array.isArray(definitions)) throw new Error("external buff definitions must be an array");

    const pending = new Map<number, Readonly<BuffDefinition>>();
    for (const definition of definitions) {
      const frozen = freezeDefinition(definition);
      const currentOwner = this.owners.get(frozen.id);
      if (currentOwner || pending.has(frozen.id)) {
        throw new Error(`external buff definition ${frozen.id} already belongs to ${currentOwner ?? owner}`);
      }
      pending.set(frozen.id, frozen);
    }

    for (const [id, definition] of pending) {
      this.definitions.set(id, definition);
      this.owners.set(id, owner);
    }
  }

  Seal(): void {
    this.sealed = true;
  }

  TryGet(id: number): Readonly<BuffDefinition> | undefined {
    return this.definitions.get(id);
  }

  GetDefinitions(): readonly Readonly<BuffDefinition>[] {
    return Object.freeze([...this.definitions.values()].sort((left, right) => left.id - right.id));
  }

  OwnerOf(id: number): string | undefined {
    return this.owners.get(id);
  }
}

function freezeDefinition(definition: BuffDefinition): Readonly<BuffDefinition> {
  if (!definition || typeof definition !== "object") {
    throw new Error("external buff definition must be an object");
  }
  requirePositiveInteger(definition.id, "buff definition id");
  const name = requireText(definition.name, `buff definition ${definition.id} name`);
  const description = requireText(
    definition.description,
    `buff definition ${definition.id} description`,
  );
  requireNonNegativeInteger(definition.durationMs, `buff definition ${definition.id} duration`);
  requireNonNegativeInteger(
    definition.tickIntervalMs,
    `buff definition ${definition.id} tick interval`,
  );
  requirePositiveInteger(definition.stackGroup, `buff definition ${definition.id} stack group`);
  requireEnum(
    definition.stackScope,
    [BuffStackScope.Target, BuffStackScope.Source],
    `buff definition ${definition.id} stack scope`,
  );
  requireEnum(
    definition.conflictPolicy,
    [
      BuffConflictPolicy.Stack,
      BuffConflictPolicy.Refresh,
      BuffConflictPolicy.Replace,
      BuffConflictPolicy.Reject,
      BuffConflictPolicy.HigherWins,
    ],
    `buff definition ${definition.id} conflict policy`,
  );
  requireNonNegativeInteger(
    definition.conflictPriority,
    `buff definition ${definition.id} conflict priority`,
  );
  if (
    definition.conflictPolicy === BuffConflictPolicy.HigherWins
    && definition.conflictPriority === 0
  ) {
    throw new Error(`buff definition ${definition.id} HigherWins requires positive priority`);
  }
  if (typeof definition.refreshSource !== "boolean") {
    throw new Error(`buff definition ${definition.id} refreshSource must be boolean`);
  }
  requireEnum(
    definition.refreshTickPolicy,
    [BuffRefreshTickPolicy.KeepCadence, BuffRefreshTickPolicy.ResetCadence],
    `buff definition ${definition.id} refresh tick policy`,
  );
  requireEnum(
    definition.refreshRuntimeState,
    [BuffRefreshStatePolicy.Keep, BuffRefreshStatePolicy.Reset],
    `buff definition ${definition.id} refresh runtime-state policy`,
  );
  const effectTags = freezeEffectTags(definition.id, definition.effectTags ?? []);

  const addAction = freezeAction(definition.id, "add", definition.addAction);
  const tickAction = freezeAction(definition.id, "tick", definition.tickAction);
  const removeAction = freezeAction(definition.id, "remove", definition.removeAction);
  const hasTickAction = tickAction !== undefined && tickAction.type !== ActionType.None;
  if ((definition.tickIntervalMs > 0) !== hasTickAction) {
    throw new Error(
      `buff definition ${definition.id} tick interval and Tick Action must be configured together`,
    );
  }

  return Object.freeze({
    id: definition.id,
    name,
    description,
    durationMs: definition.durationMs,
    tickIntervalMs: definition.tickIntervalMs,
    stackGroup: definition.stackGroup,
    stackScope: definition.stackScope,
    conflictPolicy: definition.conflictPolicy,
    conflictPriority: definition.conflictPriority,
    refreshSource: definition.refreshSource,
    refreshTickPolicy: definition.refreshTickPolicy,
    refreshRuntimeState: definition.refreshRuntimeState,
    effectTags,
    ...(addAction ? { addAction } : {}),
    ...(tickAction ? { tickAction } : {}),
    ...(removeAction ? { removeAction } : {}),
  });
}

function freezeAction(
  buffId: number,
  phase: "add" | "tick" | "remove",
  action: ActionDefinition | undefined,
): Readonly<ActionDefinition> | undefined {
  if (action === undefined) return undefined;
  if (!action || typeof action !== "object") {
    throw new Error(`buff definition ${buffId} ${phase} Action must be an object`);
  }
  if (!Number.isSafeInteger(action.type) || action.type < ActionType.None || action.type >= ActionType.Max) {
    throw new Error(`buff definition ${buffId} ${phase} Action type is invalid: ${action.type}`);
  }
  if (!Array.isArray(action.parameters) || action.parameters.some((value) => typeof value !== "bigint")) {
    throw new Error(`buff definition ${buffId} ${phase} Action parameters must be bigint values`);
  }
  validateParameterCount(buffId, phase, action);
  return Object.freeze({ type: action.type, parameters: Object.freeze([...action.parameters]) });
}

function validateParameterCount(
  buffId: number,
  phase: "add" | "tick" | "remove",
  action: ActionDefinition,
): void {
  const count = action.parameters.length;
  let valid = false;
  switch (action.type) {
    case ActionType.None:
      valid = count === 0;
      break;
    case ActionType.ChangeNumeric:
    case ActionType.DealDamage:
    case ActionType.GrantItem:
      valid = count === 2;
      break;
    case ActionType.ChangeNumericBatch:
      valid = count > 0 && count % 2 === 0;
      break;
    case ActionType.RemoveBuffsByEffectTags:
      valid = hasUniquePositiveSafeIntegerParameters(action.parameters);
      break;
    case ActionType.AddBuff:
    case ActionType.Heal:
    case ActionType.HealFromResolvedDamagePercent:
      valid = count === 1;
      break;
    case ActionType.RemoveBuff:
      valid = count === 1 || (phase === "remove" && count === 0);
      break;
    case ActionType.RegisterDamageAbsorber:
      valid = count === 1 || count === 2;
      break;
  }
  if (!valid) {
    throw new Error(
      `buff definition ${buffId} ${phase} Action ${action.type} has invalid parameter count ${count}`,
    );
  }
}

function hasUniquePositiveSafeIntegerParameters(parameters: readonly bigint[]): boolean {
  if (parameters.length === 0) return false;
  const seen = new Set<bigint>();
  for (const value of parameters) {
    if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER) || seen.has(value)) return false;
    seen.add(value);
  }
  return true;
}

function freezeEffectTags(buffId: number, values: readonly number[]): readonly number[] {
  if (!Array.isArray(values)) throw new Error(`buff definition ${buffId} effectTags must be an array`);
  const tags = [...values];
  if (tags.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error(`buff definition ${buffId} effectTags must contain positive safe integers`);
  }
  if (new Set(tags).size !== tags.length) {
    throw new Error(`buff definition ${buffId} effectTags must not contain duplicates`);
  }
  return Object.freeze(tags.sort((left, right) => left - right));
}

function requireOwnerId(value: string): string {
  const owner = value?.trim();
  if (!owner) throw new Error("external buff definition owner id must not be empty");
  return owner;
}

function requireText(value: string, label: string): string {
  const result = value?.trim();
  if (!result) throw new Error(`${label} must not be empty`);
  return result;
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
}

function requireNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must not be negative`);
}

function requireEnum(value: number, allowed: readonly number[], label: string): void {
  if (!allowed.includes(value)) throw new Error(`${label} is invalid: ${value}`);
}
