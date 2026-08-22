import type { ActorContext, SceneContext } from "./contexts";
import type { MaybePromise } from "../async";
import { CoreLogger } from "../logging/Logger";
import type { Logger } from "../logging/Logger";
import {
  TimerSystem,
  type TimerCancelledContext,
  type TimerCancelReason,
  type TimerId,
} from "./TimerSystem";
import { UpdateSystem } from "./UpdateSystem";
import type {
  ActorAwakeArgs,
  ActorCtor,
  ActorId,
  EntityId,
  InstanceId,
} from "./types";
import { isTransferableComponent } from "./metadata";
import { SceneLockScope } from "./CoroutineLockSystem";
import { SceneEventScope } from "./SceneEventSystem";
import { SceneTaskScope } from "./SceneTaskSystem";

/** Component自行定义的同步迁移契约；TState必须是脱离原实例的值快照。 / Synchronous Component-owned transfer contract whose state must not retain the source instance. */
export interface ITransfer<TState = unknown> {
  CaptureTransfer(): TState;
  RestoreTransfer(state: TState): void;
}

/**
 * 数据字段与子Entity全部恢复后的同步业务钩子。
 * 用于重建Timer、派生索引和非序列化缓存，不得再次读取数据库或返回Promise。
 *
 * Synchronous business hook invoked after fields and child Entities have been
 * restored. It rebuilds timers, derived indexes, and non-serialized caches;
 * it must not perform another database read or return a Promise.
 */
export interface IDeserialize {
  Deserialize(): void;
}

export interface OwnedTimerOptions {
  /** 可选取消方法名；业务主动取消时按当前Hotfix prototype解析。 / Optional cancellation method resolved from the current Hotfix prototype on business cancellation. */
  readonly onCancelled?: string;
}

/**
 * 一次进程内Entity迁移的组件状态集合，以稳定Model构造器作为键。
 * 该对象不是网络协议或持久化格式，不得跨Process、跨Bundle或长期缓存。
 *
 * Component state set for one in-process Entity transfer, keyed by stable Model
 * constructors. It is not a wire or persistence format and must not cross a
 * Process/Bundle boundary or be retained long term.
 */
export interface EntityTransferSnapshot {
  readonly components: ReadonlyMap<ComponentCtor, unknown>;
}

export abstract class Component<TAwakeArgs extends unknown[] = []> {
  private awoken = false;
  private deserialized = false;
  private disposed = false;
  private parent: Entity | undefined;
  private readonly timers = new Set<TimerId>();
  private readonly children = new Map<EntityId, ChildEntity<any[]>>();

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

  /** 创建按当前prototype方法名执行的一次性组件定时器；不保存Hotfix闭包，销毁时自动取消。 / Creates a one-shot component timer resolved by method name on the current prototype; it retains no Hotfix closure and is cancelled on disposal. */
  NewOnceTimer<TArgs = undefined>(
    delayMs: number,
    methodName: string,
    args?: TArgs,
    options: OwnedTimerOptions = {},
  ): TimerId {
    let timerId = 0 as TimerId;
    const run = () => {
      this.timers.delete(timerId);
      if (!this.disposed) return invokeTimerMethod(this, methodName, args);
    };
    const onCancelled = options.onCancelled
      ? (context: TimerCancelledContext) => {
          this.timers.delete(timerId);
          if (!this.disposed) {
            return invokeTimerCancelledMethod(this, options.onCancelled!, args, context);
          }
        }
      : undefined;
    timerId = isActorRuntimeEntity(this.Parent)
      ? this.Parent.__newOnceTimer(
          delayMs,
          run,
          onCancelled ? (_actor, context) => onCancelled(context) : undefined,
        )
      : TimerSystem.Instance.NewOnceTimer(delayMs, run, { onCancelled });
    this.timers.add(timerId);
    return timerId;
  }

  /**
   * 创建绑定到本组件的重复定时器，并在每次触发时按方法名解析当前Hotfix实现。
   * 不接受业务闭包，避免长期Timer让旧generation无法释放；销毁组件会自动取消。
   *
   * Creates a repeated timer tied to this component and resolves the current
   * Hotfix method by name on every tick. Business closures are intentionally
   * rejected so long-lived timers do not retain old generations; disposing the
   * component cancels the timer automatically.
   */
  NewRepeatedTimer<TArgs = undefined>(
    intervalMs: number,
    methodName: string,
    args?: TArgs,
    options: OwnedTimerOptions = {},
  ): TimerId {
    const run = () => {
      if (!this.disposed) return invokeTimerMethod(this, methodName, args);
    };
    let timerId = 0 as TimerId;
    const onCancelled = options.onCancelled
      ? (context: TimerCancelledContext) => {
          this.timers.delete(timerId);
          if (!this.disposed) {
            return invokeTimerCancelledMethod(this, options.onCancelled!, args, context);
          }
        }
      : undefined;
    timerId = isActorRuntimeEntity(this.Parent)
      ? this.Parent.__newRepeatedTimer(
          intervalMs,
          run,
          onCancelled ? (_actor, context) => onCancelled(context) : undefined,
        )
      : TimerSystem.Instance.NewRepeatedTimer(intervalMs, run, { onCancelled });
    this.timers.add(timerId);
    return timerId;
  }

  /** 取消本组件拥有的定时器，并返回它此前是否仍有效。 / Cancels a timer owned by this component and returns whether it was still active. */
  CancelTimer(timerId: TimerId, reason: TimerCancelReason = "manual"): boolean {
    if (!this.timers.delete(timerId)) return false;
    return isActorRuntimeEntity(this.parent)
      ? this.parent.CancelTimer(timerId, reason)
      : TimerSystem.Instance.Cancel(timerId, reason);
  }

  /**
   * 创建并拥有一个没有 mailbox 的本地子 Entity。
   *
   * 子 Entity 会取得进程唯一 InstanceId 并进入 EntityRoot，但不能作为 Actor
   * 接收网络消息。Awake 失败时 Root、所有权索引和已创建资源都会回滚。
   *
   * Creates and owns one local child Entity without a mailbox. The child gets
   * a process-unique InstanceId and enters EntityRoot, but is not routable as an
   * Actor. Failed Awake rolls back the Root entry and owned resources.
   */
  AddChild<T extends ChildEntity<any[]>>(
    ctor: ChildEntityCtor<T>,
    id: EntityId,
    ...args: ChildEntityAwakeArgs<T>
  ): T {
    if (this.disposed) {
      throw new Error(`component is disposed: ${this.constructor.name}`);
    }
    if (this.children.has(id)) {
      throw new Error(`component already has child: ${String(id)}`);
    }

    const child = this.DomainScene<Scene>().__spawnChild(this, id, ctor, ...args);
    this.children.set(id, child);
    return child;
  }

  /** 返回指定类型的必需子 Entity；不存在或类型不符时抛错。 / Returns a required child Entity and throws when it is missing or has another type. */
  GetChild<T extends ChildEntity<any[]>>(
    ctor: ChildEntityCtor<T>,
    id: EntityId,
  ): T {
    const child = this.TryGetChild(ctor, id);
    if (!child) {
      throw new Error(`component child not found: ${ctor.name}#${String(id)}`);
    }
    return child;
  }

  /** 查询可选子 Entity，不创建实例也不改变生命周期。 / Looks up an optional child Entity without creating it or changing lifecycle. */
  TryGetChild<T extends ChildEntity<any[]>>(
    ctor: ChildEntityCtor<T>,
    id: EntityId,
  ): T | undefined {
    const child = this.children.get(id);
    return child instanceof ctor ? child : undefined;
  }

  /** 返回稳定数组快照，可按运行时子 Entity 类型过滤。 / Returns a stable array snapshot, optionally filtered by child Entity type. */
  GetChildren<T extends ChildEntity<any[]> = ChildEntity<any[]>>(
    ctor?: ChildEntityCtor<T>,
  ): readonly T[] {
    const values = [...this.children.values()];
    return (ctor
      ? values.filter((child): child is T => child instanceof ctor)
      : values) as T[];
  }

  /**
   * 从所有权索引和 EntityRoot 移除子 Entity，并立即级联销毁其组件与 Timer。
   * 返回值只用于确认移除的对象；移除后不得继续访问该引用。
   *
   * Removes a child from ownership and EntityRoot, then immediately disposes
   * its Components and timers. The returned object is only an identity result
   * and must not be used after removal.
   */
  RemoveChild<T extends ChildEntity<any[]>>(
    ctor: ChildEntityCtor<T>,
    id: EntityId,
  ): T | undefined {
    if (this.disposed) return undefined;
    const child = this.TryGetChild(ctor, id);
    if (!child) return undefined;

    this.children.delete(id);
    this.DomainScene<Scene>().__despawnChild(this, child);
    return child;
  }

  get ChildCount(): number {
    return this.children.size;
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

  /** 数据恢复完成后至多调用一次业务Deserialize钩子。 / Invokes the business Deserialize hook at most once after state restoration. */
  __deserialize(): void {
    if (this.disposed) {
      throw new Error(`component is disposed: ${this.constructor.name}`);
    }
    const candidate = this as Partial<IDeserialize>;
    if (typeof candidate.Deserialize !== "function") return;
    if (this.deserialized) {
      throw new Error(`component is already deserialized: ${this.constructor.name}`);
    }
    this.deserialized = true;
    const result = candidate.Deserialize.call(this) as unknown;
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch((error) => {
        CoreLogger.error("async component Deserialize failed", {
          component: this.constructor.name,
          error,
        });
      });
      throw new Error(
        `component Deserialize must be synchronous: ${this.constructor.name}`,
      );
    }
  }

  __dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    UpdateSystem.TryUnregister(this);
    for (const timerId of [...this.timers]) {
      this.timers.delete(timerId);
      if (isActorRuntimeEntity(this.parent)) {
        this.parent.__cancelTimer(timerId, "owner-disposed", false);
      } else {
        TimerSystem.Instance.Cancel(timerId, "owner-disposed", false);
      }
    }
    for (const child of [...this.children.values()].reverse()) {
      this.children.delete(child.Id);
      this.DomainScene<Scene>().__despawnChild(this, child);
    }
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

/** 按名字调用所有者当前prototype上的Timer方法，使长期Timer跟随Hotfix切换。 / Invokes the named timer method from the owner's current prototype so long-lived timers follow Hotfix switches. */
export function invokeTimerMethod<TArgs>(
  owner: object,
  methodName: string,
  args: TArgs,
): MaybePromise<void> {
  if (!methodName) throw new Error("timer method name must not be empty");
  const method = (owner as Record<string, unknown>)[methodName];
  if (typeof method !== "function") {
    throw new Error(`timer method not found: ${owner.constructor.name}.${methodName}`);
  }
  return (method as (this: object, args: TArgs) => MaybePromise<void>).call(owner, args);
}

/** 按名字调用取消方法并传回创建时参数和取消原因。 / Invokes a named cancellation method with the original arguments and cancellation context. */
export function invokeTimerCancelledMethod<TArgs>(
  owner: object,
  methodName: string,
  args: TArgs,
  context: TimerCancelledContext,
): MaybePromise<void> {
  if (!methodName) throw new Error("timer cancellation method name must not be empty");
  const method = (owner as Record<string, unknown>)[methodName];
  if (typeof method !== "function") {
    throw new Error(
      `timer cancellation method not found: ${owner.constructor.name}.${methodName}`,
    );
  }
  return (method as (
    this: object,
    args: TArgs,
    context: TimerCancelledContext,
  ) => MaybePromise<void>).call(owner, args, context);
}

export type ComponentCtor<TComponent extends Component<any[]> = Component<any[]>> =
  new () => TComponent;
type ComponentAwakeArgs<TComponent> =
  TComponent extends Component<infer TAwakeArgs> ? TAwakeArgs : never;

export abstract class Entity {
  private readonly components = new Map<Function, Component<any[]>>();
  private disposed = false;
  private entityId: EntityId | undefined;
  private entityInstanceId: InstanceId = 0;
  private parent: Entity | Component<any[]> | undefined;
  private domainScene: Scene | undefined;

  get IsDisposed(): boolean {
    return this.disposed;
  }

  /**
   * 在外部 await 返回后确认 Entity 仍归当前运行时所有。
   * JavaScript 不能抢占已经开始执行的 Promise continuation；异步业务在
   * await 后修改状态前必须调用本方法，销毁中的 Entity 会立即抛错。
   *
   * Confirms that this Entity is still owned by the current runtime after an
   * external await. JavaScript cannot preempt an already scheduled Promise
   * continuation, so async business code must call this before mutating state
   * after await; disposed Entities throw immediately.
   */
  AssertAlive(): void {
    this.requireAlive();
  }

  get Id(): EntityId {
    if (this.entityId === undefined) {
      throw new Error(`entity is not attached: ${this.constructor.name}`);
    }
    return this.entityId;
  }

  get InstanceId(): InstanceId {
    return this.entityInstanceId;
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
    instance.__dispose();
    return true;
  }

  /**
   * 同步收集所有显式@transferable组件的值快照。
   * 未标记组件自动忽略；标记但未实现ITransfer会立即失败，避免静默丢状态。
   *
   * Synchronously captures value snapshots from every explicitly @transferable
   * Component. Unmarked Components are ignored; an invalid opted-in Component
   * fails immediately instead of silently losing state.
   */
  CaptureTransfer(): EntityTransferSnapshot {
    this.requireAlive();
    const states = new Map<ComponentCtor, unknown>();
    for (const [ctor, component] of this.components) {
      if (!isTransferableComponent(ctor)) continue;
      const transferable = requireTransferContract(component);
      const state = transferable.CaptureTransfer();
      if (isPromiseLike(state)) {
        throw new Error(`component transfer capture must be synchronous: ${ctor.name}`);
      }
      states.set(ctor as ComponentCtor, state);
    }
    return { components: states };
  }

  /**
   * 把迁移快照恢复到目标Entity已组合的同类型组件。
   * Factory必须先创建完整组件图；缺少目标组件或异步恢复都会失败。
   *
   * Restores a transfer snapshot into matching Components already composed on
   * the target Entity. The factory must build the full graph first; a missing
   * target Component or asynchronous restore fails the transfer.
   */
  RestoreTransfer(snapshot: EntityTransferSnapshot): void {
    this.requireAlive();
    const restored: Component<any[]>[] = [];
    for (const [ctor, state] of snapshot.components) {
      const component = this.components.get(ctor);
      if (!component) {
        throw new Error(`transfer target component not found: ${ctor.name}`);
      }
      if (!isTransferableComponent(ctor)) {
        throw new Error(`transfer target component is not transferable: ${ctor.name}`);
      }
      const result = requireTransferContract(component).RestoreTransfer(state) as unknown;
      if (isPromiseLike(result)) {
        throw new Error(`component transfer restore must be synchronous: ${ctor.name}`);
      }
      restored.push(component);
    }
    for (const component of restored) component.__deserialize();
  }

  /**
   * 通知所有已组合Component：外部加载器已经恢复完整Entity图。
   * 仅供持久化/传输装配器在发布Entity前调用一次，普通业务不得手工调用。
   *
   * Notifies all composed Components that an external loader has restored the
   * complete Entity graph. Persistence/transfer assemblers call it once before
   * publishing the Entity; ordinary gameplay code must not call it manually.
   */
  CompleteDeserialize(): void {
    this.requireAlive();
    for (const component of this.components.values()) component.__deserialize();
  }

  /** 所有组件销毁后释放 Entity 自身资源。 / Releases Entity-owned resources after all components have been disposed. */
  protected OnDestroy(): void {}

  __attach(
    id: EntityId,
    instanceId: InstanceId,
    parent: Entity | Component<any[]> | undefined,
    domainScene: Scene,
  ): void {
    if (this.entityInstanceId !== 0) {
      throw new Error(`entity is already attached: ${this.constructor.name}`);
    }
    if (!Number.isSafeInteger(instanceId) || instanceId <= 0) {
      throw new Error(`invalid entity instance id: ${instanceId}`);
    }
    this.entityId = id;
    this.entityInstanceId = instanceId;
    this.parent = parent;
    this.domainScene = domainScene;
  }

  __setParent(parent: Entity | Component<any[]>): void {
    this.parent = parent;
  }

  __dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    let firstError: unknown;
    for (const component of [...this.components.values()].reverse()) {
      try {
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

    this.entityInstanceId = 0;
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

/** Actor运行时能力标记；只有显式Actor类型才会进入路由表并拥有Mailbox。 / Runtime Actor capability marker; only explicit Actor types enter routing and own a mailbox. */
export const ACTOR_RUNTIME_ENTITY = Symbol("tiangz.actor-runtime-entity");

/**
 * ProcessHost可路由实体的最小结构契约。
 * 普通Unit和ChildEntity不实现该契约；Actor与ActorUnit实现它。
 *
 * Minimal structural contract for entities routable by ProcessHost. Plain
 * Units and ChildEntities do not implement it; Actor and ActorUnit do.
 */
export interface ActorRuntimeEntity<
  TAwakeArgs extends unknown[] = [],
> extends Entity {
  readonly [ACTOR_RUNTIME_ENTITY]: true;
  readonly logger: Logger;
  __setActorLocationFenceToken(token: bigint): void;
  __matchesActorLocationFenceToken(token: bigint): boolean;
  __awake(...args: TAwakeArgs): void;
  __newOnceTimer(
    delayMs: number,
    callback: (actor: ActorRuntimeEntity<any[]>) => MaybePromise<void>,
    onCancelled?: (
      actor: ActorRuntimeEntity<any[]>,
      context: TimerCancelledContext,
    ) => MaybePromise<void>,
  ): TimerId;
  __newRepeatedTimer(
    intervalMs: number,
    callback: (actor: ActorRuntimeEntity<any[]>) => MaybePromise<void>,
    onCancelled?: (
      actor: ActorRuntimeEntity<any[]>,
      context: TimerCancelledContext,
    ) => MaybePromise<void>,
  ): TimerId;
  CancelTimer(timerId: TimerId, reason?: TimerCancelReason): boolean;
  __cancelTimer(timerId: TimerId, reason: TimerCancelReason, notify: boolean): boolean;
}

/** 判断Entity是否真正拥有Actor路由与Mailbox能力。 / Reports whether an Entity truly owns Actor routing and mailbox capability. */
export function isActorRuntimeEntity(value: unknown): value is ActorRuntimeEntity<any[]> {
  return value instanceof Entity &&
    (value as Partial<ActorRuntimeEntity<any[]>>)[ACTOR_RUNTIME_ENTITY] === true;
}

function requireTransferContract(component: Component<any[]>): ITransfer {
  const candidate = component as Partial<ITransfer>;
  if (
    typeof candidate.CaptureTransfer !== "function" ||
    typeof candidate.RestoreTransfer !== "function"
  ) {
    throw new Error(
      `transferable component must implement ITransfer: ${component.constructor.name}`,
    );
  }
  return candidate as ITransfer;
}

export type ChildEntityCtor<
  TEntity extends ChildEntity<any[]> = ChildEntity<any[]>,
> = new () => TEntity;
export type ChildEntityAwakeArgs<TEntity> =
  TEntity extends ChildEntity<infer TAwakeArgs> ? TAwakeArgs : never;
export type OwnedEntityCtor<
  TEntity extends OwnedEntity<any[]> = OwnedEntity<any[]>,
> = new () => TEntity;
export type OwnedEntityAwakeArgs<TEntity> =
  TEntity extends OwnedEntity<infer TAwakeArgs> ? TAwakeArgs : never;

/**
 * 由框架容器拥有、默认没有独立mailbox的本地Entity基础。
 *
 * ChildEntity和普通Unit共享稳定Id/InstanceId、组件与Timer生命周期；挂在Actor
 * 下方时Timer进入所属mailbox。ActorUnit会显式覆盖Timer入口并增加Actor路由。
 *
 * Base for locally owned Entities without a mailbox by default. ChildEntities
 * and plain Units share stable identity, Components, and Timer lifecycle. An
 * ActorUnit explicitly overrides Timer routing and adds Actor addressability.
 */
export abstract class OwnedEntity<
  TAwakeArgs extends unknown[] = [],
> extends Entity {
  private awoken = false;
  private readonly timers = new Set<TimerId>();

  /** 子 Entity 挂载并注册 Root 后同步初始化；不得执行异步 IO。 / Synchronously initializes a child after Root registration; asynchronous I/O is forbidden. */
  protected Awake(..._args: TAwakeArgs): void {}

  /** 创建按当前 Hotfix prototype 方法解析的一次性 Timer。 / Creates a one-shot timer resolved against the current Hotfix prototype. */
  NewOnceTimer<TArgs = undefined>(
    delayMs: number,
    methodName: string,
    args?: TArgs,
    options: OwnedTimerOptions = {},
  ): TimerId {
    let timerId = 0 as TimerId;
    const run = () => {
      this.timers.delete(timerId);
      if (!this.IsDisposed) return invokeTimerMethod(this, methodName, args);
    };
    const onCancelled = options.onCancelled
      ? (context: TimerCancelledContext) => {
          this.timers.delete(timerId);
          if (!this.IsDisposed) {
            return invokeTimerCancelledMethod(this, options.onCancelled!, args, context);
          }
        }
      : undefined;
    const actor = this.OwnerActor();
    timerId = actor
      ? actor.__newOnceTimer(
          delayMs,
          run,
          onCancelled ? (_actor, context) => onCancelled(context) : undefined,
        )
      : TimerSystem.Instance.NewOnceTimer(delayMs, run, { onCancelled });
    this.timers.add(timerId);
    return timerId;
  }

  /** 创建按当前 Hotfix prototype 方法解析的重复 Timer；高数量对象优先使用所属 Component 的合并调度。 / Creates a repeated timer resolved against the current Hotfix prototype; high-cardinality objects should prefer owner-level coalesced scheduling. */
  NewRepeatedTimer<TArgs = undefined>(
    intervalMs: number,
    methodName: string,
    args?: TArgs,
    options: OwnedTimerOptions = {},
  ): TimerId {
    const run = () => {
      if (!this.IsDisposed) return invokeTimerMethod(this, methodName, args);
    };
    const actor = this.OwnerActor();
    let timerId = 0 as TimerId;
    const onCancelled = options.onCancelled
      ? (context: TimerCancelledContext) => {
          this.timers.delete(timerId);
          if (!this.IsDisposed) {
            return invokeTimerCancelledMethod(this, options.onCancelled!, args, context);
          }
        }
      : undefined;
    timerId = actor
      ? actor.__newRepeatedTimer(
          intervalMs,
          run,
          onCancelled ? (_actor, context) => onCancelled(context) : undefined,
        )
      : TimerSystem.Instance.NewRepeatedTimer(intervalMs, run, { onCancelled });
    this.timers.add(timerId);
    return timerId;
  }

  /** 取消本子 Entity 拥有的 Timer。 / Cancels one timer owned by this child Entity. */
  CancelTimer(timerId: TimerId, reason: TimerCancelReason = "manual"): boolean {
    if (!this.timers.delete(timerId)) return false;
    const actor = this.OwnerActor();
    return actor
      ? actor.CancelTimer(timerId, reason)
      : TimerSystem.Instance.Cancel(timerId, reason);
  }

  __awake(...args: TAwakeArgs): void {
    if (this.awoken) {
      throw new Error(`owned entity is already awake: ${this.constructor.name}`);
    }
    if (this.IsDisposed) {
      throw new Error(`owned entity is disposed: ${this.constructor.name}`);
    }
    this.awoken = true;
    const result = this.Awake(...args) as unknown;
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch((error) => {
        CoreLogger.error("async owned entity Awake failed", {
          entity: this.constructor.name,
          error,
        });
      });
      throw new Error(`owned entity Awake must be synchronous: ${this.constructor.name}`);
    }
  }

  override __dispose(): void {
    if (this.IsDisposed) return;
    for (const timerId of [...this.timers]) {
      this.timers.delete(timerId);
      const actor = this.OwnerActor();
      if (actor) actor.__cancelTimer(timerId, "owner-disposed", false);
      else TimerSystem.Instance.Cancel(timerId, "owner-disposed", false);
    }
    super.__dispose();
  }

  private OwnerActor(): ActorRuntimeEntity<any[]> | undefined {
    let owner: Entity | Component<any[]> | undefined = this.Parent;
    while (owner) {
      if (isActorRuntimeEntity(owner)) return owner;
      owner = owner instanceof Component ? owner.Parent : owner.Parent;
    }
    return undefined;
  }
}

/** Component集合拥有的Item、Buff、Quest等子Entity；不能直接成为Actor消息目标。 / Component-owned child Entity for Item, Buff, Quest, and similar instances; it is not directly Actor-addressable. */
export abstract class ChildEntity<
  TAwakeArgs extends unknown[] = [],
> extends OwnedEntity<TAwakeArgs> {
  /** 仅用于TypeScript名义类型隔离，不生成运行时字段。 / Type-only nominal brand that emits no runtime field. */
  declare private readonly __childEntityBrand: void;
}

export abstract class Scene extends Entity {
  protected readonly sceneContext: SceneContext;
  private lockScope: SceneLockScope | undefined;
  private eventScope: SceneEventScope | undefined;
  private taskScope: SceneTaskScope | undefined;

  constructor(ctx: SceneContext) {
    super();
    this.sceneContext = ctx;
  }

  get logger(): Logger {
    return this.sceneContext.logger;
  }

  /** 返回严格限定到当前Scene的协程锁门面；不同Scene即使领域和键相同也不会互相阻塞。 / Returns a coroutine-lock facade strictly scoped to this Scene; identical keys in other Scenes never contend. */
  get Locks(): SceneLockScope {
    if (!this.lockScope) this.lockScope = new SceneLockScope(this);
    return this.lockScope;
  }

  /** 返回只能发布到当前Scene实例的同步通知/否决Event门面。 / Returns the synchronous notification/veto Event facade bound exclusively to this Scene instance. */
  get Events(): SceneEventScope {
    if (!this.eventScope) this.eventScope = new SceneEventScope(this);
    return this.eventScope;
  }

  /** 返回当前Scene拥有的短后台任务门面；任务会参与Hotfix排空并统一记录异常。 / Returns this Scene's short background-task facade; tasks participate in Hotfix draining and centralized error reporting. */
  get Tasks(): SceneTaskScope {
    if (!this.taskScope) this.taskScope = new SceneTaskScope(this);
    return this.taskScope;
  }

  /** 供ProcessHost聚合所有入口与动态Scene的后台任务，不为无任务Scene创建门面。 / Lets ProcessHost aggregate tasks across entry and dynamic Scenes without allocating empty scopes. */
  __taskInFlightCount(): number {
    return this.taskScope?.InFlightCount ?? 0;
  }

  /** 在本 Scene 创建 Actor，并在 Awake 前注册其 InstanceId。 / Creates an Actor in this Scene and registers its InstanceId before Awake runs. */
  SpawnActor<T extends ActorRuntimeEntity<any[]>>(
    actorId: ActorId,
    ctor: ActorCtor<T>,
    ...awakeArgs: ActorAwakeArgs<T>
  ): T {
    return this.sceneContext.spawnActor(actorId, ctor, ...awakeArgs);
  }

  /** 从路由中移除并销毁 Actor；此后不可再使用旧 InstanceId。 / Removes an Actor from routing and disposes it; stale InstanceIds must no longer be used. */
  DespawnActor(actorId: ActorId): boolean {
    return this.sceneContext.despawnActor(actorId);
  }

  /** 仅供 Component 创建无 mailbox 的本地子 Entity。 / Internal Component entry for creating a local child Entity without a mailbox. */
  __spawnChild<T extends ChildEntity<any[]>>(
    parent: Component<any[]>,
    id: EntityId,
    ctor: ChildEntityCtor<T>,
    ...awakeArgs: ChildEntityAwakeArgs<T>
  ): T {
    return this.sceneContext.spawnChild(parent, id, ctor, ...awakeArgs);
  }

  /** 仅供UnitComponent等框架容器创建无mailbox的本地Entity。 / Internal container entry for creating a local Entity without a mailbox. */
  __spawnOwned<T extends OwnedEntity<any[]>>(
    parent: Component<any[]>,
    id: EntityId,
    ctor: OwnedEntityCtor<T>,
    ...awakeArgs: OwnedEntityAwakeArgs<T>
  ): T {
    return this.sceneContext.spawnOwned(parent, id, ctor, ...awakeArgs);
  }

  /** 仅供拥有者 Component 销毁其本地子 Entity。 / Internal owner entry for destroying a local child Entity. */
  __despawnChild(parent: Component<any[]>, child: ChildEntity<any[]>): boolean {
    return this.sceneContext.despawnChild(parent, child);
  }

  /** 仅供真实拥有者销毁无mailbox的本地Entity。 / Internal owner entry for destroying a local Entity without a mailbox. */
  __despawnOwned(parent: Component<any[]>, entity: OwnedEntity<any[]>): boolean {
    return this.sceneContext.despawnOwned(parent, entity);
  }

  /** Scene销毁先通知后台任务协作取消，再级联释放组件和Entity。 / Scene disposal first requests cooperative task cancellation, then cascades through Components and Entities. */
  override __dispose(): void {
    if (this.IsDisposed) return;
    this.taskScope?.Dispose();
    super.__dispose();
  }
}

export abstract class Actor<
  TAwakeArgs extends unknown[] = [],
> extends Entity implements ActorRuntimeEntity<TAwakeArgs> {
  readonly [ACTOR_RUNTIME_ENTITY] = true as const;
  private awoken = false;
  private actorLocationFenceToken = 0n;
  protected readonly ctx: ActorContext;

  constructor(ctx: ActorContext) {
    super();
    this.ctx = ctx;
  }

  get logger(): Logger {
    return this.ctx.logger;
  }

  /** 更新该Actor接受的外部路由代次；零值关闭门禁。 / Updates the external route generation accepted by this Actor; zero disables fencing. */
  __setActorLocationFenceToken(token: bigint): void {
    this.actorLocationFenceToken = requireActorLocationFenceToken(token);
  }

  /** 校验外部路由代次；仅供Actor分发器在进入mailbox后调用。 / Validates an external route generation inside the Actor mailbox. */
  __matchesActorLocationFenceToken(token: bigint): boolean {
    return token > 0n && token === this.actorLocationFenceToken;
  }

  /** 在所属 Scene 内同步初始化 Actor 状态。 / Initializes Actor state synchronously inside its owning Scene. */
  protected Awake(..._args: TAwakeArgs): void {}

  /** 调度按当前prototype方法名执行的一次性Actor mailbox定时器。 / Schedules a one-shot Actor-mailbox timer resolved by method name on the current prototype. */
  NewOnceTimer<TArgs = undefined>(
    delayMs: number,
    methodName: string,
    args?: TArgs,
    options: OwnedTimerOptions = {},
  ): TimerId {
    return this.__newOnceTimer(
      delayMs,
      (actor) => invokeTimerMethod(actor, methodName, args),
      options.onCancelled
        ? (actor, context) => invokeTimerCancelledMethod(
            actor,
            options.onCancelled!,
            args,
            context,
          )
        : undefined,
    );
  }

  /** 仅供Component把稳定Core回调接入Actor mailbox；业务应使用方法名版本。 / Lets Components route a stable Core callback through the Actor mailbox; business code should use the method-name API. */
  __newOnceTimer(
    delayMs: number,
    callback: (actor: this) => MaybePromise<void>,
    onCancelled?: (
      actor: this,
      context: TimerCancelledContext,
    ) => MaybePromise<void>,
  ): TimerId {
    return this.ctx.newOnceTimer(
      delayMs,
      callback as (actor: ActorRuntimeEntity<any[]>) => MaybePromise<void>,
      onCancelled as ((
        actor: ActorRuntimeEntity<any[]>,
        context: TimerCancelledContext,
      ) => MaybePromise<void>) | undefined,
    );
  }

  /**
   * 调度按当前prototype方法名执行的重复Actor mailbox定时器；销毁会取消后续回调。
   * Schedules a repeated Actor-mailbox timer that resolves a method on the
   * current prototype; disposal cancels future callbacks.
   */
  NewRepeatedTimer<TArgs = undefined>(
    intervalMs: number,
    methodName: string,
    args?: TArgs,
    options: OwnedTimerOptions = {},
  ): TimerId {
    return this.__newRepeatedTimer(
      intervalMs,
      (actor) => invokeTimerMethod(actor, methodName, args),
      options.onCancelled
        ? (actor, context) => invokeTimerCancelledMethod(
            actor,
            options.onCancelled!,
            args,
            context,
          )
        : undefined,
    );
  }

  /** 仅供Component把稳定Core回调接入Actor mailbox；业务应使用方法名版本。 / Lets Components route a stable Core callback through the Actor mailbox; business code should use the method-name API. */
  __newRepeatedTimer(
    intervalMs: number,
    callback: (actor: this) => MaybePromise<void>,
    onCancelled?: (
      actor: this,
      context: TimerCancelledContext,
    ) => MaybePromise<void>,
  ): TimerId {
    return this.ctx.newRepeatedTimer(
      intervalMs,
      callback as (actor: ActorRuntimeEntity<any[]>) => MaybePromise<void>,
      onCancelled as ((
        actor: ActorRuntimeEntity<any[]>,
        context: TimerCancelledContext,
      ) => MaybePromise<void>) | undefined,
    );
  }

  /** 通过拥有该 mailbox 的宿主取消 Actor 定时器。 / Cancels an Actor timer through the host that owns its mailbox. */
  CancelTimer(timerId: TimerId, reason: TimerCancelReason = "manual"): boolean {
    return this.ctx.cancelTimer(timerId, reason, true);
  }

  /** 仅供所有权清理选择是否通知业务取消方法。 / Internal ownership cleanup with explicit cancellation-notification policy. */
  __cancelTimer(timerId: TimerId, reason: TimerCancelReason, notify: boolean): boolean {
    return this.ctx.cancelTimer(timerId, reason, notify);
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

function requireActorLocationFenceToken(token: bigint): bigint {
  if (typeof token !== "bigint" || token < 0n || token > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`invalid actor location fence token: ${token}`);
  }
  return token;
}
