import type { ActorContext, SceneContext } from "./contexts";
import type { MaybePromise } from "../async";
import { CoreLogger } from "../logging/Logger";
import type { Logger } from "../logging/Logger";
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

  /** 返回所属 Entity；移除后调用会抛错，因此不可跨越销毁缓存结果。 / Returns the owning Entity or throws after removal; do not cache the result past disposal. */
  GetParent<T extends Entity>(): T {
    return this.Parent as T;
  }

  /** 解析拥有组件 Entity 的 Scene，而不只是直接父对象。 / Resolves the Scene that owns the component's Entity, not merely its immediate parent. */
  DomainScene<T extends Scene = Scene>(): T {
    return this.Parent.DomainScene<T>();
  }

  /** 挂载后同步初始化组件状态；异步工作应放入生命周期或 Handler。 / Initializes component state synchronously after attachment; asynchronous work belongs in a lifecycle/handler. */
  protected Awake(..._args: TAwakeArgs): void {}

  /** 释放组件拥有的资源；Entity 销毁时只调用一次。 / Releases component-owned resources; Entity disposal invokes it exactly once. */
  protected OnDestroy(): void {}

  /** 创建绑定到本组件的一次性定时器，并在销毁时自动取消。 / Creates a one-shot timer tied to this component and automatically cancels it on disposal. */
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

  /** 创建绑定到本组件的重复定时器；销毁后回调不会再执行。 / Creates a repeated timer tied to this component; callbacks never run after disposal. */
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

  /** 取消本组件拥有的定时器，并返回它此前是否仍有效。 / Cancels a timer owned by this component and returns whether it was still active. */
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
        CoreLogger.error("async component Awake failed", {
          component: this.constructor.name,
          error,
        });
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

  /** 解析稳定的 DomainScene；挂载前和销毁后调用都会抛错。 / Resolves the stable domain Scene; it throws before attachment and after disposal. */
  DomainScene<T extends Scene = Scene>(): T {
    if (!this.domainScene) {
      throw new Error(`entity has no domain scene: ${this.constructor.name}`);
    }
    return this.domainScene as T;
  }

  /**
   * 构造、挂载并同步 Awake 一个组件。
   *
   * 本方法会修改 Entity 和 UpdateSystem；Awake 失败时两者都会回滚。
   * 业务代码不可直接 `new` 可挂载组件，否则会绕过所有权和生命周期注册。
   *
   * Constructs, attaches, and synchronously awakens one component.
   *
   * The method mutates the Entity and UpdateSystem. It rolls both back when
   * Awake fails. Do not instantiate attachable components with `new` in
   * business code because that bypasses ownership and lifecycle registration.
   */
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

  /** 返回必需组件；Entity 未组合该组件时抛错。 / Returns a required component and throws when the Entity was not composed with it. */
  GetComponent<T extends Component<any[]>>(
    ctor: ComponentCtor<T>,
  ): T {
    const instance = this.TryGetComponent(ctor);
    if (!instance) {
      throw new Error(`entity component not found: ${ctor.name}`);
    }
    return instance;
  }

  /** 查询可选组件，不创建实例也不改变生命周期状态。 / Looks up an optional component without creating it or changing lifecycle state. */
  TryGetComponent<T extends Component<any[]>>(
    ctor: ComponentCtor<T>,
  ): T | undefined {
    return this.components.get(ctor) as T | undefined;
  }

  /** 检查组件组合关系，不暴露内部组件表。 / Tests component composition without exposing the internal component map. */
  HasComponent<T extends Component<any[]>>(
    ctor: ComponentCtor<T>,
  ): boolean {
    return this.components.has(ctor);
  }

  /** 立即移除并销毁组件；外部仍持有的引用随即失效。 / Removes and disposes a component immediately; outstanding references become invalid. */
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

  /** 所有组件销毁后释放 Entity 自身资源。 / Releases Entity-owned resources after all components have been disposed. */
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
    for (const component of [...this.components.values()].reverse()) {
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

  get logger(): Logger {
    return this.ctx.logger;
  }

  /** 在本 Scene 创建 Actor，并在 Awake 前注册其 InstanceId。 / Creates an Actor in this Scene and registers its InstanceId before Awake runs. */
  SpawnActor<T extends Actor<any[]>>(
    actorId: ActorId,
    ctor: ActorCtor<T>,
    ...awakeArgs: ActorAwakeArgs<T>
  ): T {
    return this.ctx.spawnActor(actorId, ctor, ...awakeArgs);
  }

  /** 从路由中移除并销毁 Actor；此后不可再使用旧 InstanceId。 / Removes an Actor from routing and disposes it; stale InstanceIds must no longer be used. */
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

  get logger(): Logger {
    return this.ctx.logger;
  }

  /** 在所属 Scene 内同步初始化 Actor 状态。 / Initializes Actor state synchronously inside its owning Scene. */
  protected Awake(..._args: TAwakeArgs): void {}

  /** 调度 Actor mailbox 定时器，使回调遵循该 Actor 的顺序策略。 / Schedules an Actor-mailbox timer so its callback obeys this Actor's ordering policy. */
  NewOnceTimer(
    delayMs: number,
    callback: (actor: this) => MaybePromise<void>,
  ): TimerId {
    return this.ctx.newOnceTimer(delayMs, callback as (actor: Actor<any[]>) => MaybePromise<void>);
  }

  /** 调度重复 Actor mailbox 定时器；销毁会取消后续回调。 / Schedules a repeated Actor-mailbox timer; disposal cancels future callbacks. */
  NewRepeatedTimer(
    intervalMs: number,
    callback: (actor: this) => MaybePromise<void>,
  ): TimerId {
    return this.ctx.newRepeatedTimer(
      intervalMs,
      callback as (actor: Actor<any[]>) => MaybePromise<void>,
    );
  }

  /** 通过拥有该 mailbox 的宿主取消 Actor 定时器。 / Cancels an Actor timer through the host that owns its mailbox. */
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
        CoreLogger.error("async actor Awake failed", {
          actor: this.constructor.name,
          error,
        });
      });
      throw new Error(`actor Awake must be synchronous: ${this.constructor.name}`);
    }
  }
}
