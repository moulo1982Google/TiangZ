import type {
  ActorOptions,
  SceneOptions,
} from "./types";

const sceneOptions = new WeakMap<Function, SceneOptions>();
const actorOptions = new WeakMap<Function, ActorOptions>();
const transferableComponents = new WeakSet<Function>();
const lifecycleOptions = new WeakMap<Function, LifecycleOptions>();

/**
 * Model 对 Hotfix System 声明的必需生命周期。
 * 未声明的方法保持可选；声明后 codegen 与热更候选提交都会校验实现。
 * transfer 由 @transferable 单独表达，避免重复配置同一语义。
 *
 * Required lifecycle methods declared by Model for its Hotfix System. Methods
 * remain optional unless declared. Transfer uses @transferable as its single
 * source of truth instead of duplicating the same intent here.
 */
export interface LifecycleOptions {
  readonly awake?: boolean;
  readonly destroy?: boolean;
  readonly deserialize?: boolean;
}

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

/**
 * 声明必须由该 Model 类型的 Hotfix System 实现的生命周期方法。
 * 这里只保存稳定契约，不执行生命周期，也不允许把实现函数放进 Model。
 *
 * Declares lifecycle methods that the Hotfix System for this Model type must
 * implement. This stores a stable contract only; it neither runs lifecycle
 * code nor moves implementation functions into Model.
 */
export function lifecycle(options: LifecycleOptions): ClassDecorator {
  return (ctor) => {
    if (!options.awake && !options.destroy && !options.deserialize) {
      throw new Error(`lifecycle declaration is empty: ${ctor.name}`);
    }
    lifecycleOptions.set(ctor, { ...options });
  };
}

/**
 * 显式声明Component参与Entity迁移；未标记组件默认不会传送。
 * 组件仍须实现ITransfer的同步捕获与恢复方法，禁止传递Native handle或Promise。
 *
 * Explicitly opts a Component into Entity transfer. Unmarked Components are
 * excluded by default. The Component must still implement synchronous
 * ITransfer capture/restore methods and must not transfer Native handles or Promises.
 */
export function transferable(): ClassDecorator {
  return (ctor) => {
    transferableComponents.add(ctor);
  };
}

/** 读取 Scene 元数据，不继承也不修改它。 / Reads Scene metadata without inheriting or mutating it. */
export function getSceneOptions(ctor: Function): SceneOptions | undefined {
  return sceneOptions.get(ctor);
}

/** 读取 Actor 创建时使用的 mailbox 元数据并继承最近的基类声明。 / Reads Actor mailbox metadata and inherits the nearest base-class declaration. */
export function getActorOptions(ctor: Function): ActorOptions | undefined {
  let current: Function | null = ctor;
  while (current && current !== Function.prototype) {
    const options = actorOptions.get(current);
    if (options) return options;
    current = Object.getPrototypeOf(current) as Function | null;
  }
  return undefined;
}

/** 判断Component类型是否显式参加迁移。 / Reports whether a Component type explicitly participates in transfer. */
export function isTransferableComponent(ctor: Function): boolean {
  return transferableComponents.has(ctor);
}

/** 返回候选 System 必须直接提供的方法名。 / Returns method names that a candidate System must provide directly. */
export function getRequiredLifecycleMethods(ctor: Function): readonly string[] {
  const options = lifecycleOptions.get(ctor);
  const methods: string[] = [];
  if (options?.awake) methods.push("Awake");
  if (options?.destroy) methods.push("OnDestroy");
  if (options?.deserialize) methods.push("Deserialize");
  return methods;
}

/** 返回迁移声明要求的同步方法名。 / Returns synchronous method names required by the transfer declaration. */
export function getRequiredTransferMethods(ctor: Function): readonly string[] {
  return transferableComponents.has(ctor)
    ? ["CaptureTransfer", "RestoreTransfer"]
    : [];
}
