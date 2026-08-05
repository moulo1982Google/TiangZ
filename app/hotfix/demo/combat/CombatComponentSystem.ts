import {
  AutoAttackPhase,
  CombatComponent,
  type AutoAttackState,
  systemFor,
} from "#tiangz/model";

/** 演示平A间隔；正式项目应由技能/武器配置提供，不要在客户端自行决定。 / Demo swing interval; production projects should read this from skill or weapon config, never from the client. */
export const DEFAULT_AUTO_ATTACK_INTERVAL_MS = 2_000;

/**
 * CombatComponent只托管平A状态，不负责找目标、距离、朝向或伤害。
 * 这些判定必须留在Map的战斗System中，保证同一地图的规则集中且可热更。
 *
 * CombatComponent only owns auto-attack state. Target lookup, range, facing,
 * and damage stay in the map combat System so one map owns one rule boundary.
 */
@systemFor(CombatComponent)
export class CombatComponentSystem extends CombatComponent {
  /** 返回当前状态副本；调用者不能直接持有并修改组件内部字段。 / Returns a copy so callers cannot mutate component fields through the snapshot. */
  AutoAttackState(): AutoAttackState {
    return this.snapshotAutoAttackState();
  }

  /** 由权威Numeric.AttackSpeed同步当前读条时长；不会重置已经开始的读条。 / Synchronizes the authoritative Numeric.AttackSpeed interval without resetting an active swing. */
  SetAutoAttackInterval(intervalMs: number): AutoAttackState {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new Error(`auto attack interval must be a positive integer: ${intervalMs}`);
    }
    this.autoAttackIntervalMs = intervalMs;
    return this.snapshotAutoAttackState();
  }

  /**
   * 开关自动攻击。开启只表示保持攻击意图，当前读条仍须通过10Hz战斗判定后才开始。
   * 关闭会清除目标和读条；开启后离开范围不会清除enabled，只会清零当前读条。
   *
   * Toggles attack intent. Enabling does not start a swing until the 10Hz map
   * decision accepts range and facing. Disabling clears target and swing;
  * losing range keeps enabled but resets only the current swing.
  */
  ToggleAutoAttack(targetUnitId: number, enabled: boolean): AutoAttackState {
    if (typeof enabled !== "boolean") {
      throw new Error(`auto attack enabled must be boolean: ${enabled}`);
    }
    if (enabled && (!Number.isSafeInteger(targetUnitId) || targetUnitId <= 0)) {
      throw new Error(`auto attack target must be a positive UnitId: ${targetUnitId}`);
    }
    this.autoAttackEnabled = enabled;
    this.autoAttackTargetUnitId = enabled ? targetUnitId : 0;
    this.autoAttackPhase = enabled ? AutoAttackPhase.Waiting : AutoAttackPhase.Inactive;
    this.autoAttackSwingStartAtMs = 0;
    return this.snapshotAutoAttackState();
  }

  /** 开始一轮全新的读条；不能用旧的start时间恢复被打断的读条。 / Starts a new swing from zero; an interrupted swing must never reuse its old start time. */
  BeginAutoAttackSwing(nowMs: number): AutoAttackState {
    if (!this.autoAttackEnabled) return this.snapshotAutoAttackState();
    if (!Number.isFinite(nowMs) || nowMs < 0) {
      throw new Error(`auto attack start time must be a non-negative number: ${nowMs}`);
    }
    this.autoAttackPhase = AutoAttackPhase.Swinging;
    this.autoAttackSwingStartAtMs = nowMs;
    return this.snapshotAutoAttackState();
  }

  /**
   * 保持自动攻击激活但清除当前读条；重新满足条件时由BeginAutoAttackSwing从0开始。
   *
   * Keeps attack intent active while clearing the current swing; the next
   * valid window starts at zero through BeginAutoAttackSwing.
   */
  ResetAutoAttackSwing(): AutoAttackState {
    this.autoAttackPhase = this.autoAttackEnabled
      ? AutoAttackPhase.Waiting
      : AutoAttackPhase.Inactive;
    this.autoAttackSwingStartAtMs = 0;
    if (!this.autoAttackEnabled) this.autoAttackTargetUnitId = 0;
    return this.snapshotAutoAttackState();
  }

  private snapshotAutoAttackState(): AutoAttackState {
    return {
      enabled: this.autoAttackEnabled,
      targetUnitId: this.autoAttackTargetUnitId,
      phase: this.autoAttackPhase,
      swingStartAtMs: this.autoAttackSwingStartAtMs,
      swingIntervalMs: this.autoAttackIntervalMs,
    };
  }
}
