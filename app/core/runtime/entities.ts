import type { ActorContext, SceneContext } from "./contexts";
import type { MaybePromise } from "../async";
import { TimerSystem, type TimerId } from "./TimerSystem";
import { UpdateSystem } from "./UpdateSystem";
import type {
  ActorAwakeArgs,
  ActorCtor,
  ActorId,
  EntityId,
  InstanceId,
} from "./types";

export abstract class Component<TAwakeArgs extends unknown[] = []> {
  private awoken = false;
  private disposed = false;
  private parent: Entity | undefined;
  private readonly timers = new Set<TimerId>();

  get IsDisposed(): boolean {
    return this.disposed;
  }

  get Parent(): Entity {
    if (!this.parent) {
      throw new Error(`component has no parent: ${this.constructor.name}`);
    }
    return this.parent;
  }

  GetParent<T extends Entity>(): T {
    return this.Parent as T;
  }

  DomainScene<T extends Scene = Scene>(): T {
    return this.Parent.DomainScene<T>();
  }

  protected Awake(..._args: TAwakeArgs): void {}

  protected OnDestroy(): void {}

  NewOnceTimer(
    delayMs: number,
    callback: (self: this) => MaybePromise<void>,
  ): TimerId {
    let timerId = 0;
    const run = () => {
      this.timers.delete(timerId);
      if (!this.disposed) return callback(this);
    };
    timerId = this.Parent instanceof Actor
      ? this.Parent.NewOnceTimer(delayMs, run)
      : TimerSystem.Instance.NewOnceTimer(delayMs, run);
    this.timers.add(timerId);
    return timerId;
  }

  NewRepeatedTimer(
    intervalMs: number,
    callback: (self: this) => MaybePromise<void>,
  ): TimerId {
    const run = () => {
      if (!this.disposed) return callback(this);
    };
    const timerId = this.Parent instanceof Actor
      ? this.Parent.NewRepeatedTimer(intervalMs, run)
      : TimerSystem.Instance.NewRepeatedTimer(intervalMs, run);
    this.timers.add(timerId);
    return timerId;
  }

  RemoveTimer(timerId: TimerId): boolean {
    if (!this.timers.delete(timerId)) return false;
    return this.parent instanceof Actor
      ? this.parent.RemoveTimer(timerId)
      : TimerSystem.Instance.Remove(timerId);
  }

  __attach(parent: Entity): void {
    if (this.parent) {
      throw new Error(`component is already attached: ${this.constructor.name}`);
    }
    this.parent = parent;
  }

  __awake(...args: TAwakeArgs): void {
    if (this.awoken) {
      throw new Error(`component is already awake: ${this.constructor.name}`);
    }
    if (this.disposed) {
      throw new Error(`component is disposed: ${this.constructor.name}`);
    }
    this.awoken = true;
    const result = this.Awake(...args) as unknown;
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch((error) => {
        console.error(`async component Awake failed: ${this.constructor.name}`, error);
      });
      throw new Error(
        `component Awake must be synchronous: ${this.constructor.name}`,
      );
    }
    UpdateSystem.TryRegister(this);
  }

  __dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    UpdateSystem.TryUnregister(this);
    for (const timerId of [...this.timers]) this.RemoveTimer(timerId);
    this.OnDestroy();
    this.parent = undefined;
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

export type ComponentCtor<TComponent extends Component<any[]> = Component<any[]>> =
  new () => TComponent;
type ComponentAwakeArgs<TComponent> =
  TComponent extends Component<infer TAwakeArgs> ? TAwakeArgs : never;

interface ComponentHooks {
  added(ctor: Function, instance: Component<any[]>): void;
  removing(instance: Component<any[]>): void;
}

export abstract class Entity {
  private readonly components = new Map<Function, Component<any[]>>();
  private componentHooks?: ComponentHooks;
  private disposed = false;
  private id: EntityId | undefined;
  private instanceId: InstanceId = 0;
  private parent: Entity | Component<any[]> | undefined;
  private domainScene: Scene | undefined;

  get IsDisposed(): boolean {
    return this.disposed;
  }

  get Id(): EntityId {
    if (this.id === undefined) {
      throw new Error(`entity is not attached: ${this.constructor.name}`);
    }
    return this.id;
  }

  get InstanceId(): InstanceId {
    return this.instanceId;
  }

  get Parent(): Entity | Component<any[]> | undefined {
    return this.parent;
  }

  DomainScene<T extends Scene = Scene>(): T {
    if (!this.domainScene) {
      throw new Error(`entity has no domain scene: ${this.constructor.name}`);
    }
    return this.domainScene as T;
  }

  AddComponent<T extends Component<any[]>>(
    ctor: ComponentCtor<T>,
    ...args: ComponentAwakeArgs<T>
  ): T {
    this.requireAlive();
    if (this.components.has(ctor)) {
      throw new Error(`entity already has component: ${ctor.name}`);
    }

    const instance = new ctor();
    instance.__attach(this);
    this.components.set(ctor, instance);
    try {
      instance.__awake(...args);
      this.componentHooks?.added(ctor, instance);
    } catch (error) {
      this.components.delete(ctor);
      instance.__dispose();
      throw error;
    }
    return instance;
  }

  GetComponent<T extends Component<any[]>>(
    ctor: ComponentCtor<T>,
  ): T {
    const instance = this.TryGetComponent(ctor);
    if (!instance) {
      throw new Error(`entity component not found: ${ctor.name}`);
    }
    return instance;
  }

  TryGetComponent<T extends Component<any[]>>(
    ctor: ComponentCtor<T>,
  ): T | undefined {
    return this.components.get(ctor) as T | undefined;
  }

  HasComponent<T extends Component<any[]>>(
    ctor: ComponentCtor<T>,
  ): boolean {
    return this.components.has(ctor);
  }

  RemoveComponent<T extends Component<any[]>>(
    ctor: ComponentCtor<T>,
  ): boolean {
    if (this.disposed) return false;

    const instance = this.components.get(ctor);
    if (!instance) return false;

    this.components.delete(ctor);
    this.componentHooks?.removing(instance);
    instance.__dispose();
    return true;
  }

  protected OnDestroy(): void {}

  __attach(
    id: EntityId,
    instanceId: InstanceId,
    parent: Entity | Component<any[]> | undefined,
    domainScene: Scene,
  ): void {
    if (this.instanceId !== 0) {
      throw new Error(`entity is already attached: ${this.constructor.name}`);
    }
    if (!Number.isSafeInteger(instanceId) || instanceId <= 0) {
      throw new Error(`invalid entity instance id: ${instanceId}`);
    }
    this.id = id;
    this.instanceId = instanceId;
    this.parent = parent;
    this.domainScene = domainScene;
  }

  __setParent(parent: Entity | Component<any[]>): void {
    this.parent = parent;
  }

  __bindComponentHooks(hooks: ComponentHooks): void {
    if (this.componentHooks) {
      throw new Error("entity component hooks are already bound");
    }
    this.componentHooks = hooks;
    for (const [ctor, instance] of this.components) {
      hooks.added(ctor, instance);
    }
  }

  __dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    let firstError: unknown;
    for (const component of this.components.values()) {
      try {
        this.componentHooks?.removing(component);
        component.__dispose();
      } catch (error) {
        firstError ??= error;
      }
    }
    this.components.clear();

    try {
      this.OnDestroy();
    } catch (error) {
      firstError ??= error;
    }

    this.instanceId = 0;
    this.parent = undefined;
    this.domainScene = undefined;

    if (firstError !== undefined) throw firstError;
  }

  private requireAlive(): void {
    if (this.disposed) {
      throw new Error(`entity is disposed: ${this.constructor.name}`);
    }
  }
}

export abstract class Scene extends Entity {
  protected readonly ctx: SceneContext;

  constructor(ctx: SceneContext) {
    super();
    this.ctx = ctx;
  }

  SpawnActor<T extends Actor<any[]>>(
    actorId: ActorId,
    ctor: ActorCtor<T>,
    ...awakeArgs: ActorAwakeArgs<T>
  ): T {
    return this.ctx.spawnActor(actorId, ctor, ...awakeArgs);
  }

  DespawnActor(actorId: ActorId): boolean {
    return this.ctx.despawnActor(actorId);
  }
}

export abstract class Actor<
  TAwakeArgs extends unknown[] = [],
> extends Entity {
  private awoken = false;
  protected readonly ctx: ActorContext;

  constructor(ctx: ActorContext) {
    super();
    this.ctx = ctx;
  }

  protected Awake(..._args: TAwakeArgs): void {}

  NewOnceTimer(
    delayMs: number,
    callback: (actor: this) => MaybePromise<void>,
  ): TimerId {
    return this.ctx.newOnceTimer(delayMs, callback as (actor: Actor<any[]>) => MaybePromise<void>);
  }

  NewRepeatedTimer(
    intervalMs: number,
    callback: (actor: this) => MaybePromise<void>,
  ): TimerId {
    return this.ctx.newRepeatedTimer(
      intervalMs,
      callback as (actor: Actor<any[]>) => MaybePromise<void>,
    );
  }

  RemoveTimer(timerId: TimerId): boolean {
    return this.ctx.removeTimer(timerId);
  }

  __awake(...args: TAwakeArgs): void {
    if (this.awoken) {
      throw new Error(`actor is already awake: ${this.constructor.name}`);
    }
    if (this.IsDisposed) {
      throw new Error(`actor is disposed: ${this.constructor.name}`);
    }
    this.awoken = true;
    const result = this.Awake(...args) as unknown;
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch((error) => {
        console.error(`async actor Awake failed: ${this.constructor.name}`, error);
      });
      throw new Error(`actor Awake must be synchronous: ${this.constructor.name}`);
    }
  }
}
