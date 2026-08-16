import {
  CombatStateComponent,
  NativeUnitRef,
  NumericComponent,
  NumericType,
  type Unit,
  systemFor,
} from "#tiangz/model";

/** 脱战180秒从当前值恢复到满HP/MP；技能只负责扣除法力。 / HP and MP recover from current values to full over 180 seconds out of combat; skills only deduct mana. */
export const RESOURCE_FULL_REGEN_DURATION_MS = 180_000;

/**
 * 统一维护玩家的战斗来源和脱战HP/MP恢复。
 *
 * 怪物死亡、回归或玩家被清理时必须调用RemoveMonster/Clear；不要在技能、Buff或
 * UI代码里自行写“是否战斗中”的判断，否则不同攻击入口会出现不一致的回蓝行为。
 *
 * Centralizes combat sources and out-of-combat HP/MP regeneration.
 * Monster death, leash return, or player cleanup must call RemoveMonster/Clear.
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
    this.monsterUnitIds.clear();
    this.lastRegenAtMs = 0;
    this.hpRegenRemainder = 0n;
    this.manaRegenRemainder = 0n;
  }

  IsInCombat(): boolean {
    return this.monsterUnitIds.size > 0;
  }

  AddMonster(monsterUnitId: number, nowMs: number): void {
    if (!Number.isSafeInteger(monsterUnitId) || monsterUnitId <= 0) return;
    if (this.monsterUnitIds.has(monsterUnitId)) return;
    if (this.monsterUnitIds.size === 0) {
      this.lastRegenAtMs = requireServerTime(nowMs);
      this.hpRegenRemainder = 0n;
      this.manaRegenRemainder = 0n;
    }
    this.monsterUnitIds.add(monsterUnitId);
  }

  RemoveMonster(monsterUnitId: number, nowMs: number): void {
    if (!this.monsterUnitIds.delete(monsterUnitId)) return;
    if (this.monsterUnitIds.size === 0) {
      this.lastRegenAtMs = requireServerTime(nowMs);
      this.hpRegenRemainder = 0n;
      this.manaRegenRemainder = 0n;
    }
  }

  Clear(nowMs: number): void {
    if (this.monsterUnitIds.size === 0) return;
    this.monsterUnitIds.clear();
    this.lastRegenAtMs = requireServerTime(nowMs);
    this.hpRegenRemainder = 0n;
    this.manaRegenRemainder = 0n;
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
    if (this.IsInCombat()) {
      this.lastRegenAtMs = now;
      this.hpRegenRemainder = 0n;
      this.manaRegenRemainder = 0n;
      return;
    }

    const unit = this.GetParent<Unit<any[]>>();
    if (unit.GetComponent(NativeUnitRef).alive === 0) {
      this.lastRegenAtMs = now;
      this.hpRegenRemainder = 0n;
      this.manaRegenRemainder = 0n;
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
    this.hpRegenRemainder = restoreResource(
      numeric,
      NumericType.CurrentHp,
      NumericType.MaxHp,
      elapsed,
      this.hpRegenRemainder,
    );
    this.manaRegenRemainder = restoreResource(
      numeric,
      NumericType.CurrentMp,
      NumericType.MaxMp,
      elapsed,
      this.manaRegenRemainder,
    );
  }
}

function restoreResource(
  numeric: NumericComponent,
  currentType: number,
  maxType: number,
  elapsedMs: number,
  remainder: bigint,
): bigint {
  const max = numeric[maxType];
  const current = numeric[currentType];
  if (max <= 0n || current >= max) return 0n;
  const numerator = max * BigInt(elapsedMs) + remainder;
  const restored = numerator / BigInt(RESOURCE_FULL_REGEN_DURATION_MS);
  const nextRemainder = numerator % BigInt(RESOURCE_FULL_REGEN_DURATION_MS);
  if (restored <= 0n) return nextRemainder;
  numeric[currentType] = current + restored > max ? max : current + restored;
  return numeric[currentType] >= max ? 0n : nextRemainder;
}

function requireServerTime(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`combat state time must be a non-negative safe integer: ${value}`);
  }
  return value;
}
