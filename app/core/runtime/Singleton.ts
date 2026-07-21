export type SingletonCtor<T extends Singleton = Singleton> = new () => T;

export abstract class Singleton {
  protected OnDestroy(): void {}

  __destroy(): void {
    this.OnDestroy();
  }
}

export class SingletonRegistry {
  private static readonly instances = new Map<Function, Singleton>();

  static Add<T extends Singleton>(ctor: SingletonCtor<T>): T {
    if (this.instances.has(ctor)) {
      throw new Error(`singleton already exists: ${ctor.name}`);
    }
    const instance = new ctor();
    this.instances.set(ctor, instance);
    return instance;
  }

  static Get<T extends Singleton>(ctor: SingletonCtor<T>): T {
    const instance = this.TryGet(ctor);
    if (!instance) throw new Error(`singleton not found: ${ctor.name}`);
    return instance;
  }

  static TryGet<T extends Singleton>(ctor: SingletonCtor<T>): T | undefined {
    return this.instances.get(ctor) as T | undefined;
  }

  static Remove<T extends Singleton>(ctor: SingletonCtor<T>): boolean {
    const instance = this.TryGet(ctor);
    if (!instance) return false;
    this.instances.delete(ctor);
    instance.__destroy();
    return true;
  }

  static DestroyAll(): void {
    const instances = [...this.instances.values()].reverse();
    this.instances.clear();
    for (const instance of instances) instance.__destroy();
  }
}
