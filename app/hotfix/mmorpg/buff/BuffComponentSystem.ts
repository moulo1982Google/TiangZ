import {
  Buff,
  BuffApplyStatus,
  BuffConflictPolicy,
  BuffComponent,
  BuffRefreshStatePolicy,
  BuffRefreshTickPolicy,
  BuffStackScope,
  GameConfigs,
  GlobalIdSystem,
  type BuffAddOptions,
  type BuffApplyResult,
  type BuffPublicState,
  type BuffTransferState,
  type ITransfer,
  MapComponent,
  MapScene,
  TimeSystem,
  type Unit,
  systemFor,
} from "#tiangz/model";

/**
 * Buff集合的唯一拥有者。它负责实例ID、传输快照和AOI事件；单个Buff的规则在BuffSystem。
 * Buff不会参与受伤入口，护盾等未来效果应在添加/移除时注册Combat修改器。
 *
 * The sole owner of the Buff collection. It owns instance IDs, transfer
 * snapshots, and AOI events; per-Buff rules live in BuffSystem. Buffs never
 * become the damage entrypoint; future shields register Combat modifiers at
 * add/remove boundaries.
 */
@systemFor(BuffComponent)
export class BuffComponentSystem extends BuffComponent implements ITransfer<readonly BuffTransferState[]> {
  protected override Awake(): void {
    // 空集合是合法初始状态；具体Buff由道具或业务工厂添加。
    // An empty collection is valid; items or business factories add Buffs later.
  }

  /** Core会先级联销毁子Buff；这里保留显式生命周期钩子，便于业务扩展离线/统计清理。 / Core disposes child Buffs first; keep an explicit hook for future business cleanup and metrics. */
  protected override OnDestroy(): void {
    // 子Buff的OnDestroy由ChildEntity所有权链调用，不能在这里重复RemoveChild。
    // Child Buff OnDestroy runs through the ownership chain; do not remove children twice here.
  }

  /**
   * 应用Buff并同步完成冲突决策。该方法不包含await，所以同一Map V8内的检查与提交不可被另一条业务消息插入。
   * 刷新不会重复执行AddAction；Replace会完整移除旧实例后再创建新实例。
   *
   * Applies a Buff and resolves conflicts synchronously. No await exists, so
   * another business message cannot interleave the check and commit in one Map
   * V8. Refresh never replays AddAction; Replace fully removes the old instance.
   */
  ApplyBuff(configId: number, options: BuffAddOptions = {}): BuffApplyResult {
    const config = GameConfigs.BuffConfig.Get(configId);
    const sourceUnitId = options.sourceUnitId ?? 0;
    const sourceAbilityId = options.sourceAbilityId ?? 0;
    const priority = options.conflictPriority ?? config.conflictPriority;
    validateSourceUnitId(sourceUnitId);
    validateConfigId(sourceAbilityId, "sourceAbilityId", true);
    validatePriority(priority);

    const conflicts = this.GetChildren(Buff).filter((buff) => {
      const current = GameConfigs.BuffConfig.Get(buff.ConfigId);
      if (current.stackGroup !== config.stackGroup) return false;
      return config.stackScope !== BuffStackScope.Source || buff.SourceUnitId === sourceUnitId;
    });

    if (config.conflictPolicy === BuffConflictPolicy.Stack || conflicts.length === 0) {
      return { status: BuffApplyStatus.Applied, buff: this.createBuff(configId, options) };
    }

    const current = conflicts.reduce((selected, item) => (
      item.ConflictPriority > selected.ConflictPriority ? item : selected
    ));
    if (config.conflictPolicy === BuffConflictPolicy.Reject) {
      return { status: BuffApplyStatus.Rejected, buff: current, reason: "conflict-rejected" };
    }
    if (
      config.conflictPolicy === BuffConflictPolicy.HigherWins &&
      priority < current.ConflictPriority
    ) {
      return { status: BuffApplyStatus.Rejected, buff: current, reason: "lower-priority" };
    }

    const shouldReplace = config.conflictPolicy === BuffConflictPolicy.Replace || (
      config.conflictPolicy === BuffConflictPolicy.HigherWins && priority > current.ConflictPriority
    );
    if (shouldReplace) {
      const replacedBuffInstanceId = current.Id as bigint;
      this.RemoveBuff(replacedBuffInstanceId, "conflict-replaced");
      return {
        status: BuffApplyStatus.Replaced,
        buff: this.createBuff(configId, options),
        replacedBuffInstanceId,
      };
    }

    if (config.refreshRuntimeState === BuffRefreshStatePolicy.Reset) {
      throw new Error(
        `BuffConfig ${configId} requests refresh runtime reset; use Replace policy for lifecycle-owned state`,
      );
    }
    const now = TimeSystem.Instance.ServerNow;
    const durationMs = options.durationMs ?? config.durationSeconds * 1_000;
    const tickIntervalMs = options.tickIntervalMs ?? config.tickIntervalMs;
    validateDuration(durationMs, "durationMs");
    validateDuration(tickIntervalMs, "tickIntervalMs");
    current.Refresh({
      nowMs: now,
      expireAtMs: durationMs > 0 ? now + durationMs : 0,
      tickIntervalMs,
      resetTickCadence: config.refreshTickPolicy === BuffRefreshTickPolicy.ResetCadence,
      updateSource: config.refreshSource,
      sourceUnitId,
      sourceAbilityId,
      conflictPriority: priority,
    });
    this.publishAdded(current);
    return { status: BuffApplyStatus.Refreshed, buff: current };
  }

  /** 添加Buff的简便接口；需要处理“拒绝”结果的技能必须改用ApplyBuff。 / Convenience API; skills that need rejected results must call ApplyBuff instead. */
  AddBuff(configId: number, options: BuffAddOptions = {}): Buff {
    const result = this.ApplyBuff(configId, options);
    if (result.status === BuffApplyStatus.Rejected || !result.buff) {
      throw new Error(`BuffConfig ${configId} rejected: ${result.reason ?? "unknown"}`);
    }
    return result.buff;
  }

  private createBuff(configId: number, options: BuffAddOptions): Buff {
    const config = GameConfigs.BuffConfig.Get(configId);
    const now = TimeSystem.Instance.ServerNow;
    const durationMs = options.durationMs ?? config.durationSeconds * 1_000;
    const tickIntervalMs = options.tickIntervalMs ?? config.tickIntervalMs;
    validateDuration(durationMs, "durationMs");
    validateDuration(tickIntervalMs, "tickIntervalMs");
    const buff = this.AddChild(Buff, GlobalIdSystem.Instance.Next(), {
      configId,
      stacks: options.stacks ?? 1,
      appliedAtMs: now,
      expireAtMs: durationMs > 0 ? now + durationMs : 0,
      tickIntervalMs,
      nextTickAtMs: tickIntervalMs > 0 ? now + tickIntervalMs : 0,
      revision: 1,
      addAction: options.addAction,
      tickAction: options.tickAction,
      removeAction: options.removeAction,
      sourceUnitId: options.sourceUnitId ?? 0,
      sourceAbilityId: options.sourceAbilityId ?? 0,
      conflictPriority: options.conflictPriority ?? config.conflictPriority,
    });
    this.publishAdded(buff);
    return buff;
  }

  /** 查询一个Buff实例；调用者不得跨await长期保存返回的子Entity。 / Finds one Buff; callers must not retain the child Entity across await or its owner lifetime. */
  GetBuff(buffInstanceId: bigint): Buff | undefined {
    return this.TryGetChild(Buff, buffInstanceId);
  }

  /** 查询目标是否拥有某配置Buff；只用于同步规则判断，不要跨await保存返回实例。 / Tests for a configured Buff during synchronous rule checks; never retain the instance across await. */
  HasBuffConfig(configId: number): boolean {
    return this.GetChildren(Buff).some((buff) => buff.ConfigId === configId);
  }

  /** 移除Buff并触发RemoveAction和AOI移除事件；不存在时保持幂等。 / Removes a Buff, runs RemoveAction, and publishes its AOI removal; missing IDs are idempotent. */
  RemoveBuff(buffInstanceId: bigint, reason: string = "manual"): boolean {
    const buff = this.TryGetChild(Buff, buffInstanceId);
    if (!buff) return false;
    const publicState = buff.PublicState(this.owner.UnitId);
    this.RemoveChild(Buff, buffInstanceId);
    this.publishRemoved(publicState);
    return true;
  }

  /** 返回稳定数组快照；子Buff仍归本Component所有。 / Returns a stable array snapshot while children remain owned by this Component. */
  GetBuffs(): readonly Buff[] {
    return this.GetChildren(Buff);
  }

  /** 生成当前Unit的公开Buff列表，用于AOI进入快照。 / Builds the Unit's public Buff list for AOI entry snapshots. */
  SnapshotPublic(): readonly BuffPublicState[] {
    return this.GetChildren(Buff).map((buff) => buff.PublicState(this.owner.UnitId));
  }

  /** 复制跨地图状态；Timer会在目标Buff Awake时按墙钟剩余时间重建。 / Captures cross-map state; timers are recreated from wall-clock remaining time during target Awake. */
  CaptureTransfer(): readonly BuffTransferState[] {
    return this.GetChildren(Buff).map((buff) => buff.Snapshot());
  }

  /** 用迁移快照替换初始集合；已经过期的Buff不再创建。 / Replaces the target collection and skips Buffs already expired by wall-clock time. */
  RestoreTransfer(states: readonly BuffTransferState[]): void {
    for (const buff of this.GetChildren(Buff)) this.RemoveChild(Buff, buff.Id);
    const now = TimeSystem.Instance.ServerNow;
    for (const state of states) {
      if (state.expireAtMs > 0 && state.expireAtMs <= now) continue;
      this.AddChild(Buff, state.buffInstanceId, {
        configId: state.configId,
        stacks: state.stacks,
        appliedAtMs: state.appliedAtMs,
        expireAtMs: state.expireAtMs,
        tickIntervalMs: state.tickIntervalMs,
        nextTickAtMs: state.nextTickAtMs,
        revision: state.revision,
        sourceUnitId: state.sourceUnitId,
        sourceAbilityId: state.sourceAbilityId,
        conflictPriority: state.conflictPriority,
        restoringDamageAbsorberRemaining: state.damageAbsorberRemaining,
        addAction: state.addAction,
        tickAction: state.tickAction,
        removeAction: state.removeAction,
        restoring: true,
      });
    }
  }

  /**
   * 应用DBProxy已提交的确定Buff实例。相同实例保持幂等；已过期结果不重新创建。
   * 该入口以restoring模式创建，因此事务Planner必须拒绝带AddAction副作用的Buff。
   * Applies one exact Buff instance committed by DBProxy. Existing instances
   * are idempotent and expired results are not recreated. Creation uses restore
   * mode, so the planner must reject Buffs whose AddAction has side effects.
   */
  ApplyCommittedBuff(state: BuffTransferState): BuffPublicState | undefined {
    const existing = this.TryGetChild(Buff, state.buffInstanceId);
    if (existing) {
      const current = existing.Snapshot();
      if (current.configId !== state.configId) {
        throw new Error(`committed Buff conflicts with local instance: ${state.buffInstanceId}`);
      }
      // Tick、刷新或后续业务可能已经推进nextTick/revision；旧回执只确认实例身份，不能回退运行状态。
      // Ticks, refreshes, or later gameplay may have advanced nextTick/revision;
      // an old receipt confirms instance identity and must not roll runtime state back.
      return existing.PublicState(this.owner.UnitId);
    }
    const now = TimeSystem.Instance.ServerNow;
    if (state.expireAtMs > 0 && state.expireAtMs <= now) return undefined;
    const buff = this.AddChild(Buff, state.buffInstanceId, {
      configId: state.configId,
      stacks: state.stacks,
      appliedAtMs: state.appliedAtMs,
      expireAtMs: state.expireAtMs,
      tickIntervalMs: state.tickIntervalMs,
      nextTickAtMs: state.nextTickAtMs,
      revision: state.revision,
      sourceUnitId: state.sourceUnitId,
      sourceAbilityId: state.sourceAbilityId,
      conflictPriority: state.conflictPriority,
      restoringDamageAbsorberRemaining: state.damageAbsorberRemaining,
      addAction: state.addAction,
      tickAction: state.tickAction,
      removeAction: state.removeAction,
      restoring: true,
    });
    this.publishAdded(buff);
    return buff.PublicState(this.owner.UnitId);
  }

  /** 反序列化后确认每个Buff仍有合法配置；业务恢复逻辑留在BuffSystem，而不是Core。 / Validates Buff configs after deserialization; business restoration stays in BuffSystem, not Core. */
  Deserialize(): void {
    for (const buff of this.GetChildren(Buff)) GameConfigs.BuffConfig.Get(buff.ConfigId);
  }

  private publishAdded(buff: Buff): void {
    const map = this.tryMap();
    if (!map || !map.Audience.IsAttached(this.owner)) return;
    void map.PublishBuffAdded(this.owner, buff.PublicState(this.owner.UnitId)).catch((error) => {
      this.DomainScene().logger.error("buff added broadcast failed", {
        unitId: this.owner.UnitId,
        buffInstanceId: buff.Id,
        error,
      });
    });
  }

  private publishRemoved(publicState: BuffPublicState): void {
    const map = this.tryMap();
    if (!map) return;
    if (!map.Audience.IsAttached(this.owner)) return;
    void map.PublishBuffRemoved(this.owner, publicState).catch((error) => {
      this.DomainScene().logger.error("buff removed broadcast failed", {
        unitId: this.owner.UnitId,
        buffInstanceId: publicState.buffInstanceId,
        error,
      });
    });
  }

  private tryMap(): MapComponent | undefined {
    try {
      return this.DomainScene<MapScene>().GetComponent(MapComponent);
    } catch {
      return undefined;
    }
  }

  private get owner(): Unit<any[]> {
    return this.GetParent<Unit<any[]>>();
  }
}

function validateDuration(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`buff ${name} must be a non-negative integer: ${value}`);
  }
}

function validateSourceUnitId(value: number): void {
  validateConfigId(value, "sourceUnitId", true);
}

function validateConfigId(value: number, name: string, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`buff ${name} must be ${allowZero ? "a non-negative" : "a positive"} safe integer: ${value}`);
  }
}

function validatePriority(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`buff conflictPriority must be a non-negative safe integer: ${value}`);
  }
}
