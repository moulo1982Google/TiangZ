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

/** 模块求值时附加静态 Scene 元数据，但不创建 Scene。 / Attaches static Scene metadata during module evaluation; it does not create a Scene. */
export function scene(options: SceneOptions): ClassDecorator {
  return (ctor) => {
    sceneOptions.set(ctor, { mailbox: "ordered", ...options });
  };
}

/** 声明 Actor 创建时使用的默认 mailbox 配置。 / Declares Actor mailbox defaults used when the Actor is spawned. */
export function actor(options: ActorOptions = {}): ClassDecorator {
  return (ctor) => {
    actorOptions.set(ctor, { mailbox: "ordered", ...options });
  };
}

/** 为工具标记 Component；实例仍必须由 Entity.AddComponent 构造。 / Marks a Component for tooling while leaving construction to Entity.AddComponent. */
export function component(): ClassDecorator {
  return () => {};
}

/** 记录旧式 Actor 方法元数据；新代码优先使用类型化协议 Handler 类。 / Records legacy Actor method metadata; typed protocol handler classes are preferred. */
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

/** 读取 Scene 元数据，不继承也不修改它。 / Reads Scene metadata without inheriting or mutating it. */
export function getSceneOptions(ctor: Function): SceneOptions | undefined {
  return sceneOptions.get(ctor);
}

/** 读取 Actor 创建时使用的 mailbox 元数据。 / Reads Actor mailbox metadata used during spawn. */
export function getActorOptions(ctor: Function): ActorOptions | undefined {
  return actorOptions.get(ctor);
}

/** 返回运行时启动所需的已记录方法元数据。 / Returns recorded method metadata for runtime bootstrap. */
export function getHandlerMetadata(ctor: Function): HandlerMetadata | undefined {
  return handlerMetadata.get(ctor);
}
