import {
  Buff,
  BuffComponent,
  GameConfigs,
  GlobalIdSystem,
  type BuffAddOptions,
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

  /** 添加一个Buff并立即执行AddAction；实例ID由全局生成器保证跨服不冲突。 / Adds a Buff, executes AddAction immediately, and allocates a merge-safe ID. */
  AddBuff(configId: number, options: BuffAddOptions = {}): Buff {
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
    });
    this.publishAdded(buff);
    return buff;
  }

  /** 查询一个Buff实例；调用者不得跨await长期保存返回的子Entity。 / Finds one Buff; callers must not retain the child Entity across await or its owner lifetime. */
  GetBuff(buffInstanceId: bigint): Buff | undefined {
    return this.TryGetChild(Buff, buffInstanceId);
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
        restoring: true,
      });
    }
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
