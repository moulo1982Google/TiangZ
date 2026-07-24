import { Singleton, SingletonRegistry } from "./Singleton";
import { CoreLogger } from "../logging/Logger";

export interface IUpdate {
  Update(): void;
}

export interface ILateUpdate {
  LateUpdate(): void;
}

export interface IFrameFlush {
  FrameFlush(): void;
}

type UpdateTarget = IUpdate | ILateUpdate | IFrameFlush;

export class UpdateSystem extends Singleton {
  private readonly targets = new Set<UpdateTarget>();
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
    this.targets.add(target);
  }

  /** 从当前与延迟集合中移除目标，后续阶段不再执行它。 / Removes a target from current and deferred sets; it will not run in later phases. */
  Remove(target: UpdateTarget): boolean {
    this.pendingAdds.delete(target);
    return this.targets.delete(target);
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
      this.runPhase("Update", isUpdate, (target) => target.Update());
      this.runPhase("LateUpdate", isLateUpdate, (target) => target.LateUpdate());
      this.runPhase("FrameFlush", isFrameFlush, (target) => target.FrameFlush());
    } finally {
      this.updating = false;
      for (const target of this.pendingAdds) this.targets.add(target);
      this.pendingAdds.clear();
    }
  }

  private runPhase<T extends UpdateTarget>(
    phase: string,
    matches: (target: UpdateTarget) => target is T,
    invoke: (target: T) => void,
  ): void {
    for (const target of this.targets) {
      if (!matches(target)) continue;
      try {
        const result = invoke(target) as unknown;
        if (isPromiseLike(result)) {
          throw new Error(`${phase} must be synchronous: ${target.constructor.name}`);
        }
        this.updateCount += 1;
      } catch (error) {
        this.failedCount += 1;
        CoreLogger.error("update callback failed", {
          component: target.constructor.name,
          phase,
          error,
        });
      }
    }
  }

  protected override OnDestroy(): void {
    this.targets.clear();
    this.pendingAdds.clear();
  }
}

function isUpdateTarget(value: object): value is UpdateTarget {
  return isUpdate(value) || isLateUpdate(value) || isFrameFlush(value);
}

function isUpdate(value: object): value is IUpdate {
  return "Update" in value && typeof value.Update === "function";
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
