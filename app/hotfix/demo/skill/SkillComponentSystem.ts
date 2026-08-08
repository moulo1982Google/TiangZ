import {
  SkillCastPhase,
  SkillComponent,
  SkillMapComponent,
  PlayerUnit,
  type ActiveSkillCast,
  type ItemCooldownCommitResult,
  type SkillCastCommand,
  type SkillCastState,
  type SkillTransferState,
  TimeSystem,
  type Unit,
  type ITransfer,
  systemFor,
} from "#tiangz/model";

/** Unit级技能状态实现；目标查找、距离与效果结算交给地图级调度器。 / Unit-local skill state; target resolution, range, and effects belong to the map scheduler. */
@systemFor(SkillComponent)
export class SkillComponentSystem extends SkillComponent implements ITransfer<SkillTransferState> {
  /** Unit销毁时清空瞬态技能状态；不发布网络事件。 / Clears transient skill state on Unit disposal without publishing network events. */
  protected override OnDestroy(): void {
    this.activeCast = null;
    this.queuedCast = null;
    this.cooldownEndBySkillId.clear();
    this.cooldownEndByItemConfigId.clear();
  }

  Cast(command: SkillCastCommand): SkillCastState {
    return this.DomainScene().GetComponent(SkillMapComponent).Cast(this.owner, command);
  }

  InterruptByMovement(): boolean {
    if (!this.activeCast) return false;
    return this.DomainScene().GetComponent(SkillMapComponent).InterruptByMovement(this.owner);
  }

  IsCasting(): boolean {
    return this.activeCast !== null;
  }

  State(skillId: number = this.activeCast?.skillId ?? 0): SkillCastState {
    return {
      phase: this.activeCast ? SkillCastPhase.Casting : SkillCastPhase.Idle,
      castId: this.activeCast?.castId ?? 0n,
      skillId: this.activeCast?.skillId ?? skillId,
      targetUnitId: this.activeCast?.targetUnitId ?? 0,
      startedAtMs: this.activeCast?.startedAtMs ?? 0,
      finishAtMs: this.activeCast?.finishAtMs ?? 0,
      globalCooldownEndAtMs: this.globalCooldownEndAtMs,
      skillCooldownEndAtMs: this.cooldownEndBySkillId.get(skillId) ?? 0,
      channelTickIndex: this.activeCast?.channelTicksCompleted ?? 0,
      channelTickCount: this.activeCast?.definition.channelTicks ?? 0,
      queuedSkillId: this.queuedCast?.command.skillId ?? 0,
      queuedTargetUnitId: this.queuedCast?.command.targetUnitId ?? 0,
      queueDeadlineAtMs: this.queuedCast?.deadlineAtMs ?? 0,
      interruptReason: this.lastInterruptReason,
    };
  }

  /** 地图调度器在所有校验通过后原子提交读条和冷却。 / Atomically commits cast and cooldown state after map-level validation succeeds. */
  Accept(
    cast: ActiveSkillCast,
    cooldownMs: number,
    globalCooldownMs: number,
  ): SkillCastState {
    if (this.activeCast) throw new Error(`Unit ${this.owner.UnitId} is already casting`);
    this.queuedCast = null;
    this.activeCast = cast;
    this.lastInterruptReason = "";
    this.globalCooldownEndAtMs = cast.startedAtMs + globalCooldownMs;
    this.cooldownEndBySkillId.set(cast.skillId, cast.startedAtMs + cooldownMs);
    return this.State(cast.skillId);
  }

  /** 在当前读条结束前缓存一个技能请求；不提前消耗CD，真正开始时重新走地图校验。 / Queues one skill before the current cast ends without consuming cooldown; map validation runs again when it starts. */
  Queue(command: SkillCastCommand, deadlineAtMs: number): SkillCastState {
    if (!this.activeCast) throw new Error(`Unit ${this.owner.UnitId} has no active cast to queue behind`);
    if (this.queuedCast) throw new Error(`Unit ${this.owner.UnitId} already has a queued skill`);
    if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs < this.activeCast.startedAtMs) {
      throw new Error(`invalid skill queue deadline: ${deadlineAtMs}`);
    }
    this.queuedCast = { command: { ...command }, deadlineAtMs };
    return this.State();
  }

  /** 取出并清空缓存技能；调用方必须立即调用Cast，让所有规则重新生效。 / Takes and clears the queued skill; the caller must immediately invoke Cast so all rules run again. */
  TakeQueued(): SkillCastCommand | undefined {
    const queued = this.queuedCast?.command;
    this.queuedCast = null;
    return queued;
  }

  /** 清除缓存技能而不影响当前读条或已提交冷却。 / Clears the queued skill without affecting the active cast or committed cooldowns. */
  ClearQueued(): SkillCastState {
    this.queuedCast = null;
    return this.State();
  }

  /** 更新引导进度；只允许地图调度器按当前CastId推进，避免旧Cast写入新状态。 / Updates channel progress only for the active CastId so an old cast cannot mutate a new state. */
  UpdateChannel(castId: bigint, nextTickAtMs: number, channelTicksCompleted: number): SkillCastState {
    const active = this.activeCast;
    if (active?.castId !== castId) return this.State();
    if (!Number.isSafeInteger(nextTickAtMs) || !Number.isSafeInteger(channelTicksCompleted) || channelTicksCompleted < 0) {
      throw new Error(`invalid channel progress: ${nextTickAtMs}, ${channelTicksCompleted}`);
    }
    this.activeCast = {
      ...active,
      nextTickAtMs,
      channelTicksCompleted,
    };
    return this.State();
  }

  /** 返回当前技能与公共冷却是否可用；不修改状态。 / Checks skill and global cooldown deadlines without mutation. */
  ReadyAt(skillId: number): number {
    return Math.max(
      this.globalCooldownEndAtMs,
      this.cooldownEndBySkillId.get(skillId) ?? 0,
    );
  }

  /** 返回指定道具与玩家公共冷却的最晚截止时间；道具和技能共享同一条GCD。 / Returns the later item or shared-player GCD deadline; items and skills participate in the same GCD. */
  ItemReadyAt(itemConfigId: number): number {
    return Math.max(
      this.globalCooldownEndAtMs,
      this.cooldownEndByItemConfigId.get(itemConfigId) ?? 0,
    );
  }

  /** 原子检查并提交道具自身CD与共享GCD；调用失败时不修改任何冷却。 / Atomically checks and commits the item CD plus shared GCD, leaving all state unchanged on rejection. */
  TryCommitItemCooldown(
    itemConfigId: number,
    cooldownMs: number,
    globalCooldownMs: number,
  ): ItemCooldownCommitResult {
    if (!Number.isSafeInteger(itemConfigId) || itemConfigId <= 0) {
      throw new Error(`invalid item config id: ${itemConfigId}`);
    }
    if (
      !Number.isSafeInteger(cooldownMs) || cooldownMs < 0 ||
      !Number.isSafeInteger(globalCooldownMs) || globalCooldownMs < 0
    ) {
      throw new Error(`invalid item cooldown: item=${itemConfigId}, cooldown=${cooldownMs}, gcd=${globalCooldownMs}`);
    }
    const now = TimeSystem.Instance.ServerNow;
    const readyAtMs = this.ItemReadyAt(itemConfigId);
    if (readyAtMs > now) {
      return {
        accepted: false,
        readyAtMs,
        globalCooldownEndAtMs: this.globalCooldownEndAtMs,
        itemCooldownEndAtMs: this.cooldownEndByItemConfigId.get(itemConfigId) ?? 0,
      };
    }
    this.globalCooldownEndAtMs = now + globalCooldownMs;
    const itemCooldownEndAtMs = now + cooldownMs;
    this.cooldownEndByItemConfigId.set(itemConfigId, itemCooldownEndAtMs);
    return {
      accepted: true,
      readyAtMs: now,
      globalCooldownEndAtMs: this.globalCooldownEndAtMs,
      itemCooldownEndAtMs,
    };
  }

  /** 读条完成后清空活动Cast，保留已经提交的冷却。 / Clears a completed cast while preserving committed cooldowns. */
  Complete(castId: bigint): SkillCastState {
    if (this.activeCast?.castId !== castId) return this.State();
    const skillId = this.activeCast.skillId;
    this.activeCast = null;
    this.queuedCast = null;
    this.lastInterruptReason = "";
    return this.State(skillId);
  }

  /** 打断只清除读条，不回退GCD和技能CD；所有法术已经在接受时消耗这些状态。 / Interrupts the cast without refunding GCD or skill cooldown committed at acceptance. */
  Interrupt(reason: string): SkillCastState | undefined {
    if (!this.activeCast) return undefined;
    const skillId = this.activeCast.skillId;
    this.activeCast = null;
    this.queuedCast = null;
    this.lastInterruptReason = reason;
    return this.State(skillId);
  }

  ActiveCast(): ActiveSkillCast | undefined {
    return this.activeCast ?? undefined;
  }

  /** 复制仍有效的冷却截止时间；活动读条不跨地图恢复。 / Copies live cooldown deadlines while intentionally excluding active casts. */
  CaptureTransfer(): SkillTransferState {
    const now = TimeSystem.Instance.ServerNow;
    return {
      globalCooldownEndAtMs: this.globalCooldownEndAtMs > now ? this.globalCooldownEndAtMs : 0,
      cooldowns: [...this.cooldownEndBySkillId.entries()]
        .filter(([, endAtMs]) => endAtMs > now)
        .map(([skillId, cooldownEndAtMs]) => ({ skillId, cooldownEndAtMs })),
      itemCooldowns: [...this.cooldownEndByItemConfigId.entries()]
        .filter(([, endAtMs]) => endAtMs > now)
        .map(([itemConfigId, cooldownEndAtMs]) => ({ itemConfigId, cooldownEndAtMs })),
    };
  }

  /** 恢复冷却并清除源地图读条；不得把传送当成刷新技能的手段。 / Restores cooldowns and clears source-map casting so transfer cannot refresh abilities. */
  RestoreTransfer(state: SkillTransferState): void {
    this.activeCast = null;
    this.queuedCast = null;
    this.lastInterruptReason = "map-transfer";
    this.globalCooldownEndAtMs = Math.max(0, state.globalCooldownEndAtMs);
    this.cooldownEndBySkillId.clear();
    this.cooldownEndByItemConfigId.clear();
    const now = TimeSystem.Instance.ServerNow;
    for (const cooldown of state.cooldowns) {
      if (!Number.isSafeInteger(cooldown.skillId) || cooldown.skillId <= 0) {
        throw new Error(`invalid transferred skill id: ${cooldown.skillId}`);
      }
      if (cooldown.cooldownEndAtMs > now) {
        this.cooldownEndBySkillId.set(cooldown.skillId, cooldown.cooldownEndAtMs);
      }
    }
    for (const cooldown of state.itemCooldowns) {
      if (!Number.isSafeInteger(cooldown.itemConfigId) || cooldown.itemConfigId <= 0) {
        throw new Error(`invalid transferred item config id: ${cooldown.itemConfigId}`);
      }
      if (cooldown.cooldownEndAtMs > now) {
        this.cooldownEndByItemConfigId.set(cooldown.itemConfigId, cooldown.cooldownEndAtMs);
      }
    }
  }

  private get owner(): PlayerUnit {
    const owner = this.GetParent<Unit<any[]>>();
    if (!(owner instanceof PlayerUnit)) {
      throw new Error(`skill command owner must be PlayerUnit: ${owner.constructor.name}`);
    }
    return owner;
  }
}
