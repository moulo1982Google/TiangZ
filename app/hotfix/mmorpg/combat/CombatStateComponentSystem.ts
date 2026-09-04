import {
  AllNumericTypes,
  CombatStateComponent,
  IsDerivedNumericType,
  NativeUnitRef,
  NumericComponent,
  NumericType,
  ResourceFlowCombatMode,
  ResourceFlowDirection,
  type ResourceFlowDefinition,
  type NumericTypeValue,
  type Unit,
  systemFor,
} from "#tiangz/model";

/** 脱战180秒从当前值恢复到满HP/MP；技能只负责扣除法力。 / HP and MP recover from current values to full over 180 seconds out of combat; skills only deduct mana. */
export const RESOURCE_FULL_REGEN_DURATION_MS = 180_000;

const DEFAULT_RESOURCE_FLOWS = Object.freeze([
  Object.freeze({
    id: 1,
    currentNumericType: NumericType.CurrentHp,
    maximumNumericType: NumericType.MaxHp,
    direction: ResourceFlowDirection.Gain,
    combatMode: ResourceFlowCombatMode.OutOfCombat,
    fullScaleDurationMs: RESOURCE_FULL_REGEN_DURATION_MS,
  }),
  Object.freeze({
    id: 2,
    currentNumericType: NumericType.CurrentMp,
    maximumNumericType: NumericType.MaxMp,
    direction: ResourceFlowDirection.Gain,
    combatMode: ResourceFlowCombatMode.OutOfCombat,
    fullScaleDurationMs: RESOURCE_FULL_REGEN_DURATION_MS,
  }),
] satisfies readonly ResourceFlowDefinition[]);

/**
 * 统一维护玩家的战斗来源和脱战HP/MP恢复。
 *
 * 敌对Unit死亡、回归或玩家被清理时必须调用RemoveHostile/Clear；不要在技能、Buff或
 * UI代码里自行写“是否战斗中”的判断，否则不同攻击入口会出现不一致的回蓝行为。
 *
 * Centralizes combat sources and out-of-combat HP/MP regeneration.
 * Hostile death, leash return, or player cleanup must call RemoveHostile/Clear.
 * Skills, Buffs, and UI must not invent their own combat-state checks.
 */
@systemFor(CombatStateComponent)
export class CombatStateComponentSystem extends CombatStateComponent {
  /**
   * 组件销毁时清掉战斗来源和回蓝余数，避免复用实体句柄时把旧战斗状态带入新玩家。
   * Clear combat sources and regeneration remainder on disposal so a reused
   * entity handle cannot inherit the previous player's combat state.
   */
  OnDestroy(): void {
    this.hostileUnitIds.clear();
    this.lastRegenAtMs = 0;
    this.resourceFlowOwner = "";
    this.resourceFlows = Object.freeze([]);
    this.resourceFlowRemainders.clear();
  }

  IsInCombat(): boolean {
    return this.hostileUnitIds.size > 0;
  }

  AddHostile(unitId: number, nowMs: number): void {
    if (!Number.isSafeInteger(unitId) || unitId <= 0) return;
    if (this.hostileUnitIds.has(unitId)) return;
    if (this.hostileUnitIds.size === 0) {
      this.lastRegenAtMs = requireServerTime(nowMs);
      this.resourceFlowRemainders.clear();
    }
    this.hostileUnitIds.add(unitId);
  }

  RemoveHostile(unitId: number, nowMs: number): void {
    if (!this.hostileUnitIds.delete(unitId)) return;
    if (this.hostileUnitIds.size === 0) {
      this.lastRegenAtMs = requireServerTime(nowMs);
      this.resourceFlowRemainders.clear();
    }
  }

  AddMonster(monsterUnitId: number, nowMs: number): void {
    this.AddHostile(monsterUnitId, nowMs);
  }

  RemoveMonster(monsterUnitId: number, nowMs: number): void {
    this.RemoveHostile(monsterUnitId, nowMs);
  }

  Clear(nowMs: number): void {
    if (this.hostileUnitIds.size === 0) return;
    this.hostileUnitIds.clear();
    this.lastRegenAtMs = requireServerTime(nowMs);
    this.resourceFlowRemainders.clear();
  }

  ConfigureResourceFlows(ownerId: string, definitions: readonly ResourceFlowDefinition[]): void {
    const owner = ownerId?.trim();
    if (!owner) throw new Error("resource flow owner id must not be empty");
    if (this.resourceFlowOwner && this.resourceFlowOwner !== owner) {
      throw new Error(`resource flows already belong to ${this.resourceFlowOwner}`);
    }
    if (!Array.isArray(definitions) || definitions.length === 0) {
      throw new Error(`resource flow list must not be empty: ${owner}`);
    }
    const ids = new Set<number>();
    const frozen = definitions.map((definition, index) => {
      if (!definition || typeof definition !== "object") {
        throw new Error(`resource flow ${index} must be an object`);
      }
      requirePositiveInteger(definition.id, `resource flow ${index} id`);
      if (ids.has(definition.id)) throw new Error(`resource flow id is duplicated: ${definition.id}`);
      ids.add(definition.id);
      requireNumericType(definition.currentNumericType, `resource flow ${definition.id} current`);
      if (IsDerivedNumericType(definition.currentNumericType)) {
        throw new Error(`resource flow ${definition.id} current NumericType cannot be derived`);
      }
      requireNumericType(definition.maximumNumericType, `resource flow ${definition.id} maximum`);
      if (definition.direction !== ResourceFlowDirection.Gain
        && definition.direction !== ResourceFlowDirection.Drain) {
        throw new Error(`resource flow ${definition.id} direction is unsupported`);
      }
      if (definition.combatMode !== ResourceFlowCombatMode.Always
        && definition.combatMode !== ResourceFlowCombatMode.OutOfCombat
        && definition.combatMode !== ResourceFlowCombatMode.InCombat) {
        throw new Error(`resource flow ${definition.id} combat mode is unsupported`);
      }
      requirePositiveInteger(
        definition.fullScaleDurationMs,
        `resource flow ${definition.id} full-scale duration`,
      );
      return Object.freeze({ ...definition });
    });
    this.resourceFlowOwner = owner;
    this.resourceFlows = Object.freeze(frozen);
    this.resourceFlowRemainders.clear();
  }

  /**
   * 由地图的10Hz桶调用。战斗中只刷新时间基准，不生成任何恢复；脱战后HP和MP按整数比例累计，
   * 因此不会产生浮点误差，也不会因10Hz调度抖动而丢失小数进度。
   *
   * Called from the map's 10 Hz bucket. Combat only refreshes the time base;
   * out of combat, HP and MP progress are accumulated as integers without float drift.
   */
  TickResources(nowMs: number): void {
    const now = requireServerTime(nowMs);
    const unit = this.GetParent<Unit<any[]>>();
    if (unit.GetComponent(NativeUnitRef).alive === 0) {
      this.lastRegenAtMs = now;
      this.resourceFlowRemainders.clear();
      return;
    }
    if (this.lastRegenAtMs === 0) {
      this.lastRegenAtMs = now;
      return;
    }

    const elapsed = Math.max(0, now - this.lastRegenAtMs);
    if (elapsed === 0) return;
    this.lastRegenAtMs = now;

    const numeric = unit.GetComponent(NumericComponent);
    const inCombat = this.IsInCombat();
    for (const flow of this.resourceFlows.length === 0 ? DEFAULT_RESOURCE_FLOWS : this.resourceFlows) {
      if (!flowApplies(flow, inCombat)) {
        this.resourceFlowRemainders.delete(flow.id);
        continue;
      }
      const result = AdvanceResourceFlow(
        numeric[flow.currentNumericType],
        numeric[flow.maximumNumericType],
        elapsed,
        this.resourceFlowRemainders.get(flow.id) ?? 0n,
        flow,
      );
      if (result.value !== numeric[flow.currentNumericType]) {
        numeric[flow.currentNumericType] = result.value;
      }
      if (result.remainder === 0n) this.resourceFlowRemainders.delete(flow.id);
      else this.resourceFlowRemainders.set(flow.id, result.remainder);
    }
  }
}

/** 纯整数推进函数，供运行时与差分测试共享。 / Pure integer advancement shared by runtime execution and differential tests. */
export function AdvanceResourceFlow(
  current: bigint,
  maximum: bigint,
  elapsedMs: number,
  remainder: bigint,
  flow: Pick<ResourceFlowDefinition, "direction" | "fullScaleDurationMs">,
): Readonly<{ value: bigint; remainder: bigint }> {
  if (current < 0n || maximum < 0n) {
    throw new Error(`resource bounds are invalid: current=${current}, maximum=${maximum}`);
  }
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
    throw new Error(`resource flow elapsed time is invalid: ${elapsedMs}`);
  }
  if (remainder < 0n) throw new Error(`resource flow remainder is invalid: ${remainder}`);
  const boundedCurrent = current > maximum ? maximum : current;
  if (maximum === 0n || elapsedMs === 0) {
    return Object.freeze({ value: boundedCurrent, remainder: 0n });
  }
  const atBoundary = flow.direction === ResourceFlowDirection.Gain
    ? boundedCurrent >= maximum
    : boundedCurrent <= 0n;
  if (atBoundary) return Object.freeze({ value: boundedCurrent, remainder: 0n });
  const denominator = BigInt(flow.fullScaleDurationMs);
  const numerator = maximum * BigInt(elapsedMs) + remainder;
  const changed = numerator / denominator;
  const nextRemainder = numerator % denominator;
  if (changed === 0n) return Object.freeze({ value: boundedCurrent, remainder: nextRemainder });
  const value = flow.direction === ResourceFlowDirection.Gain
    ? (boundedCurrent + changed > maximum ? maximum : boundedCurrent + changed)
    : (boundedCurrent - changed < 0n ? 0n : boundedCurrent - changed);
  return Object.freeze({
    value,
    remainder: value === 0n || value === maximum ? 0n : nextRemainder,
  });
}

function flowApplies(flow: ResourceFlowDefinition, inCombat: boolean): boolean {
  return flow.combatMode === ResourceFlowCombatMode.Always
    || (flow.combatMode === ResourceFlowCombatMode.InCombat && inCombat)
    || (flow.combatMode === ResourceFlowCombatMode.OutOfCombat && !inCombat);
}

function requireNumericType(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || !AllNumericTypes.includes(value as NumericTypeValue)) {
    throw new Error(`${label} NumericType is unknown: ${value}`);
  }
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
}

function requireServerTime(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`combat state time must be a non-negative safe integer: ${value}`);
  }
  return value;
}
