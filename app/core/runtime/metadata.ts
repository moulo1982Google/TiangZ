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

/** Attaches static Scene metadata during module evaluation; it does not create a Scene. */
export function scene(options: SceneOptions): ClassDecorator {
  return (ctor) => {
    sceneOptions.set(ctor, { mailbox: "ordered", ...options });
  };
}

/** Declares Actor mailbox defaults used when the Actor is spawned. */
export function actor(options: ActorOptions = {}): ClassDecorator {
  return (ctor) => {
    actorOptions.set(ctor, { mailbox: "ordered", ...options });
  };
}

/** Marks a Component for tooling while leaving construction to Entity.AddComponent. */
export function component(): ClassDecorator {
  return () => {};
}

/** Records legacy Actor method metadata; typed protocol handler classes are preferred. */
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

/** Reads Scene metadata without inheriting or mutating it. */
export function getSceneOptions(ctor: Function): SceneOptions | undefined {
  return sceneOptions.get(ctor);
}

/** Reads Actor mailbox metadata used during spawn. */
export function getActorOptions(ctor: Function): ActorOptions | undefined {
  return actorOptions.get(ctor);
}

/** Returns recorded method metadata for runtime bootstrap. */
export function getHandlerMetadata(ctor: Function): HandlerMetadata | undefined {
  return handlerMetadata.get(ctor);
}
