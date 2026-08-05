import { Singleton, SingletonRegistry } from "./Singleton";
import { CoreLogger } from "../logging/Logger";
import { TimeSystem } from "./TimeSystem";

/**
 * 20Hz固定逻辑桶；保留旧的Update命名，避免已有业务升级时改变语义。
 *
 * The 20Hz fixed logic bucket keeps the legacy Update name so existing
 * business code does not change its timing semantics during the migration.
 */
export interface IUpdate {
  Update(): void;
}

/** 10Hz固定逻辑桶；用于战斗可用性和读条推进等中频判定。 / Fixed 10Hz bucket for combat readiness and cast progress. */
export interface IUpdate10Hz {
  Update10Hz(): void;
}

/** 5Hz固定逻辑桶；用于怪物AI等不需要每个逻辑帧运行的判定。 / Fixed 5Hz bucket for decisions such as monster AI. */
export interface IUpdate5Hz {
  Update5Hz(): void;
}

/** 1Hz固定逻辑桶；用于重生、清理和低频维护。 / Fixed 1Hz bucket for respawn, cleanup, and maintenance. */
export interface IUpdate1Hz {
  Update1Hz(): void;
}

export interface ILateUpdate {
  LateUpdate(): void;
}

export interface IFrameFlush {
  FrameFlush(): void;
}

type UpdateTarget = IUpdate | IUpdate10Hz | IUpdate5Hz | IUpdate1Hz | ILateUpdate | IFrameFlush;

export class UpdateSystem extends Singleton {
  private readonly targets = new Set<UpdateTarget>();
  private readonly update10Targets = new Set<IUpdate10Hz>();
  private readonly update5Targets = new Set<IUpdate5Hz>();
  private readonly update1Targets = new Set<IUpdate1Hz>();
  private readonly updateTargets = new Set<IUpdate>();
  private readonly lateTargets = new Set<ILateUpdate>();
  private readonly frameFlushTargets = new Set<IFrameFlush>();
  private readonly pendingAdds = new Set<UpdateTarget>();
  private updating = false;
  private updateCount = 0;
  private failedCount = 0;

  static get Instance(): UpdateSystem {
    return SingletonRegistry.Get(UpdateSystem);
  }

  /** 注册实现某个 Update 阶段的对象；Component 挂载时会自动调用。 / Registers objects that implement an update phase; Component attachment calls this automatically. */
  static TryRegister(value: object): void {
    if (!isUpdateTarget(value)) return;
    SingletonRegistry.TryGet(UpdateSystem)?.Add(value);
  }

  /** Component 被移除或销毁时注销其 Update 目标。 / Removes an update target when its Component is detached or disposed. */
  static TryUnregister(value: object): void {
    if (!isUpdateTarget(value)) return;
    SingletonRegistry.TryGet(UpdateSystem)?.Remove(value);
  }

  /** 添加目标，同时禁止在活动帧中直接修改正在遍历的集合。 / Adds a target without allowing collection mutation during an active frame. */
  Add(target: UpdateTarget): void {
    if (this.updating) {
      this.pendingAdds.add(target);
      return;
    }
    this.registerTarget(target);
  }

  /** 从当前与延迟集合中移除目标，后续阶段不再执行它。 / Removes a target from current and deferred sets; it will not run in later phases. */
  Remove(target: UpdateTarget): boolean {
    this.pendingAdds.delete(target);
    const removed = this.targets.delete(target);
    this.updateTargets.delete(target as IUpdate);
    this.update10Targets.delete(target as IUpdate10Hz);
    this.update5Targets.delete(target as IUpdate5Hz);
    this.update1Targets.delete(target as IUpdate1Hz);
    this.lateTargets.delete(target as ILateUpdate);
    this.frameFlushTargets.delete(target as IFrameFlush);
    return removed;
  }

  get Count(): number {
    return this.targets.size + this.pendingAdds.size;
  }

  get UpdateCount(): number {
    return this.updateCount;
  }

  get FailedCount(): number {
    return this.failedCount;
  }

  __update(): void {
    this.updating = true;
    try {
      const frame = TimeSystem.Instance.FrameCount;
      this.runPhase("Update", this.updateTargets, (target) => target.Update());
      if (frame % 2 === 0) {
        this.runPhase("Update10Hz", this.update10Targets, (target) => target.Update10Hz());
      }
      if (frame % 4 === 0) {
        this.runPhase("Update5Hz", this.update5Targets, (target) => target.Update5Hz());
      }
      if (frame % 20 === 0) {
        this.runPhase("Update1Hz", this.update1Targets, (target) => target.Update1Hz());
      }
      this.runPhase("LateUpdate", this.lateTargets, (target) => target.LateUpdate());
      this.runPhase("FrameFlush", this.frameFlushTargets, (target) => target.FrameFlush());
    } finally {
      this.updating = false;
      for (const target of this.pendingAdds) this.registerTarget(target);
      this.pendingAdds.clear();
    }
  }

  private registerTarget(target: UpdateTarget): void {
    this.targets.add(target);
    if (isUpdate(target)) this.updateTargets.add(target);
    if (isUpdate10Hz(target)) this.update10Targets.add(target);
    if (isUpdate5Hz(target)) this.update5Targets.add(target);
    if (isUpdate1Hz(target)) this.update1Targets.add(target);
    if (isLateUpdate(target)) this.lateTargets.add(target);
    if (isFrameFlush(target)) this.frameFlushTargets.add(target);
  }

  private runPhase<T extends object>(
    phase: string,
    targets: ReadonlySet<T>,
    invoke: (target: T) => void,
  ): void {
    for (const target of targets) {
      try {
        const result = invoke(target) as unknown;
        if (isPromiseLike(result)) {
          throw new Error(`${phase} must be synchronous: ${targetName(target)}`);
        }
        this.updateCount += 1;
      } catch (error) {
        this.failedCount += 1;
        CoreLogger.error("update callback failed", {
          component: targetName(target),
          phase,
          error,
        });
      }
    }
  }

  protected override OnDestroy(): void {
    this.targets.clear();
    this.updateTargets.clear();
    this.update10Targets.clear();
    this.update5Targets.clear();
    this.update1Targets.clear();
    this.lateTargets.clear();
    this.frameFlushTargets.clear();
    this.pendingAdds.clear();
  }
}

function targetName(target: object): string {
  return target.constructor.name;
}

function isUpdateTarget(value: object): value is UpdateTarget {
  return isUpdate(value) || isUpdate10Hz(value) || isUpdate5Hz(value) || isUpdate1Hz(value)
    || isLateUpdate(value) || isFrameFlush(value);
}

function isUpdate(value: object): value is IUpdate {
  return "Update" in value && typeof value.Update === "function";
}

function isUpdate10Hz(value: object): value is IUpdate10Hz {
  return "Update10Hz" in value && typeof value.Update10Hz === "function";
}

function isUpdate5Hz(value: object): value is IUpdate5Hz {
  return "Update5Hz" in value && typeof value.Update5Hz === "function";
}

function isUpdate1Hz(value: object): value is IUpdate1Hz {
  return "Update1Hz" in value && typeof value.Update1Hz === "function";
}

function isLateUpdate(value: object): value is ILateUpdate {
  return "LateUpdate" in value && typeof value.LateUpdate === "function";
}

function isFrameFlush(value: object): value is IFrameFlush {
  return "FrameFlush" in value && typeof value.FrameFlush === "function";
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}
