import type { ProcessHost } from "./host";
import type {
  ActorCtor,
  ActorAwakeArgs,
  ActorId,
  ActorRef,
  HandlerName,
  MessageTarget,
  SceneId,
  SceneRef,
} from "./types";
import type { Actor } from "./entities";
import type { MaybePromise } from "../async";
import type { TimerId } from "./TimerSystem";
import { Logger } from "../logging/Logger";

export class SceneContext {
  readonly logger: Logger;

  constructor(
    private readonly host: ProcessHost,
    public readonly self: SceneRef,
  ) {
    this.logger = new Logger("scene", {
      category: "business",
      scene: self.sceneId,
      sceneType: self.sceneType,
    });
  }

  /** Calls an internal handler through the destination mailbox and waits for its result. */
  call<TResponse = unknown>(
    to: MessageTarget,
    handlerName: HandlerName,
    payload?: unknown,
  ): Promise<TResponse> {
    return this.host.call<TResponse>(this.self, to, handlerName, payload);
  }

  /** Enqueues a one-way internal handler call; failures are reported by the host. */
  send(to: MessageTarget, handlerName: HandlerName, payload?: unknown): void {
    this.host.send(this.self, to, handlerName, payload);
  }

  /** Creates and attaches an Actor inside this Scene. */
  spawnActor<T extends Actor<any[]>>(
    actorId: ActorId,
    ctor: ActorCtor<T>,
    ...awakeArgs: ActorAwakeArgs<T>
  ): T {
    return this.host.spawnActor(this.self.sceneId, actorId, ctor, ...awakeArgs);
  }

  /** Removes an Actor and invalidates its InstanceId routing. */
  despawnActor(actorId: ActorId): boolean {
    return this.host.despawnActor(this.self.sceneId, actorId);
  }

  /** Resolves this context's owning Scene Entity. */
  DomainScene<T extends import("./entities").Scene = import("./entities").Scene>(): T {
    return this.host.sceneById<T>(this.self.sceneId);
  }

  /** Creates a checked reference to a local Scene. */
  ref(sceneId: SceneId): SceneRef {
    return this.host.localSceneRef(sceneId);
  }

  /** Creates a checked reference to a local Actor by business id. */
  actorRef(sceneId: SceneId, actorId: ActorId): ActorRef {
    return this.host.localActorRef(sceneId, actorId);
  }

  /** Sleeps on host time; gameplay scheduling should use Entity timers. */
  sleep(ms: number): Promise<void> {
    return hostSleep(ms);
  }

}

export class ActorContext {
  readonly logger: Logger;

  constructor(
    private readonly host: ProcessHost,
    public readonly self: ActorRef,
  ) {
    this.logger = new Logger("actor", {
      category: "business",
      scene: self.sceneId,
      sceneType: self.sceneType,
      actorId: self.actorId,
    });
  }

  /** Calls another internal target while preserving this Actor as the sender. */
  call<TResponse = unknown>(
    to: MessageTarget,
    handlerName: HandlerName,
    payload?: unknown,
  ): Promise<TResponse> {
    return this.host.call<TResponse>(this.self, to, handlerName, payload);
  }

  /** Sends an internal one-way message without waiting for target execution. */
  send(to: MessageTarget, handlerName: HandlerName, payload?: unknown): void {
    this.host.send(this.self, to, handlerName, payload);
  }

  /** Creates a checked local Scene reference. */
  ref(sceneId: SceneId): SceneRef {
    return this.host.localSceneRef(sceneId);
  }

  /** Creates a checked local Actor reference. */
  actorRef(sceneId: SceneId, actorId: ActorId): ActorRef {
    return this.host.localActorRef(sceneId, actorId);
  }

  /** Resolves the Scene that owns this Actor. */
  DomainScene<T extends import("./entities").Scene = import("./entities").Scene>(): T {
    return this.host.sceneById<T>(this.self.sceneId);
  }

  /** Sleeps on host time and does not serialize the continuation through the Actor mailbox. */
  sleep(ms: number): Promise<void> {
    return hostSleep(ms);
  }

  /** Schedules a one-shot callback through this Actor's mailbox. */
  newOnceTimer(
    delayMs: number,
    callback: (actor: Actor<any[]>) => MaybePromise<void>,
  ): TimerId {
    return this.host.newActorOnceTimer(this.self.instanceId, delayMs, callback);
  }

  /** Schedules repeated callbacks through this Actor's mailbox. */
  newRepeatedTimer(
    intervalMs: number,
    callback: (actor: Actor<any[]>) => MaybePromise<void>,
  ): TimerId {
    return this.host.newActorRepeatedTimer(this.self.instanceId, intervalMs, callback);
  }

  /** Cancels one timer owned by this Actor InstanceId. */
  removeTimer(timerId: TimerId): boolean {
    return this.host.removeActorTimer(this.self.instanceId, timerId);
  }

}

/** Uses the Rust host sleep op when available and falls back only in standalone tests. */
export function hostSleep(ms: number): Promise<void> {
  const sleep = (globalThis as unknown as { __hostSleep?: (ms: number) => Promise<void> })
    .__hostSleep;
  if (sleep) return sleep(ms);

  return new Promise((resolve) => setTimeout(resolve, ms));
}
