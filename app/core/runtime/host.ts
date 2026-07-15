import { ActorContext, SceneContext } from "./contexts";
import { isPromiseLike, type MaybePromise } from "../async";
import type {
  Actor,
  Scene,
} from "./entities";
import { MailBoxComponent } from "./MailBoxComponent";
import { EntityRoot } from "./root";
import { Unit, UnitComponent } from "./Unit";
import {
  getActorOptions,
  getHandlerMetadata,
  getSceneOptions,
  type HandlerBinding,
} from "./metadata";
import type {
  ActorCtor,
  ActorAwakeArgs,
  ActorId,
  ActorRef,
  Envelope,
  HandlerName,
  MailboxType,
  MessageTarget,
  SceneCtor,
  SceneId,
  SceneRef,
  SceneOptions,
  InstanceId,
} from "./types";

interface MailboxRuntime {
  mailbox: MailboxType;
  handlers: Map<HandlerName, HandlerBinding>;
  queue: PendingDispatch[];
  running: boolean;
}

interface SceneRuntime extends MailboxRuntime {
  ref: SceneRef;
  instance: Scene;
  actors: Map<ActorId, ActorRuntime>;
}

interface ActorRuntime extends MailboxRuntime {
  ref: ActorRef;
  instance: Actor<any[]>;
  mailBox: MailBoxComponent;
}

interface PendingDispatch {
  envelope: Envelope;
  direct?: (actor: Actor<any[]>) => MaybePromise<unknown>;
  resolve?: (value: unknown) => void;
  reject?: (reason: unknown) => void;
}

export class ProcessHost {
  readonly Root = new EntityRoot();
  private readonly scenes = new Map<SceneId, SceneRuntime>();
  private readonly actorsByInstanceId = new Map<InstanceId, ActorRuntime>();
  private nextMessageId = 1;
  private nextInstanceId = 1;

  constructor(public readonly processId = "process-1") {}

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
    const instanceId = this.allocateInstanceId();
    instance.__attach(sceneId, instanceId, undefined, instance);
    this.Root.Add(instance);
    const handlers = new Map<HandlerName, HandlerBinding>();
    try {
      this.collectHandlers(ctor, instance, handlers);
      this.bindComponentHandlers(instance, handlers);
    } catch (error) {
      this.Root.Remove(instanceId);
      this.disposeFailedEntity(instance, `scene ${sceneId}`);
      throw error;
    }

    this.scenes.set(sceneId, {
      ref,
      instance,
      mailbox: options.mailbox ?? "ordered",
      handlers,
      queue: [],
      running: false,
      actors: new Map(),
    });

    return instance;
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
    const handlers = new Map<HandlerName, HandlerBinding>();

    try {
      instance.__attach(actorId, ref.instanceId, scene.instance, scene.instance);
      this.Root.Add(instance);
      const mailBox = instance.AddComponent(
        MailBoxComponent,
        options.mailbox ?? "ordered",
      );
      instance.__awake(...awakeArgs);
      this.collectHandlers(ctor, instance, handlers);
      this.bindComponentHandlers(instance, handlers);
      const runtime: ActorRuntime = {
        ref,
        instance,
        mailbox: mailBox.MailboxType,
        mailBox,
        handlers,
        queue: [],
        running: false,
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

  despawnScene(sceneId: SceneId): boolean {
    const scene = this.scenes.get(sceneId);
    if (!scene) return false;

    for (const actorId of [...scene.actors.keys()]) {
      this.despawnActor(sceneId, actorId);
    }
    this.scenes.delete(sceneId);
    this.Root.Remove(scene.instance.InstanceId);
    const error = new Error(`scene despawned: ${sceneId}`);
    for (const pending of scene.queue.splice(0, scene.queue.length)) {
      pending.reject?.(error);
    }
    try {
      scene.instance.__dispose();
    } catch (disposeError) {
      console.error(`scene destroy failed: ${sceneId}`, disposeError);
    }
    return true;
  }

  localSceneRef(sceneId: SceneId): SceneRef {
    return this.getLocalScene(sceneId).ref;
  }

  localActorRef(sceneId: SceneId, actorId: ActorId): ActorRef {
    const scene = this.getLocalScene(sceneId);
    const actor = scene.actors.get(actorId);
    if (!actor) {
      throw new Error(`actor not found: ${sceneId}/${actorId}`);
    }
    return actor.ref;
  }

  actorRefByInstanceId(instanceId: InstanceId): ActorRef | undefined {
    return this.actorsByInstanceId.get(instanceId)?.ref;
  }

  actorByInstanceId<T extends Actor<any[]> = Actor<any[]>>(
    instanceId: InstanceId,
  ): T | undefined {
    return this.actorsByInstanceId.get(instanceId)?.instance as T | undefined;
  }

  sceneById<T extends Scene = Scene>(sceneId: SceneId): T {
    return this.getLocalScene(sceneId).instance as T;
  }

  hasActor(sceneId: SceneId, actorId: ActorId): boolean {
    const scene = this.getLocalScene(sceneId);
    return scene.actors.has(actorId);
  }

  despawnActor(sceneId: SceneId, actorId: ActorId): boolean {
    const scene = this.getLocalScene(sceneId);
    const actor = scene.actors.get(actorId);
    if (!actor) return false;

    scene.actors.delete(actorId);
    this.actorsByInstanceId.delete(actor.ref.instanceId);
    this.Root.Remove(actor.ref.instanceId);
    if (
      actor.instance instanceof Unit &&
      actor.instance.Parent instanceof UnitComponent
    ) {
      actor.instance.Parent.__detach(actor.instance.UnitId);
    }
    const error = new Error(`actor despawned: ${sceneId}/${actorId}`);
    for (const pending of actor.queue.splice(0, actor.queue.length)) {
      pending.reject?.(error);
    }
    try {
      actor.instance.__dispose();
    } catch (disposeError) {
      console.error(`actor destroy failed: ${sceneId}/${actorId}`, disposeError);
    }
    return true;
  }

  runActorMailbox<T>(
    instanceId: InstanceId,
    run: (actor: Actor<any[]>) => MaybePromise<T>,
  ): Promise<T> {
    const actor = this.actorsByInstanceId.get(instanceId);
    const entity = this.Root.Get(instanceId);
    if (!actor || entity !== actor.instance) {
      return Promise.reject(new Error(`actor instance not found: ${instanceId}`));
    }

    return new Promise<T>((resolve, reject) => {
      this.dispatch({
        envelope: {
          id: this.nextMessageId++,
          to: actor.ref,
          handler: `<actor-instance:${instanceId}>`,
          payload: undefined,
          kind: "call",
        },
        direct: run as (actor: Actor<any[]>) => MaybePromise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });
  }

  call<TResponse = unknown>(
    from: MessageTarget | undefined,
    to: MessageTarget,
    handlerName: HandlerName,
    payload?: unknown,
  ): Promise<TResponse> {
    if (from && isSameMailbox(from, to)) {
      throw new Error(`ordered self-call is forbidden: ${targetKey(to)}.${handlerName}`);
    }

    return new Promise<TResponse>((resolve, reject) => {
      this.dispatch({
        envelope: {
          id: this.nextMessageId++,
          from,
          to,
          handler: handlerName,
          payload,
          kind: "call",
        },
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });
  }

  send(
    from: MessageTarget | undefined,
    to: MessageTarget,
    handlerName: HandlerName,
    payload?: unknown,
  ): void {
    this.dispatch({
      envelope: {
        id: this.nextMessageId++,
        from,
        to,
        handler: handlerName,
        payload,
        kind: "send",
      },
    });
  }

  private bindComponentHandlers(
    entity: Scene | Actor,
    handlers: Map<HandlerName, HandlerBinding>,
  ): void {
    entity.__bindComponentHooks({
      added: (ctor, instance) => this.collectHandlers(ctor, instance, handlers),
      removing: (instance) => this.removeHandlers(instance, handlers),
    });
  }

  private collectHandlers(
    ctor: Function,
    owner: object,
    handlers: Map<HandlerName, HandlerBinding>,
  ): void {
    const metadata = getHandlerMetadata(ctor);
    if (!metadata) return;

    for (const [handlerName, method] of metadata) {
      if (handlers.has(handlerName)) {
        throw new Error(`duplicate handler ${handlerName}`);
      }
    }
    for (const [handlerName, method] of metadata) {
      handlers.set(handlerName, { owner, method });
    }
  }

  private removeHandlers(
    owner: object,
    handlers: Map<HandlerName, HandlerBinding>,
  ): void {
    for (const [handlerName, binding] of handlers) {
      if (binding.owner === owner) handlers.delete(handlerName);
    }
  }

  private disposeFailedEntity(entity: Scene | Actor, label: string): void {
    try {
      entity.__dispose();
    } catch (error) {
      console.error(`${label} cleanup failed`, error);
    }
  }

  private dispatch(pending: PendingDispatch): void {
    if (pending.envelope.to.processId !== this.processId) {
      pending.reject?.(
        new Error(
          `remote dispatch is not implemented yet: ${pending.envelope.to.processId}`,
        ),
      );
      return;
    }

    const mailbox = this.resolveMailbox(pending.envelope.to);
    if (!mailbox) {
      pending.reject?.(new Error(`target not found: ${targetKey(pending.envelope.to)}`));
      return;
    }

    if (mailboxType(mailbox) === "unordered") {
      const result = this.invoke(mailbox, pending);
      if (isPromiseLike(result)) {
        void result.catch((error) => this.logUnexpectedDispatchError(error));
      }
      return;
    }

    mailbox.queue.push(pending);
    if (!mailbox.running) {
      mailbox.running = true;
      this.drainOrdered(mailbox);
    }
  }

  private drainOrdered(mailbox: MailboxRuntime): void {
    while (mailbox.queue.length > 0) {
      const pending = mailbox.queue.shift()!;
      const result = this.invoke(mailbox, pending);
      if (isPromiseLike(result)) {
        void result.then(
          () => this.drainOrdered(mailbox),
          (error) => {
            this.logUnexpectedDispatchError(error);
            this.drainOrdered(mailbox);
          },
        );
        return;
      }
    }
    mailbox.running = false;
  }

  private invoke(
    mailbox: MailboxRuntime,
    pending: PendingDispatch,
  ): MaybePromise<void> {
    const binding = pending.direct
      ? undefined
      : mailbox.handlers.get(pending.envelope.handler);
    if (!pending.direct && !binding) {
      pending.reject?.(
        new Error(
          `handler not found: ${targetKey(pending.envelope.to)}.${pending.envelope.handler}`,
        ),
      );
      return;
    }

    try {
      if (pending.direct) {
        if (!("instance" in mailbox) || !("mailBox" in mailbox)) {
          throw new Error("direct actor dispatch requires an Actor mailbox");
        }
        const result = pending.direct((mailbox as ActorRuntime).instance);
        if (isPromiseLike(result)) {
          return Promise.resolve(result).then(
            (value) => pending.resolve?.(value),
            (error) => this.handleInvokeError(pending, error),
          );
        }
        pending.resolve?.(result);
        return;
      }

      if (!binding) {
        throw new Error(`handler binding disappeared: ${pending.envelope.handler}`);
      }
      const fn = (binding.owner as unknown as Record<string, unknown>)[binding.method];
      if (typeof fn !== "function") {
        throw new Error(`handler is not a function: ${binding.method}`);
      }

      const result = fn.call(
        binding.owner,
        pending.envelope.payload,
        pending.envelope,
      ) as MaybePromise<unknown>;
      if (isPromiseLike(result)) {
        return Promise.resolve(result).then(
          (value) => pending.resolve?.(value),
          (error) => this.handleInvokeError(pending, error),
        );
      }
      pending.resolve?.(result);
    } catch (error) {
      this.handleInvokeError(pending, error);
    }
  }

  private handleInvokeError(pending: PendingDispatch, error: unknown): void {
    pending.reject?.(error);
    if (pending.envelope.kind === "send") {
      console.error(`send failed: ${pending.envelope.handler}`, error);
    }
  }

  private logUnexpectedDispatchError(error: unknown): void {
    console.error("mailbox dispatch failed", error);
  }

  private resolveMailbox(target: MessageTarget): MailboxRuntime | undefined {
    if (isActorRef(target)) {
      const actor = this.actorsByInstanceId.get(target.instanceId);
      const entity = this.Root.Get(target.instanceId);
      if (
        !actor ||
        entity !== actor.instance ||
        actor.ref.sceneId !== target.sceneId ||
        actor.ref.actorId !== target.actorId
      ) {
        return undefined;
      }
      return actor;
    }

    return this.scenes.get(target.sceneId);
  }

  private getLocalScene(sceneId: SceneId): SceneRuntime {
    const scene = this.scenes.get(sceneId);
    if (!scene) {
      throw new Error(`scene not found: ${sceneId}`);
    }
    return scene;
  }

  private allocateInstanceId(): InstanceId {
    if (this.nextInstanceId > 0xffff_ffff) {
      throw new Error("entity instance id space exhausted");
    }
    return this.nextInstanceId++;
  }
}

function mailboxType(mailbox: MailboxRuntime): MailboxType {
  return "mailBox" in mailbox
    ? (mailbox as ActorRuntime).mailBox.MailboxType
    : mailbox.mailbox;
}

function isActorRef(target: MessageTarget): target is ActorRef {
  return "actorId" in target;
}

function isSameMailbox(a: MessageTarget, b: MessageTarget): boolean {
  if (a.processId !== b.processId || a.sceneId !== b.sceneId) {
    return false;
  }
  if (isActorRef(a) || isActorRef(b)) {
    return isActorRef(a) && isActorRef(b) && a.instanceId === b.instanceId;
  }
  return true;
}

function targetKey(target: MessageTarget): string {
  if (isActorRef(target)) {
    return `${target.processId}/${target.sceneType}:${target.sceneId}/${target.actorId}@${target.instanceId}`;
  }
  return `${target.processId}/${target.sceneType}:${target.sceneId}`;
}
