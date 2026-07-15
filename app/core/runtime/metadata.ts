import type {
  ActorOptions,
  HandlerName,
  SceneOptions,
} from "./types";

export interface HandlerBinding {
  owner: object;
  method: string;
}

type HandlerMetadata = Map<HandlerName, string>;

const sceneOptions = new WeakMap<Function, SceneOptions>();
const actorOptions = new WeakMap<Function, ActorOptions>();
const handlerMetadata = new WeakMap<Function, HandlerMetadata>();

export function scene(options: SceneOptions): ClassDecorator {
  return (ctor) => {
    sceneOptions.set(ctor, { mailbox: "ordered", ...options });
  };
}

export function actor(options: ActorOptions = {}): ClassDecorator {
  return (ctor) => {
    actorOptions.set(ctor, { mailbox: "ordered", ...options });
  };
}

export function component(): ClassDecorator {
  return () => {};
}

export function handler(name?: HandlerName): MethodDecorator {
  return (target, propertyKey) => {
    const ctor = target.constructor;
    let metadata = handlerMetadata.get(ctor);
    if (!metadata) {
      metadata = new Map();
      handlerMetadata.set(ctor, metadata);
    }
    metadata.set(name ?? String(propertyKey), String(propertyKey));
  };
}

export function getSceneOptions(ctor: Function): SceneOptions | undefined {
  return sceneOptions.get(ctor);
}

export function getActorOptions(ctor: Function): ActorOptions | undefined {
  return actorOptions.get(ctor);
}

export function getHandlerMetadata(ctor: Function): HandlerMetadata | undefined {
  return handlerMetadata.get(ctor);
}
