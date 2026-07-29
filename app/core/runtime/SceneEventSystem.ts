import { isPromiseLike } from "../async";
import { HotfixBindingStore } from "../hotReload/HotfixSystem";
import { CoreLogger } from "../logging/Logger";
import type { Scene } from "./entities";

export interface SyncEventDescriptor<TEvent> {
  readonly name: string;
  readonly mode: "sync";
  readonly __event?: TEvent;
}

export interface AsyncEventDescriptor<TEvent> {
  readonly name: string;
  readonly mode: "async";
  readonly __event?: TEvent;
}

export interface EventPublishResult {
  readonly handlerCount: number;
  readonly failedCount: number;
}

export interface SyncSceneEventHandler<TScene extends Scene, TEvent> {
  Handle(scene: TScene, event: TEvent): void;
}

export interface AsyncSceneEventHandler<TScene extends Scene, TEvent> {
  Handle(scene: TScene, event: TEvent): Promise<void>;
}

type SceneClass<TScene extends Scene> = new (...args: any[]) => TScene;
type AnySyncBinding = {
  sceneCtor: Function;
  descriptor: SyncEventDescriptor<unknown>;
  handlerCtor: new () => SyncSceneEventHandler<Scene, unknown>;
};
type AnyAsyncBinding = {
  sceneCtor: Function;
  descriptor: AsyncEventDescriptor<unknown>;
  handlerCtor: new () => AsyncSceneEventHandler<Scene, unknown>;
};

const syncHandlers = new HotfixBindingStore<AnySyncBinding>("scene-sync-event");
const asyncHandlers = new HotfixBindingStore<AnyAsyncBinding>("scene-async-event");
const handlerInstances = new WeakMap<Function, object>();

/** 定义同步Scene内事件；名字必须跨Hotfix generation保持稳定。 / Defines a synchronous Scene-local event whose name remains stable across Hotfix generations. */
export function defineSyncEvent<TEvent>(name: string): SyncEventDescriptor<TEvent> {
  return defineEvent(name, "sync");
}

/** 定义异步Scene内事件；发布方必须await全部监听器结束。 / Defines an asynchronous Scene-local event whose publisher must await all listeners. */
export function defineAsyncEvent<TEvent>(name: string): AsyncEventDescriptor<TEvent> {
  return defineEvent(name, "async");
}

/** 注册同步Hotfix监听器；返回Promise属于契约错误。 / Registers a synchronous Hotfix listener; returning a Promise violates the contract. */
export function syncEventHandler<TScene extends Scene, TEvent>(
  sceneCtor: SceneClass<TScene>,
  descriptor: SyncEventDescriptor<TEvent>,
): (handlerCtor: new () => SyncSceneEventHandler<TScene, TEvent>) => void {
  return (handlerCtor) => {
    syncHandlers.Register(bindingKey(sceneCtor, descriptor), {
      sceneCtor,
      descriptor: descriptor as SyncEventDescriptor<unknown>,
      handlerCtor: handlerCtor as new () => SyncSceneEventHandler<Scene, unknown>,
    });
  };
}

/** 注册异步Hotfix监听器；不同监听器相互独立并发执行。 / Registers an asynchronous Hotfix listener; independent listeners run concurrently. */
export function asyncEventHandler<TScene extends Scene, TEvent>(
  sceneCtor: SceneClass<TScene>,
  descriptor: AsyncEventDescriptor<TEvent>,
): (handlerCtor: new () => AsyncSceneEventHandler<TScene, TEvent>) => void {
  return (handlerCtor) => {
    asyncHandlers.Register(bindingKey(sceneCtor, descriptor), {
      sceneCtor,
      descriptor: descriptor as AsyncEventDescriptor<unknown>,
      handlerCtor: handlerCtor as new () => AsyncSceneEventHandler<Scene, unknown>,
    });
  };
}

/**
 * 绑定一个具体Scene实例的事件门面。
 * API不接收目标Scene，因而普通业务无法借Event跨Scene；跨Scene协作必须使用
 * Scene RPC、Actor消息或Location路由。
 *
 * Event facade bound to one concrete Scene. It accepts no target Scene, making
 * cross-Scene event delivery impossible in ordinary business code. Use Scene
 * RPC, Actor messaging, or Location routing across Scene boundaries.
 */
export class SceneEventScope {
  constructor(private readonly scene: Scene) {}

  Publish<TEvent>(
    descriptor: SyncEventDescriptor<TEvent>,
    event: TEvent,
  ): EventPublishResult {
    this.requireAlive();
    const bindings = syncHandlers.Values().filter(
      (binding) => binding.sceneCtor === this.scene.constructor
        && binding.descriptor.name === descriptor.name,
    );
    let failedCount = 0;
    for (const binding of bindings) {
      try {
        const handler = getHandlerInstance(binding.handlerCtor);
        const result = handler.Handle(this.scene, event) as unknown;
        if (isPromiseLike(result)) {
          void Promise.resolve(result).catch((error) => {
            logEventFailure(this.scene, descriptor.name, binding.handlerCtor, error);
          });
          throw new Error(
            `sync event handler returned Promise: ${binding.handlerCtor.name}.Handle`,
          );
        }
      } catch (error) {
        failedCount += 1;
        logEventFailure(this.scene, descriptor.name, binding.handlerCtor, error);
      }
    }
    return { handlerCount: bindings.length, failedCount };
  }

  async PublishAsync<TEvent>(
    descriptor: AsyncEventDescriptor<TEvent>,
    event: TEvent,
  ): Promise<EventPublishResult> {
    this.requireAlive();
    const bindings = asyncHandlers.Values().filter(
      (binding) => binding.sceneCtor === this.scene.constructor
        && binding.descriptor.name === descriptor.name,
    );
    const results = await Promise.allSettled(bindings.map(async (binding) => {
      const handler = getHandlerInstance(binding.handlerCtor);
      await handler.Handle(this.scene, event);
    }));
    let failedCount = 0;
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status === "fulfilled") continue;
      failedCount += 1;
      logEventFailure(
        this.scene,
        descriptor.name,
        bindings[index].handlerCtor,
        result.reason,
      );
    }
    return { handlerCount: bindings.length, failedCount };
  }

  private requireAlive(): void {
    if (this.scene.IsDisposed) {
      throw new Error(`cannot publish Event from disposed Scene: ${String(this.scene.Id)}`);
    }
  }
}

function defineEvent<TEvent, TMode extends "sync" | "async">(
  name: string,
  mode: TMode,
): { readonly name: string; readonly mode: TMode; readonly __event?: TEvent } {
  if (!name.trim()) throw new Error("scene event name must not be empty");
  return Object.freeze({ name, mode });
}

function bindingKey(
  sceneCtor: Function,
  descriptor: { readonly name: string },
): string {
  return `${sceneCtor.name}:${descriptor.name}`;
}

function getHandlerInstance<T extends object>(ctor: new () => T): T {
  let instance = handlerInstances.get(ctor) as T | undefined;
  if (!instance) {
    instance = new ctor();
    handlerInstances.set(ctor, instance);
  }
  return instance;
}

function logEventFailure(
  scene: Scene,
  event: string,
  handlerCtor: Function,
  error: unknown,
): void {
  CoreLogger.error("scene event handler failed", {
    scene: String(scene.Id),
    sceneType: scene.constructor.name,
    event,
    handler: handlerCtor.name,
    error,
  });
}
