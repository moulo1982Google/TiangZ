import { ActorContext, SceneContext } from "./contexts";
import { isPromiseLike, type MaybePromise } from "../async";
import { ChildEntity, isActorRuntimeEntity } from "./entities";
import type {
  ActorRuntimeEntity,
  Component,
  Entity,
  OwnedEntity,
  Scene,
} from "./entities";
import type {
  ChildEntityAwakeArgs,
  ChildEntityCtor,
  OwnedEntityAwakeArgs,
  OwnedEntityCtor,
} from "./entities";
import { MailBoxComponent } from "./MailBoxComponent";
import { EntityRoot } from "./root";
import { ActorUnit, Unit, UnitComponent } from "./Unit";
import { Session, SessionComponent } from "./Session";
import {
  TimerSystem,
  type TimerCancelledContext,
  type TimerCancelReason,
  type TimerId,
} from "./TimerSystem";
import { InstanceIdSystem } from "./IdSystem";
import { CoroutineLockSystem } from "./CoroutineLockSystem";
import {
  getActorOptions,
  getSceneOptions,
} from "./metadata";
import { CoreLogger } from "../logging/Logger";
import { SingletonRegistry } from "./Singleton";
import type {
  ActorCtor,
  ActorAwakeArgs,
  ActorId,
  ActorRef,
  EntityId,
  MailboxType,
  SceneCtor,
  SceneId,
  SceneRef,
  SceneOptions,
  InstanceId,
} from "./types";

interface SceneRuntime {
  ref: SceneRef;
  instance: Scene;
  actors: Map<ActorId, ActorRuntime>;
}

interface ActorRuntime {
  ref: ActorRef;
  instance: ActorRuntimeEntity<any[]>;
  mailBox: MailBoxComponent;
  queue: PendingActorCall[];
  queueHead: number;
  recycledQueueItems: PendingActorCall[];
  running: boolean;
  timers: Set<TimerId>;
}

interface PendingActorCall {
  run?: (actor: ActorRuntimeEntity<any[]>) => MaybePromise<unknown>;
  resolve?: (value: unknown) => void;
  reject?: (reason: unknown) => void;
}

export interface ActorMailboxMetricsSnapshot {
  readonly fastPathCalls: number;
  readonly queuedCalls: number;
  readonly asyncCalls: number;
  readonly oneWayFastPathCalls: number;
  readonly oneWayQueuedCalls: number;
  readonly oneWayAsyncCalls: number;
  readonly queuedDepth: number;
  readonly maxQueuedDepth: number;
}

export class ProcessHost {
  readonly Root = new EntityRoot();
  private readonly scenes = new Map<SceneId, SceneRuntime>();
  private readonly actorsByInstanceId = new Map<InstanceId, ActorRuntime>();
  private readonly actorMailboxMetrics = {
    fastPathCalls: 0,
    queuedCalls: 0,
    asyncCalls: 0,
    oneWayFastPathCalls: 0,
    oneWayQueuedCalls: 0,
    oneWayAsyncCalls: 0,
    queuedDepth: 0,
    maxQueuedDepth: 0,
  };

  constructor(public readonly processId = "process-1") {}

  /** 聚合本Process全部入口Scene和动态子Scene的Spawn任务，供Hotfix屏障与Runtime Pump使用。 / Aggregates Spawn tasks from every entry and dynamic child Scene for the Hotfix barrier and Runtime Pump. */
  get SceneTaskInFlightCount(): number {
    let count = 0;
    for (const scene of this.scenes.values()) {
      count += scene.instance.__taskInFlightCount();
    }
    return count;
  }

  Dispose(): void {
    for (const sceneId of [...this.scenes.keys()].reverse()) {
      this.despawnScene(sceneId);
    }
    if (this.Root.Count !== 0) {
      throw new Error(`process host leaked ${this.Root.Count} entity reference(s)`);
    }
  }

  spawnScene<T extends Scene>(
    sceneId: SceneId,
    ctor: SceneCtor<T>,
    overrideOptions: Partial<SceneOptions> = {},
  ): T {
    if (this.scenes.has(sceneId)) {
      throw new Error(`scene already exists: ${sceneId}`);
    }

    const options = {
      ...getSceneOptions(ctor),
      ...overrideOptions,
    };
    if (!options.sceneType) {
      throw new Error(`scene ${ctor.name} is missing @scene({ sceneType })`);
    }

    const ref: SceneRef = {
      processId: this.processId,
      sceneId,
      sceneType: options.sceneType,
    };
    const sceneCtx = new SceneContext(this, ref);
    const instance = new ctor(sceneCtx);
    return this.attachScene(sceneId, ref.sceneType, instance, options.mailbox ?? "ordered");
  }

  /** 将配置或动态创建的 Scene 接入同一 EntityRoot 和子 Entity 容器。 / Attaches configured or dynamic Scenes to one EntityRoot and child-entity container. */
  attachScene<T extends Scene>(
    sceneId: SceneId,
    sceneType: string,
    instance: T,
    mailbox: MailboxType = "ordered",
  ): T {
    if (this.scenes.has(sceneId)) {
      throw new Error(`scene already exists: ${sceneId}`);
    }
    const ref: SceneRef = { processId: this.processId, sceneId, sceneType };
    const instanceId = this.allocateInstanceId();
    try {
      instance.__attach(sceneId, instanceId, undefined, instance);
      this.Root.Add(instance);
      instance.AddComponent(MailBoxComponent, mailbox);
      this.scenes.set(sceneId, {
        ref,
        instance,
        actors: new Map(),
      });
      return instance;
    } catch (error) {
      this.Root.Remove(instanceId);
      this.disposeFailedEntity(instance, `scene ${sceneId}`);
      throw error;
    }
  }

  spawnActor<T extends ActorRuntimeEntity<any[]>>(
    sceneId: SceneId,
    actorId: ActorId,
    ctor: ActorCtor<T>,
    ...awakeArgs: ActorAwakeArgs<T>
  ): T {
    const scene = this.getLocalScene(sceneId);
    if (scene.actors.has(actorId)) {
      throw new Error(`actor already exists: ${sceneId}/${actorId}`);
    }

    const declaredOptions = getActorOptions(ctor);
    const options = declaredOptions ?? {};
    const ref: ActorRef = {
      ...scene.ref,
      actorId,
      instanceId: this.allocateInstanceId(),
    };
    const actorCtx = new ActorContext(this, ref);
    const instance = new ctor(actorCtx);
    if (!isActorRuntimeEntity(instance)) {
      throw new Error(
        `@actor type must extend Actor or ActorUnit: ${ctor.name}`,
      );
    }
    if (instance instanceof ActorUnit && !declaredOptions) {
      throw new Error(`ActorUnit must declare @actor: ${ctor.name}`);
    }

    try {
      instance.__attach(actorId, ref.instanceId, scene.instance, scene.instance);
      this.Root.Add(instance);
      const mailBox = instance.AddComponent(
        MailBoxComponent,
        options.mailbox ?? "ordered",
      );
      instance.__awake(...awakeArgs);
      const runtime: ActorRuntime = {
        ref,
        instance,
        mailBox,
        queue: [],
        queueHead: 0,
        recycledQueueItems: [],
        running: false,
        timers: new Set(),
      };
      scene.actors.set(actorId, runtime);
      this.actorsByInstanceId.set(ref.instanceId, runtime);
    } catch (error) {
      this.Root.Remove(ref.instanceId);
      this.disposeFailedEntity(instance, `actor ${sceneId}/${actorId}`);
      throw error;
    }

    return instance;
  }

  /**
   * 创建并注册一个由 Component 拥有的本地子 Entity。
   *
   * 子 Entity 进入 EntityRoot 以获得统一 O(1) 生命周期索引，但不会进入
   * actorsByInstanceId，也不会分配 mailbox 或网络路由。
   *
   * Creates and registers a local child Entity owned by a Component. It enters
   * EntityRoot for O(1) lifecycle lookup, but never enters actor routing and
   * receives neither a mailbox nor a network address.
   */
  spawnChild<T extends ChildEntity<any[]>>(
    sceneId: SceneId,
    parent: Component<any[]>,
    id: EntityId,
    ctor: ChildEntityCtor<T>,
    ...awakeArgs: ChildEntityAwakeArgs<T>
  ): T {
    if (!(ctor.prototype instanceof ChildEntity)) {
      throw new Error(`child Entity type must extend ChildEntity: ${ctor.name}`);
    }
    return this.spawnOwned(
      sceneId,
      parent,
      id,
      ctor as unknown as OwnedEntityCtor<T>,
      ...(awakeArgs as unknown as OwnedEntityAwakeArgs<T>),
    );
  }

  /** 创建并注册由框架容器拥有的本地Entity，不进入Actor路由也不分配Mailbox。 / Creates and registers a container-owned local Entity without Actor routing or a mailbox. */
  spawnOwned<T extends OwnedEntity<any[]>>(
    sceneId: SceneId,
    parent: Component<any[]>,
    id: EntityId,
    ctor: OwnedEntityCtor<T>,
    ...awakeArgs: OwnedEntityAwakeArgs<T>
  ): T {
    const scene = this.getLocalScene(sceneId);
    if (parent.DomainScene() !== scene.instance) {
      throw new Error(`entity owner belongs to another domain scene: ${String(id)}`);
    }

    const instanceId = this.allocateInstanceId();
    const instance = new ctor();
    try {
      instance.__attach(id, instanceId, parent, scene.instance);
      this.Root.Add(instance);
      instance.__awake(...awakeArgs);
      return instance;
    } catch (error) {
      this.Root.Remove(instanceId);
      this.disposeFailedEntity(instance, `owned entity ${sceneId}/${String(id)}`);
      throw error;
    }
  }

  /** 从 EntityRoot 移除并销毁一个本地子 Entity；只有当前拥有者可以执行。 / Removes and disposes a local child Entity; only its current owner may do so. */
  despawnChild(
    sceneId: SceneId,
    parent: Component<any[]>,
    child: ChildEntity<any[]>,
  ): boolean {
    return this.despawnOwned(sceneId, parent, child);
  }

  /** 从EntityRoot移除并销毁一个本地Entity；只有当前拥有者可以执行。 / Removes and disposes a local Entity; only its current owner may do so. */
  despawnOwned(
    sceneId: SceneId,
    parent: Component<any[]>,
    entity: OwnedEntity<any[]>,
  ): boolean {
    const scene = this.getLocalScene(sceneId);
    if (
      entity.Parent !== parent ||
      entity.DomainScene() !== scene.instance ||
      this.Root.Get(entity.InstanceId) !== entity
    ) {
      return false;
    }

    const entityId = entity.Id;
    const instanceId = entity.InstanceId;
    this.Root.Remove(instanceId);
    try {
      entity.__dispose();
    } catch (disposeError) {
      CoreLogger.error("owned entity destroy failed", {
        scene: sceneId,
        entity: entity.constructor.name,
        entityId,
        instanceId,
        error: disposeError,
      });
    }
    return true;
  }

  despawnScene(sceneId: SceneId): boolean {
    const scene = this.scenes.get(sceneId);
    if (!scene) return false;

    for (const actorId of [...scene.actors.keys()]) {
      this.despawnActor(sceneId, actorId);
    }
    const sceneInstanceId = scene.instance.InstanceId;
    SingletonRegistry.TryGet(CoroutineLockSystem)?.CancelScene(sceneInstanceId);
    try {
      // 保留Scene注册直到级联销毁完成；Component/ChildEntity的析构可能需要通过
      // DomainScene回查宿主。先删注册会让正常的子实体清理误报scene not found。
      // Keep the Scene registered until cascading disposal completes because
      // component/child cleanup may resolve the host through DomainScene.
      scene.instance.__dispose();
    } catch (disposeError) {
      CoreLogger.error("scene destroy failed", { scene: sceneId, error: disposeError });
    } finally {
      this.Root.Remove(sceneInstanceId);
      this.scenes.delete(sceneId);
    }
    return true;
  }

  sceneById<T extends Scene = Scene>(sceneId: SceneId): T {
    return this.getLocalScene(sceneId).instance as T;
  }

  despawnActor(sceneId: SceneId, actorId: ActorId): boolean {
    const scene = this.getLocalScene(sceneId);
    const actor = scene.actors.get(actorId);
    if (!actor) return false;

    scene.actors.delete(actorId);
    this.actorsByInstanceId.delete(actor.ref.instanceId);
    this.Root.Remove(actor.ref.instanceId);
    for (const timerId of actor.timers) {
      TimerSystem.Instance.Cancel(timerId, "owner-disposed", false);
    }
    actor.timers.clear();
    if (
      actor.instance instanceof Unit &&
      actor.instance.Parent instanceof UnitComponent
    ) {
      actor.instance.Parent.__detach(actor.instance.UnitId);
    }
    if (
      actor.instance instanceof Session &&
      actor.instance.Parent instanceof SessionComponent
    ) {
      actor.instance.Parent.__detach(actor.instance.ConnectionId);
    }
    const error = new Error(`actor despawned: ${sceneId}/${actorId}`);
    let pending: PendingActorCall | undefined;
    while ((pending = this.dequeueActorCall(actor))) {
      pending.reject?.(error);
      this.recycleActorCall(actor, pending);
    }
    try {
      actor.instance.__dispose();
    } catch (disposeError) {
      CoreLogger.error("actor destroy failed", {
        scene: sceneId,
        actorId,
        error: disposeError,
      });
    }
    return true;
  }

  newActorOnceTimer(
    instanceId: InstanceId,
    delayMs: number,
    callback: (actor: ActorRuntimeEntity<any[]>) => MaybePromise<void>,
    onCancelled?: (
      actor: ActorRuntimeEntity<any[]>,
      context: TimerCancelledContext,
    ) => MaybePromise<void>,
  ): TimerId {
    const actor = this.requireActorRuntime(instanceId);
    let timerId = 0 as TimerId;
    timerId = TimerSystem.Instance.NewOnceTimer(
      delayMs,
      () => {
        actor.timers.delete(timerId);
        return this.runActorMailbox(instanceId, callback);
      },
      {
        onCancelled: onCancelled
          ? (context) => this.runActorMailbox(
              instanceId,
              (target) => onCancelled(target, context),
            )
          : undefined,
      },
    );
    actor.timers.add(timerId);
    return timerId;
  }

  newActorRepeatedTimer(
    instanceId: InstanceId,
    intervalMs: number,
    callback: (actor: ActorRuntimeEntity<any[]>) => MaybePromise<void>,
    onCancelled?: (
      actor: ActorRuntimeEntity<any[]>,
      context: TimerCancelledContext,
    ) => MaybePromise<void>,
  ): TimerId {
    const actor = this.requireActorRuntime(instanceId);
    let timerId = 0 as TimerId;
    timerId = TimerSystem.Instance.NewRepeatedTimer(
      intervalMs,
      () => this.runActorMailbox(instanceId, callback),
      {
        onCancelled: onCancelled
          ? (context) => this.runActorMailbox(
              instanceId,
              (target) => onCancelled(target, context),
            )
          : undefined,
      },
    );
    actor.timers.add(timerId);
    return timerId;
  }

  cancelActorTimer(
    instanceId: InstanceId,
    timerId: TimerId,
    reason: TimerCancelReason,
    notify: boolean,
  ): boolean {
    const actor = this.actorsByInstanceId.get(instanceId);
    if (!actor || !actor.timers.delete(timerId)) return false;
    return TimerSystem.Instance.Cancel(timerId, reason, notify);
  }

  /**
   * 在目标 Actor 的 mailbox 中执行一个已经类型化的回调。
   *
   * ordered Actor 会串行等待前一个 Promise；unordered Actor 允许并发。
   * 本方法是 Session/Unit Handler 和 Actor 定时器共用的底层入口，业务代码
   * 不应把它包装回字符串 Handler 或自行构造路由。
   *
   * Runs an already typed callback through the target Actor mailbox.
   *
   * Ordered Actors await the previous Promise while unordered Actors may run
   * concurrently. Session/Unit handlers and Actor timers share this low-level
   * path; business code must not rebuild string handlers or routing on top.
   */
  runActorMailbox<T>(
    instanceId: InstanceId,
    run: (actor: ActorRuntimeEntity<any[]>) => MaybePromise<T>,
  ): MaybePromise<T> {
    const actor = this.actorsByInstanceId.get(instanceId);
    if (!actor || this.Root.Get(instanceId) !== actor.instance) {
      return Promise.reject(new Error(`actor instance not found: ${instanceId}`));
    }

    if (actor.mailBox.MailboxType === "unordered") {
      this.actorMailboxMetrics.fastPathCalls += 1;
      const result = this.executeActorCall(actor, run);
      if (isPromiseLike(result)) this.actorMailboxMetrics.asyncCalls += 1;
      return result;
    }

    if (!actor.running) {
      this.actorMailboxMetrics.fastPathCalls += 1;
      actor.running = true;
      try {
        const result = this.executeActorCall(actor, run);
        if (isPromiseLike(result)) {
          this.actorMailboxMetrics.asyncCalls += 1;
          return Promise.resolve(result).then(
            (value) => {
              this.finishActorCall(actor);
              return value;
            },
            (error) => {
              this.finishActorCall(actor);
              throw error;
            },
          );
        }
        this.finishActorCall(actor);
        return result;
      } catch (error) {
        this.finishActorCall(actor);
        throw error;
      }
    }

    this.actorMailboxMetrics.queuedCalls += 1;
    return new Promise<T>((resolve, reject) => {
      this.enqueueActorCall(actor, run, resolve as (value: unknown) => void, reject);
    });
  }

  /**
   * 将无返回值消息投递到 Actor mailbox；忙时只保留队列节点，不创建 Promise。
   * 这是单向 Message 的专用路径，调用方不能等待“处理完成”；Handler 异常由框架记录。
   *
   * Queues a one-way message without creating a Promise when the Actor is busy.
   * This path is only for one-way Messages: callers cannot await completion and
   * framework logging owns failures from a later queued execution.
   */
  runActorMailboxVoid(
    instanceId: InstanceId,
    run: (actor: ActorRuntimeEntity<any[]>) => MaybePromise<void>,
  ): MaybePromise<void> {
    const actor = this.actorsByInstanceId.get(instanceId);
    if (!actor || this.Root.Get(instanceId) !== actor.instance) {
      return Promise.reject(new Error(`actor instance not found: ${instanceId}`));
    }

    if (actor.mailBox.MailboxType === "unordered") {
      this.actorMailboxMetrics.oneWayFastPathCalls += 1;
      const result = this.executeActorCall(actor, run);
      if (isPromiseLike(result)) this.actorMailboxMetrics.oneWayAsyncCalls += 1;
      return result;
    }

    if (!actor.running) {
      this.actorMailboxMetrics.oneWayFastPathCalls += 1;
      actor.running = true;
      try {
        const result = this.executeActorCall(actor, run);
        if (isPromiseLike(result)) {
          this.actorMailboxMetrics.oneWayAsyncCalls += 1;
          return Promise.resolve(result).then(
            () => {
              this.finishActorCall(actor);
            },
            (error) => {
              this.finishActorCall(actor);
              throw error;
            },
          );
        }
        this.finishActorCall(actor);
        return result;
      } catch (error) {
        this.finishActorCall(actor);
        throw error;
      }
    }

    this.actorMailboxMetrics.oneWayQueuedCalls += 1;
    this.enqueueActorCall(actor, run);
    return undefined;
  }

  /** 返回 Actor mailbox 热路径计数；只读快照不会改变队列。 / Returns Actor mailbox hot-path counters without changing queues. */
  MailboxMetrics(): ActorMailboxMetricsSnapshot {
    return { ...this.actorMailboxMetrics };
  }

  private requireActorRuntime(instanceId: InstanceId): ActorRuntime {
    const actor = this.actorsByInstanceId.get(instanceId);
    if (!actor || this.Root.Get(instanceId) !== actor.instance) {
      throw new Error(`actor instance not found: ${instanceId}`);
    }
    return actor;
  }

  private executeActorCall<T>(
    actor: ActorRuntime,
    run: (instance: ActorRuntimeEntity<any[]>) => MaybePromise<T>,
  ): MaybePromise<T> {
    const result = run(actor.instance);
    if (isPromiseLike(result)) {
      return Promise.resolve(result).then((value) => {
        this.requireCurrentActor(actor);
        return value;
      });
    }
    this.requireCurrentActor(actor);
    return result;
  }

  private requireCurrentActor(actor: ActorRuntime): void {
    if (
      this.actorsByInstanceId.get(actor.ref.instanceId) !== actor ||
      this.Root.Get(actor.ref.instanceId) !== actor.instance
    ) {
      throw new Error(
        `actor despawned during mailbox execution: ${actor.ref.sceneId}/${actor.ref.actorId}`,
      );
    }
  }

  private finishActorCall(actor: ActorRuntime): void {
    if (this.actorQueueLength(actor) > 0) {
      this.drainOrdered(actor);
    } else {
      actor.running = false;
    }
  }

  private drainOrdered(actor: ActorRuntime): void {
    while (this.actorQueueLength(actor) > 0) {
      const pending = this.dequeueActorCall(actor)!;
      try {
        const result = this.executeActorCall(actor, pending.run!);
        if (isPromiseLike(result)) {
          if (pending.resolve === undefined) this.actorMailboxMetrics.oneWayAsyncCalls += 1;
          else this.actorMailboxMetrics.asyncCalls += 1;
          void Promise.resolve(result).then(
            (value) => {
              pending.resolve?.(value);
              this.recycleActorCall(actor, pending);
              this.drainOrdered(actor);
            },
            (error) => {
              if (pending.reject) pending.reject(error);
              else {
                CoreLogger.error("one-way actor mailbox failed", {
                  scene: actor.ref.sceneId,
                  actor: actor.ref.actorId,
                  error,
                });
              }
              this.recycleActorCall(actor, pending);
              this.drainOrdered(actor);
            },
          );
          return;
        }
        pending.resolve?.(result);
        this.recycleActorCall(actor, pending);
      } catch (error) {
        if (pending.reject) pending.reject(error);
        else {
          CoreLogger.error("one-way actor mailbox failed", {
            scene: actor.ref.sceneId,
            actor: actor.ref.actorId,
            error,
          });
        }
        this.recycleActorCall(actor, pending);
      }
    }
    actor.running = false;
  }

  private enqueueActorCall(
    actor: ActorRuntime,
    run: (actor: ActorRuntimeEntity<any[]>) => MaybePromise<unknown>,
    resolve?: (value: unknown) => void,
    reject?: (reason: unknown) => void,
  ): void {
    const pending = actor.recycledQueueItems.pop() ?? { run };
    pending.run = run;
    pending.resolve = resolve;
    pending.reject = reject;
    actor.queue.push(pending);
    this.actorMailboxMetrics.queuedDepth += 1;
    this.actorMailboxMetrics.maxQueuedDepth = Math.max(
      this.actorMailboxMetrics.maxQueuedDepth,
      this.actorMailboxMetrics.queuedDepth,
    );
  }

  private dequeueActorCall(actor: ActorRuntime): PendingActorCall | undefined {
    if (actor.queueHead >= actor.queue.length) return undefined;
    const pending = actor.queue[actor.queueHead++];
    if (actor.queueHead === actor.queue.length) {
      actor.queue.length = 0;
      actor.queueHead = 0;
    } else if (actor.queueHead >= 1024 && actor.queueHead * 2 >= actor.queue.length) {
      actor.queue.splice(0, actor.queueHead);
      actor.queueHead = 0;
    }
    this.actorMailboxMetrics.queuedDepth = Math.max(
      0,
      this.actorMailboxMetrics.queuedDepth - 1,
    );
    return pending;
  }

  private recycleActorCall(actor: ActorRuntime, pending: PendingActorCall): void {
    pending.run = undefined;
    pending.resolve = undefined;
    pending.reject = undefined;
    actor.recycledQueueItems.push(pending);
  }

  private actorQueueLength(actor: ActorRuntime): number {
    return actor.queue.length - actor.queueHead;
  }

  private disposeFailedEntity(entity: Entity, label: string): void {
    try {
      entity.__dispose();
    } catch (error) {
      CoreLogger.error("entity cleanup failed", { label, error });
    }
  }

  private getLocalScene(sceneId: SceneId): SceneRuntime {
    const scene = this.scenes.get(sceneId);
    if (!scene) {
      throw new Error(`scene not found: ${sceneId}`);
    }
    return scene;
  }

  private allocateInstanceId(): InstanceId {
    return InstanceIdSystem.Instance.Next();
  }
}
