import {
  AutoAttackPhase,
  CombatComponent,
  NativeData,
  NativeUnitRef,
  NumericComponent,
  NumericType,
  type AutoAttackState,
  type DamageAbsorption,
  type DamageRequest,
  type DamageResult,
  type HealingResult,
  systemFor,
} from "#tiangz/model";

/** 演示平A间隔；正式项目应由技能/武器配置提供，不要在客户端自行决定。 / Demo swing interval; production projects should read this from skill or weapon config, never from the client. */
export const DEFAULT_AUTO_ATTACK_INTERVAL_MS = 2_000;

/**
 * CombatComponent托管平A状态和Unit本身的伤害/治疗入口；不负责找目标、距离、朝向或怪物生命周期。
 * 地图System只负责选择攻击者和目标，所有目标效果统一从这里结算。
 *
 * CombatComponent owns auto-attack state and the Unit-local damage/healing
 * entrypoints. It does not find targets, check range/facing, or own monster
 * lifecycle. Map Systems select the participants; target effects resolve here.
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

  /**
   * 注册一个受伤前护盾；CombatComponent只保存数据，不知道这个效果来自Buff、技能还是装备。
   * priority越大越先消耗；同优先级按modifierId排序，保证同一帧结果确定。
   *
   * Registers a pre-damage shield. CombatComponent stores only data and does
   * not know whether the effect came from a Buff, skill, or equipment. Higher
   * priorities consume first; ties use modifierId for deterministic results.
   */
  RegisterDamageAbsorber(amount: bigint, priority: number = 0): number {
    validateNonNegativeBigInt(amount, "damage absorber amount");
    validatePriority(priority);
    if (amount === 0n) throw new Error("damage absorber amount must be positive");

    const modifierId = this.allocateDamageAbsorberId();
    this.damageAbsorbers.set(modifierId, {
      modifierId,
      priority,
      remaining: amount,
    });
    return modifierId;
  }

  /** 更新护盾剩余量；主要供Buff恢复、天赋改写和持久化恢复使用。 / Updates remaining shield amount for Buff restore, talent changes, or persistence restore. */
  UpdateDamageAbsorber(modifierId: number, remaining: bigint): boolean {
    validateModifierId(modifierId);
    validateNonNegativeBigInt(remaining, "damage absorber remaining");
    const absorber = this.damageAbsorbers.get(modifierId);
    if (!absorber) return false;
    absorber.remaining = remaining;
    return true;
  }

  /** 查询护盾剩余量；不存在的处理器返回undefined而不是伪造0。 / Reads remaining shield amount; an unknown modifier returns undefined instead of a fake zero. */
  GetDamageAbsorberRemaining(modifierId: number): bigint | undefined {
    validateModifierId(modifierId);
    return this.damageAbsorbers.get(modifierId)?.remaining;
  }

  /** 注销一个受伤前处理器；Buff移除、死亡和组件销毁必须走这里。 / Unregisters a pre-damage modifier; Buff removal, death, and component disposal use this boundary. */
  RemoveDamageAbsorber(modifierId: number): boolean {
    validateModifierId(modifierId);
    return this.damageAbsorbers.delete(modifierId);
  }

  /**
   * 统一伤害入口：先执行CombatComponent已注册的吸收效果，再修改CurrentHp。
   * 这里绝不能查询BuffComponent；Buff只能在添加/移除时注册或注销处理器。
   *
   * Unified damage entrypoint: registered CombatComponent modifiers absorb
   * first, then CurrentHp is changed. This method must never query
   * BuffComponent; Buffs only register and unregister modifiers at lifecycle boundaries.
   */
  ApplyDamage(request: DamageRequest): DamageResult {
    if (!request || typeof request.amount !== "bigint") {
      throw new Error("damage request amount must be bigint");
    }
    validateNonNegativeBigInt(request.amount, "damage amount");
    const owner = this.GetParent();
    const numeric = owner.GetComponent(NumericComponent);
    const currentHp = numeric[NumericType.CurrentHp];
    const native = owner.TryGetComponent(NativeUnitRef);
    if (currentHp <= 0n || native?.alive === 0 || request.amount === 0n) {
      return emptyDamageResult(request.amount, currentHp);
    }

    let pending = request.amount;
    let absorbedDamage = 0n;
    const absorptions: DamageAbsorption[] = [];
    const modifiers = [...this.damageAbsorbers.values()]
      .filter((modifier) => modifier.remaining > 0n)
      .sort((left, right) => right.priority - left.priority || left.modifierId - right.modifierId);
    for (const modifier of modifiers) {
      if (pending === 0n) break;
      const absorbed = pending < modifier.remaining ? pending : modifier.remaining;
      modifier.remaining -= absorbed;
      pending -= absorbed;
      absorbedDamage += absorbed;
      absorptions.push({
        modifierId: modifier.modifierId,
        absorbed,
        remaining: modifier.remaining,
      });
    }

    const finalDamage = pending < currentHp ? pending : currentHp;
    if (finalDamage > 0n) numeric[NumericType.CurrentHp] = currentHp - finalDamage;
    const remainingHp = numeric[NumericType.CurrentHp];
    const killed = currentHp > 0n && remainingHp === 0n;
    if (killed && native) {
      native.alive = 0;
      NativeData.ResetMovement(native.Handle);
    }
    return {
      requestedDamage: request.amount,
      absorbedDamage,
      finalDamage,
      remainingHp,
      killed,
      absorptions,
    };
  }

  /**
   * 统一治疗入口，自动读取MaxHp并限制溢出；道具、Buff Tick和技能都调用它。
   * 治疗不会复活死亡Unit，复活应由单独的业务动作负责。
   *
   * Unified healing entrypoint. It reads MaxHp and clamps overflow; items,
   * Buff ticks, and skills use it. Healing never revives a dead Unit; revive
   * is a separate business action.
   */
  ApplyHealing(amount: bigint): HealingResult {
    validateNonNegativeBigInt(amount, "healing amount");
    const owner = this.GetParent();
    const numeric = owner.GetComponent(NumericComponent);
    const currentHp = numeric[NumericType.CurrentHp];
    const maxHp = numeric[NumericType.MaxHp];
    const native = owner.TryGetComponent(NativeUnitRef);
    if (amount === 0n || currentHp >= maxHp || native?.alive === 0) {
      return { requestedHealing: amount, restoredHealing: 0n, currentHp };
    }
    const nextHp = currentHp + amount < maxHp ? currentHp + amount : maxHp;
    numeric[NumericType.CurrentHp] = nextHp;
    return {
      requestedHealing: amount,
      restoredHealing: nextHp - currentHp,
      currentHp: nextHp,
    };
  }

  private allocateDamageAbsorberId(): number {
    while (this.damageAbsorbers.has(this.nextDamageAbsorberId)) {
      this.nextDamageAbsorberId += 1;
    }
    if (!Number.isSafeInteger(this.nextDamageAbsorberId) || this.nextDamageAbsorberId <= 0) {
      throw new Error("damage absorber id space exhausted");
    }
    const id = this.nextDamageAbsorberId;
    this.nextDamageAbsorberId += 1;
    return id;
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

function validateNonNegativeBigInt(value: bigint, label: string): void {
  if (typeof value !== "bigint" || value < 0n) {
    throw new Error(`${label} must be a non-negative bigint: ${String(value)}`);
  }
}

function validatePriority(priority: number): void {
  if (!Number.isSafeInteger(priority)) {
    throw new Error(`damage modifier priority must be a safe integer: ${priority}`);
  }
}

function validateModifierId(modifierId: number): void {
  if (!Number.isSafeInteger(modifierId) || modifierId <= 0) {
    throw new Error(`damage modifier id must be a positive safe integer: ${modifierId}`);
  }
}

function emptyDamageResult(requestedDamage: bigint, currentHp: bigint): DamageResult {
  return {
    requestedDamage,
    absorbedDamage: 0n,
    finalDamage: 0n,
    remainingHp: currentHp,
    killed: false,
    absorptions: [],
  };
}
