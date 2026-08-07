import { isPromiseLike } from "../async";
import { HotfixBindingStore } from "../hotReload/HotfixSystem";
import { CoreLogger } from "../logging/Logger";
import type { Scene } from "./entities";

export interface SyncEventDescriptor<TEvent> {
  readonly name: string;
  readonly mode: "sync";
  readonly __event?: TEvent;
}

export interface VetoEventDescriptor<TEvent, TReason extends number> {
  readonly name: string;
  readonly mode: "veto";
  readonly allow: TReason;
  readonly __event?: TEvent;
  readonly __reason?: TReason;
}

export interface EventPublishResult {
  readonly handlerCount: number;
  readonly failedCount: number;
}

export interface SyncSceneEventHandler<TScene extends Scene, TEvent> {
  Handle(scene: TScene, event: TEvent): void;
}

export interface VetoSceneEventHandler<
  TScene extends Scene,
  TEvent,
  TReason extends number,
> {
  Handle(scene: TScene, event: TEvent): TReason;
}

export interface SceneEventHandlerOptions {
  /** 跨Hotfix generation保持稳定的监听器ID；同一Scene和事件内必须唯一。 / Stable listener ID across Hotfix generations; unique within one Scene and event. */
  readonly id: string;
  /** 数值越小越先执行；相同顺序按id排序。 / Lower values run first; equal values are ordered by id. */
  readonly order?: number;
}

type SceneClass<TScene extends Scene> = new (...args: any[]) => TScene;
type AnySyncBinding = {
  sceneCtor: Function;
  descriptor: SyncEventDescriptor<unknown>;
  handlerCtor: new () => SyncSceneEventHandler<Scene, unknown>;
  id: string;
  order: number;
};
type AnyVetoBinding = {
  sceneCtor: Function;
  descriptor: VetoEventDescriptor<unknown, number>;
  handlerCtor: new () => VetoSceneEventHandler<Scene, unknown, number>;
  id: string;
  order: number;
};

const syncHandlers = new HotfixBindingStore<AnySyncBinding>("scene-sync-event");
const vetoHandlers = new HotfixBindingStore<AnyVetoBinding>("scene-veto-event");
const handlerInstances = new WeakMap<Function, object>();

/** 定义同步Scene内事件；名字必须跨Hotfix generation保持稳定。 / Defines a synchronous Scene-local event whose name remains stable across Hotfix generations. */
export function defineSyncEvent<TEvent>(name: string): SyncEventDescriptor<TEvent> {
  return defineEvent(name, "sync");
}

/** 定义同步否决事件与放行码；名字和放行码必须跨Hotfix generation保持稳定。 / Defines a synchronous veto event and its allow code; both remain stable across Hotfix generations. */
export function defineVetoEvent<TEvent, TReason extends number>(
  name: string,
  allow: TReason,
): VetoEventDescriptor<TEvent, TReason> {
  if (!Number.isSafeInteger(allow)) {
    throw new Error(`veto event allow reason must be a safe integer: ${allow}`);
  }
  return Object.freeze({ name: requireEventName(name), mode: "veto", allow });
}

/** 注册同步Hotfix监听器；返回Promise属于契约错误。 / Registers a synchronous Hotfix listener; returning a Promise violates the contract. */
export function syncEventHandler<TScene extends Scene, TEvent>(
  sceneCtor: SceneClass<TScene>,
  descriptor: SyncEventDescriptor<TEvent>,
  options: SceneEventHandlerOptions,
): (handlerCtor: new () => SyncSceneEventHandler<TScene, TEvent>) => void {
  return (handlerCtor) => {
    const normalized = normalizeHandlerOptions(options);
    syncHandlers.Register(bindingKey(sceneCtor, descriptor, normalized.id), {
      sceneCtor,
      descriptor: descriptor as SyncEventDescriptor<unknown>,
      handlerCtor: handlerCtor as new () => SyncSceneEventHandler<Scene, unknown>,
      ...normalized,
    });
  };
}

/** 注册同步否决监听器；监听器必须只读检查并返回错误码，不得返回Promise或产生副作用。 / Registers a synchronous veto listener that performs read-only checks and returns an error code without Promises or side effects. */
export function vetoEventHandler<TScene extends Scene, TEvent, TReason extends number>(
  sceneCtor: SceneClass<TScene>,
  descriptor: VetoEventDescriptor<TEvent, TReason>,
  options: SceneEventHandlerOptions,
): (handlerCtor: new () => VetoSceneEventHandler<TScene, TEvent, TReason>) => void {
  return (handlerCtor) => {
    const normalized = normalizeHandlerOptions(options);
    vetoHandlers.Register(bindingKey(sceneCtor, descriptor, normalized.id), {
      sceneCtor,
      descriptor: descriptor as VetoEventDescriptor<unknown, number>,
      handlerCtor: handlerCtor as new () => VetoSceneEventHandler<Scene, unknown, number>,
      ...normalized,
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
    const bindings = matchingBindings(syncHandlers.Values(), this.scene, descriptor.name);
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

  /**
   * 同步执行否决链并返回第一个非allow错误码。
   * 监听器异常、非法返回值或Promise属于业务契约错误，会立即抛出而不是继续放行。
   *
   * Runs a veto chain synchronously and returns the first non-allow error code.
   * Handler failures, invalid values, and Promises are contract violations and
   * throw immediately instead of allowing the operation to continue.
   */
  Check<TEvent, TReason extends number>(
    descriptor: VetoEventDescriptor<TEvent, TReason>,
    event: TEvent,
  ): TReason {
    this.requireAlive();
    const bindings = matchingBindings(vetoHandlers.Values(), this.scene, descriptor.name);
    for (const binding of bindings) {
      const handler = getHandlerInstance(binding.handlerCtor);
      let reason: unknown;
      try {
        reason = handler.Handle(this.scene, event);
      } catch (error) {
        logEventFailure(this.scene, descriptor.name, binding.handlerCtor, error);
        throw error;
      }
      if (isPromiseLike(reason)) {
        void Promise.resolve(reason).catch((error) => {
          logEventFailure(this.scene, descriptor.name, binding.handlerCtor, error);
        });
        throw new Error(
          `veto event handler returned Promise: ${binding.handlerCtor.name}.Handle`,
        );
      }
      if (!Number.isSafeInteger(reason)) {
        throw new Error(
          `veto event handler returned invalid reason: ${binding.handlerCtor.name}.Handle=${String(reason)}`,
        );
      }
      if (reason !== descriptor.allow) return reason as TReason;
    }
    return descriptor.allow;
  }

  private requireAlive(): void {
    if (this.scene.IsDisposed) {
      throw new Error(`cannot publish Event from disposed Scene: ${String(this.scene.Id)}`);
    }
  }
}

function defineEvent<TEvent, TMode extends "sync">(
  name: string,
  mode: TMode,
): { readonly name: string; readonly mode: TMode; readonly __event?: TEvent } {
  return Object.freeze({ name: requireEventName(name), mode });
}

function bindingKey(
  sceneCtor: Function,
  descriptor: { readonly name: string },
  id: string,
): string {
  return `${sceneCtor.name}:${descriptor.name}:${id}`;
}

function requireEventName(name: string): string {
  const value = name.trim();
  if (!value) throw new Error("scene event name must not be empty");
  return value;
}

function normalizeHandlerOptions(options: SceneEventHandlerOptions): {
  id: string;
  order: number;
} {
  const id = options.id.trim();
  if (!id) throw new Error("scene event handler id must not be empty");
  const order = options.order ?? 0;
  if (!Number.isSafeInteger(order)) {
    throw new Error(`scene event handler order must be a safe integer: ${order}`);
  }
  return { id, order };
}

function matchingBindings<TBinding extends {
  sceneCtor: Function;
  descriptor: { readonly name: string };
  id: string;
  order: number;
}>(
  bindings: readonly TBinding[],
  scene: Scene,
  eventName: string,
): TBinding[] {
  return bindings
    .filter(
      (binding) => binding.sceneCtor === scene.constructor
        && binding.descriptor.name === eventName,
    )
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
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
