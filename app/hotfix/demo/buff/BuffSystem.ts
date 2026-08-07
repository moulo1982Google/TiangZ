import {
  ActionType,
  Buff,
  GameConfigs,
  TimeSystem,
  type ActionDefinition,
  type AwakeBuff,
  type BuffPublicState,
  type BuffTransferState,
  Unit,
  systemFor,
} from "#tiangz/model";
import { ActionFromConfig, ExecuteAction } from "../action/ActionExecutor";

/**
 * 单个Buff的生命周期实现。Timer只保存方法名，触发时解析当前Hotfix prototype，支持安全热更。
 * 到期和主动移除都走父BuffComponent.RemoveBuff，保证集合和AOI事件只有一个出口。
 *
 * Implements one Buff lifecycle. Timers keep only method names and resolve the
 * current Hotfix prototype when fired, so hot reload remains safe. Expiration
 * and manual removal both go through BuffComponent.RemoveBuff, leaving one
 * owner for collection changes and AOI events.
 */
@systemFor(Buff)
export class BuffSystem extends Buff {
  protected override Awake(request: AwakeBuff): void {
    if (!Number.isSafeInteger(request.configId) || request.configId <= 0) {
      throw new Error(`buff config id must be positive: ${request.configId}`);
    }
    if (!Number.isFinite(request.appliedAtMs) || request.appliedAtMs < 0) {
      throw new Error(`buff appliedAtMs must be non-negative: ${request.appliedAtMs}`);
    }
    this.configId = request.configId;
    this.stacks = request.stacks ?? 1;
    this.appliedAtMs = request.appliedAtMs;
    this.expireAtMs = request.expireAtMs;
    this.tickIntervalOverrideMs = request.tickIntervalMs;
    this.nextTickAtMs = request.nextTickAtMs;
    this.revision = request.revision;
    this.addAction = request.addAction;
    this.tickAction = request.tickAction;
    this.removeAction = request.removeAction;
    const restoring = request.restoring ?? false;
    if (!Number.isSafeInteger(this.stacks) || this.stacks <= 0) {
      throw new Error(`buff stacks must be positive: ${this.stacks}`);
    }
    this.requireConfig();
    if (!restoring) this.executePhase(this.resolveAction("add"), "add");
    this.scheduleTimers();
  }

  get ConfigId(): number { return this.configId; }
  get Stacks(): number { return this.stacks; }
  get AppliedAtMs(): number { return this.appliedAtMs; }
  get ExpireAtMs(): number { return this.expireAtMs; }
  get NextTickAtMs(): number { return this.nextTickAtMs; }
  get Revision(): number { return this.revision; }

  /** 复制跨地图传输状态，不把TimerId或运行时引用带出当前Process。 / Copies transfer state without leaking TimerIds or runtime references. */
  Snapshot(): BuffTransferState {
    return {
      buffInstanceId: this.Id as bigint,
      configId: this.configId,
      stacks: this.stacks,
      appliedAtMs: this.appliedAtMs,
      expireAtMs: this.expireAtMs,
      tickIntervalMs: this.tickIntervalMs(),
      nextTickAtMs: this.nextTickAtMs,
      revision: this.revision,
    };
  }

  /** 生成AOI公开视图；不要把吸收量等私有战斗细节写到这里。 / Builds the AOI-public view; private combat details such as absorption stay out. */
  PublicState(unitId: number): BuffPublicState {
    return {
      unitId,
      buffInstanceId: this.Id as bigint,
      buffConfigId: this.configId,
      stacks: this.stacks,
      expireTimeMs: BigInt(Math.max(0, Math.floor(this.expireAtMs))),
      revision: this.revision,
    };
  }

  /** Timer入口：先检查墙钟到期，再执行一跳并重新安排下一次。 / Timer entrypoint: checks the wall-clock deadline, applies one tick, then reschedules. */
  protected OnTick(): void {
    const now = TimeSystem.Instance.ServerNow;
    if (this.expireAtMs > 0 && now >= this.expireAtMs) {
      this.ownerBuffComponent.RemoveBuff(this.Id as bigint, "expired");
      return;
    }
    const action = this.resolveAction("tick");
    if (action.type !== ActionType.None) this.executePhase(action, "tick");
    const intervalMs = this.tickIntervalMs();
    this.nextTickAtMs = intervalMs > 0 ? now + intervalMs : 0;
    this.scheduleTick(intervalMs);
  }

  /** 过期Timer入口；通过集合拥有者移除自己，避免子Entity自行修改父索引。 / Expiration entrypoint; asks the owner collection to remove this child instead of mutating its index directly. */
  protected OnExpire(): void {
    if (!this.IsDisposed) this.ownerBuffComponent.RemoveBuff(this.Id as bigint, "expired");
  }

  /** 子Entity销毁时执行一次RemoveAction；主动移除、到期和Unit销毁共用这条边界。 / Executes RemoveAction once when disposed; manual removal, expiration, and Unit disposal share this boundary. */
  protected override OnDestroy(): void {
    if (this.removeActionExecuted) return;
    this.removeActionExecuted = true;
    const action = this.resolveAction("remove");
    if (action.type !== ActionType.None) this.executePhase(action, "remove");
  }

  private scheduleTimers(): void {
    const now = TimeSystem.Instance.ServerNow;
    if (this.expireAtMs > 0) {
      const remaining = Math.max(1, this.expireAtMs - now);
      this.expireTimerId = this.NewOnceTimer(remaining, "OnExpire");
    }
    const intervalMs = this.tickIntervalMs();
    if (intervalMs > 0) {
      const delay = this.nextTickAtMs > 0 ? Math.max(1, this.nextTickAtMs - now) : intervalMs;
      this.scheduleTick(delay);
    }
  }

  private scheduleTick(delayMs: number): void {
    if (this.tickTimerId !== undefined) this.CancelTimer(this.tickTimerId, "manual");
    if (delayMs <= 0 || this.IsDisposed) return;
    this.tickTimerId = this.NewOnceTimer(Math.max(1, delayMs), "OnTick");
  }

  private tickIntervalMs(): number {
    // BuffComponent在创建/恢复时已经把配置和运行时覆盖合并成确定值；这里直接读取，
    // 避免每次Tick重新查询配置，也让0明确表示关闭Tick。
    // BuffComponent resolves config and runtime overrides before creation; read
    // the fixed value here so 0 unambiguously means that ticking is disabled.
    return this.tickIntervalOverrideMs;
  }

  private resolveAction(phase: "add" | "tick" | "remove"): ActionDefinition {
    const config = this.requireConfig();
    const override = phase === "add"
      ? this.addAction
      : phase === "tick"
        ? this.tickAction
        : this.removeAction;
    if (override) return override;
    const type = phase === "add"
      ? config.addActionType
      : phase === "tick"
        ? config.tickActionType
        : config.removeActionType;
    const parameters = phase === "add"
      ? config.addActionParams
      : phase === "tick"
        ? config.tickActionParams
        : config.removeActionParams;
    return ActionFromConfig(type, parameters);
  }

  private executePhase(action: ActionDefinition, phase: string): void {
    ExecuteAction(this.owner, action, {
      sourceBuffInstanceId: this.Id as bigint,
      reason: `buff-${phase}`,
    });
  }

  private requireConfig() {
    return GameConfigs.BuffConfig.Get(this.configId);
  }

  private get owner(): Unit<any[]> {
    return (this.Parent as import("#tiangz/model").BuffComponent).GetParent<Unit<any[]>>();
  }

  private get ownerBuffComponent(): import("#tiangz/model").BuffComponent {
    return this.Parent as import("#tiangz/model").BuffComponent;
  }
}
