export type SingletonCtor<T extends Singleton = Singleton> = new () => T;

export abstract class Singleton {
  /** Releases singleton-owned resources during registry teardown. */
  protected OnDestroy(): void {}

  __destroy(): void {
    this.OnDestroy();
  }
}

export class SingletonRegistry {
  private static readonly instances = new Map<Function, Singleton>();

  /** Creates exactly one process-local singleton; duplicate registration is a configuration error. */
  static Add<T extends Singleton>(ctor: SingletonCtor<T>): T {
    if (this.instances.has(ctor)) {
      throw new Error(`singleton already exists: ${ctor.name}`);
    }
    const instance = new ctor();
    this.instances.set(ctor, instance);
    return instance;
  }

  /** Returns a required process-local singleton and throws before bootstrap or after teardown. */
  static Get<T extends Singleton>(ctor: SingletonCtor<T>): T {
    const instance = this.TryGet(ctor);
    if (!instance) throw new Error(`singleton not found: ${ctor.name}`);
    return instance;
  }

  /** Looks up a singleton without creating it, which is suitable for optional lifecycle hooks. */
  static TryGet<T extends Singleton>(ctor: SingletonCtor<T>): T | undefined {
    return this.instances.get(ctor) as T | undefined;
  }

  /** Removes and destroys one singleton immediately. */
  static Remove<T extends Singleton>(ctor: SingletonCtor<T>): boolean {
    const instance = this.TryGet(ctor);
    if (!instance) return false;
    this.instances.delete(ctor);
    instance.__destroy();
    return true;
  }

  /** Destroys all singletons in reverse creation order during process shutdown. */
  static DestroyAll(): void {
    const instances = [...this.instances.values()].reverse();
    this.instances.clear();
    for (const instance of instances) instance.__destroy();
  }
}
