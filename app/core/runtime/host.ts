import { ActorContext, SceneContext } from "./contexts";
import { isPromiseLike, type MaybePromise } from "../async";
import type {
  Actor,
  ChildEntity,
  Component,
  Entity,
  Scene,
} from "./entities";
import type {
  ChildEntityAwakeArgs,
  ChildEntityCtor,
} from "./entities";
import { MailBoxComponent } from "./MailBoxComponent";
import { EntityRoot } from "./root";
import { Unit, UnitComponent } from "./Unit";
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
  instance: Actor<any[]>;
  mailBox: MailBoxComponent;
  queue: PendingActorCall[];
  running: boolean;
  timers: Set<TimerId>;
}

interface PendingActorCall {
  run: (actor: Actor<any[]>) => MaybePromise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export class ProcessHost {
  readonly Root = new EntityRoot();
  private readonly scenes = new Map<SceneId, SceneRuntime>();
  private readonly actorsByInstanceId = new Map<InstanceId, ActorRuntime>();

  constructor(public readonly processId = "process-1") {}

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

  spawnActor<T extends Actor<any[]>>(
    sceneId: SceneId,
    actorId: ActorId,
    ctor: ActorCtor<T>,
    ...awakeArgs: ActorAwakeArgs<T>
  ): T {
    const scene = this.getLocalScene(sceneId);
    if (scene.actors.has(actorId)) {
      throw new Error(`actor already exists: ${sceneId}/${actorId}`);
    }

    const options = getActorOptions(ctor) ?? {};
    const ref: ActorRef = {
      ...scene.ref,
      actorId,
      instanceId: this.allocateInstanceId(),
    };
    const actorCtx = new ActorContext(this, ref);
    const instance = new ctor(actorCtx);

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
    const scene = this.getLocalScene(sceneId);
    if (parent.DomainScene() !== scene.instance) {
      throw new Error(`child owner belongs to another domain scene: ${String(id)}`);
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
      this.disposeFailedEntity(instance, `child ${sceneId}/${String(id)}`);
      throw error;
    }
  }

  /** 从 EntityRoot 移除并销毁一个本地子 Entity；只有当前拥有者可以执行。 / Removes and disposes a local child Entity; only its current owner may do so. */
  despawnChild(
    sceneId: SceneId,
    parent: Component<any[]>,
    child: ChildEntity<any[]>,
  ): boolean {
    const scene = this.getLocalScene(sceneId);
    if (
      child.Parent !== parent ||
      child.DomainScene() !== scene.instance ||
      this.Root.Get(child.InstanceId) !== child
    ) {
      return false;
    }

    const entityId = child.Id;
    const instanceId = child.InstanceId;
    this.Root.Remove(instanceId);
    try {
      child.__dispose();
    } catch (disposeError) {
      CoreLogger.error("child entity destroy failed", {
        scene: sceneId,
        entity: child.constructor.name,
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
    this.scenes.delete(sceneId);
    SingletonRegistry.TryGet(CoroutineLockSystem)?.CancelScene(scene.instance.InstanceId);
    this.Root.Remove(scene.instance.InstanceId);
    try {
      scene.instance.__dispose();
    } catch (disposeError) {
      CoreLogger.error("scene destroy failed", { scene: sceneId, error: disposeError });
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
    for (const timerId of actor.timers) TimerSystem.Instance.Remove(timerId);
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
    for (const pending of actor.queue.splice(0, actor.queue.length)) {
      pending.reject(error);
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
    callback: (actor: Actor<any[]>) => MaybePromise<void>,
    onCancelled?: (
      actor: Actor<any[]>,
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
    callback: (actor: Actor<any[]>) => MaybePromise<void>,
    onCancelled?: (
      actor: Actor<any[]>,
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
    run: (actor: Actor<any[]>) => MaybePromise<T>,
  ): MaybePromise<T> {
    const actor = this.actorsByInstanceId.get(instanceId);
    if (!actor || this.Root.Get(instanceId) !== actor.instance) {
      return Promise.reject(new Error(`actor instance not found: ${instanceId}`));
    }

    if (actor.mailBox.MailboxType === "unordered") {
      return this.executeActorCall(actor, run);
    }

    if (!actor.running) {
      actor.running = true;
      try {
        const result = this.executeActorCall(actor, run);
        if (isPromiseLike(result)) {
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

    return new Promise<T>((resolve, reject) => {
      actor.queue.push({
        run: run as (actor: Actor<any[]>) => MaybePromise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });
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
    run: (instance: Actor<any[]>) => MaybePromise<T>,
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
    if (actor.queue.length > 0) {
      this.drainOrdered(actor);
    } else {
      actor.running = false;
    }
  }

  private drainOrdered(actor: ActorRuntime): void {
    while (actor.queue.length > 0) {
      const pending = actor.queue.shift()!;
      try {
        const result = this.executeActorCall(actor, pending.run);
        if (isPromiseLike(result)) {
          void Promise.resolve(result).then(
            (value) => {
              pending.resolve(value);
              this.drainOrdered(actor);
            },
            (error) => {
              pending.reject(error);
              this.drainOrdered(actor);
            },
          );
          return;
        }
        pending.resolve(result);
      } catch (error) {
        pending.reject(error);
      }
    }
    actor.running = false;
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
