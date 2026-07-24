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

  call<TResponse = unknown>(
    to: MessageTarget,
    handlerName: HandlerName,
    payload?: unknown,
  ): Promise<TResponse> {
    return this.host.call<TResponse>(this.self, to, handlerName, payload);
  }

  send(to: MessageTarget, handlerName: HandlerName, payload?: unknown): void {
    this.host.send(this.self, to, handlerName, payload);
  }

  spawnActor<T extends Actor<any[]>>(
    actorId: ActorId,
    ctor: ActorCtor<T>,
    ...awakeArgs: ActorAwakeArgs<T>
  ): T {
    return this.host.spawnActor(this.self.sceneId, actorId, ctor, ...awakeArgs);
  }

  despawnActor(actorId: ActorId): boolean {
    return this.host.despawnActor(this.self.sceneId, actorId);
  }

  DomainScene<T extends import("./entities").Scene = import("./entities").Scene>(): T {
    return this.host.sceneById<T>(this.self.sceneId);
  }

  ref(sceneId: SceneId): SceneRef {
    return this.host.localSceneRef(sceneId);
  }

  actorRef(sceneId: SceneId, actorId: ActorId): ActorRef {
    return this.host.localActorRef(sceneId, actorId);
  }

  sleep(ms: number): Promise<void> {
    return hostSleep(ms);
  }

  log(...args: unknown[]): void {
    this.logger.info(args.map(String).join(" "));
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

  call<TResponse = unknown>(
    to: MessageTarget,
    handlerName: HandlerName,
    payload?: unknown,
  ): Promise<TResponse> {
    return this.host.call<TResponse>(this.self, to, handlerName, payload);
  }

  send(to: MessageTarget, handlerName: HandlerName, payload?: unknown): void {
    this.host.send(this.self, to, handlerName, payload);
  }

  ref(sceneId: SceneId): SceneRef {
    return this.host.localSceneRef(sceneId);
  }

  actorRef(sceneId: SceneId, actorId: ActorId): ActorRef {
    return this.host.localActorRef(sceneId, actorId);
  }

  DomainScene<T extends import("./entities").Scene = import("./entities").Scene>(): T {
    return this.host.sceneById<T>(this.self.sceneId);
  }

  sleep(ms: number): Promise<void> {
    return hostSleep(ms);
  }

  newOnceTimer(
    delayMs: number,
    callback: (actor: Actor<any[]>) => MaybePromise<void>,
  ): TimerId {
    return this.host.newActorOnceTimer(this.self.instanceId, delayMs, callback);
  }

  newRepeatedTimer(
    intervalMs: number,
    callback: (actor: Actor<any[]>) => MaybePromise<void>,
  ): TimerId {
    return this.host.newActorRepeatedTimer(this.self.instanceId, intervalMs, callback);
  }

  removeTimer(timerId: TimerId): boolean {
    return this.host.removeActorTimer(this.self.instanceId, timerId);
  }

  log(...args: unknown[]): void {
    this.logger.info(args.map(String).join(" "));
  }
}

export function hostSleep(ms: number): Promise<void> {
  const sleep = (globalThis as unknown as { __hostSleep?: (ms: number) => Promise<void> })
    .__hostSleep;
  if (sleep) return sleep(ms);

  return new Promise((resolve) => setTimeout(resolve, ms));
}
