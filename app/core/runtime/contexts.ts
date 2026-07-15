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

export class SceneContext {
  constructor(
    private readonly host: ProcessHost,
    public readonly self: SceneRef,
  ) {}

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
    console.log(`[${this.self.sceneType}:${this.self.sceneId}]`, ...args);
  }
}

export class ActorContext {
  constructor(
    private readonly host: ProcessHost,
    public readonly self: ActorRef,
  ) {}

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

  log(...args: unknown[]): void {
    console.log(
      `[${this.self.sceneType}:${this.self.sceneId}/${this.self.actorId}]`,
      ...args,
    );
  }
}

export function hostSleep(ms: number): Promise<void> {
  const sleep = (globalThis as unknown as { __hostSleep?: (ms: number) => Promise<void> })
    .__hostSleep;
  if (sleep) return sleep(ms);

  return new Promise((resolve) => setTimeout(resolve, ms));
}
