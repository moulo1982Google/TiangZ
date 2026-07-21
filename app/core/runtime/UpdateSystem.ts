import { Singleton, SingletonRegistry } from "./Singleton";

export interface IUpdate {
  Update(): void;
}

export class UpdateSystem extends Singleton {
  private readonly targets = new Set<IUpdate>();
  private readonly pendingAdds = new Set<IUpdate>();
  private updating = false;
  private updateCount = 0;
  private failedCount = 0;

  static get Instance(): UpdateSystem {
    return SingletonRegistry.Get(UpdateSystem);
  }

  static TryRegister(value: object): void {
    if (!isUpdate(value)) return;
    SingletonRegistry.TryGet(UpdateSystem)?.Add(value);
  }

  static TryUnregister(value: object): void {
    if (!isUpdate(value)) return;
    SingletonRegistry.TryGet(UpdateSystem)?.Remove(value);
  }

  Add(target: IUpdate): void {
    if (this.updating) {
      this.pendingAdds.add(target);
      return;
    }
    this.targets.add(target);
  }

  Remove(target: IUpdate): boolean {
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
      for (const target of this.targets) {
        try {
          const result = target.Update() as unknown;
          if (isPromiseLike(result)) {
            throw new Error(`IUpdate.Update must be synchronous: ${target.constructor.name}`);
          }
          this.updateCount += 1;
        } catch (error) {
          this.failedCount += 1;
          console.error(`[UpdateSystem] ${target.constructor.name}.Update failed`, error);
        }
      }
    } finally {
      this.updating = false;
      for (const target of this.pendingAdds) this.targets.add(target);
      this.pendingAdds.clear();
    }
  }

  protected override OnDestroy(): void {
    this.targets.clear();
    this.pendingAdds.clear();
  }
}

function isUpdate(value: object): value is IUpdate {
  return "Update" in value && typeof value.Update === "function";
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}
