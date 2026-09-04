import { isPromiseLike } from "../async";
import { HotfixBindingStore } from "../hotReload/HotfixSystem";
import { CoreLogger } from "../logging/Logger";
import { Entity } from "../runtime/entities";

type EntityClass<TEntity extends Entity> = abstract new (...args: any[]) => TEntity;

export interface EntityExtensionHandler<TEntity extends Entity> {
  Attach(entity: TEntity): void;
}

export interface EntityExtensionHandlerOptions {
  /** 跨Hotfix generation稳定且在同一目标类型内唯一的扩展ID。 / Stable extension ID across Hotfix generations, unique within one target type. */
  readonly id: string;
  /** 数值越小越先装配；相同顺序按ID排序。 / Lower values attach first; equal values are ordered by ID. */
  readonly order?: number;
}

export interface EntityExtensionApplyResult {
  readonly handlerCount: number;
}

interface AnyEntityExtensionBinding {
  readonly target: EntityClass<Entity>;
  readonly handler: new () => EntityExtensionHandler<Entity>;
  readonly id: string;
  readonly order: number;
  readonly targetId: number;
}

const bindings = new HotfixBindingStore<AnyEntityExtensionBinding>("entity-extension");
const handlerInstances = new WeakMap<Function, object>();
const targetIds = new WeakMap<Function, number>();
const applying = new WeakSet<Entity>();
const applied = new WeakSet<Entity>();
let nextTargetId = 1;

/**
 * 为一个稳定Model Entity类型登记同步装配器。装配器只能在Entity工厂尚未发布实例时调用，失败时工厂必须销毁
 * 整个Entity；它不能启动异步工作，也不能成为第二套生命周期。
 *
 * Registers a synchronous composer for one stable Model Entity type. Apply it
 * only inside an Entity factory before publication, and destroy the complete
 * Entity if it fails. It cannot start asynchronous work or become a second
 * lifecycle system.
 */
export function entityExtensionHandler<TEntity extends Entity>(
  target: EntityClass<TEntity>,
  options: EntityExtensionHandlerOptions,
): (
  handler: new () => EntityExtensionHandler<TEntity>,
) => void {
  if (
    typeof target !== "function" ||
    (target !== Entity && !(target.prototype instanceof Entity))
  ) {
    throw new Error("entity extension target must extend Entity");
  }
  const normalized = normalizeOptions(options);
  const targetId = idOf(target);
  return (handler) => {
    bindings.Register(`${targetId}:${normalized.id}`, {
      target: target as EntityClass<Entity>,
      handler: handler as new () => EntityExtensionHandler<Entity>,
      targetId,
      ...normalized,
    });
  };
}

/**
 * 在发布前对一个Entity执行全部匹配扩展，且每个实例只允许成功执行一次。调用方负责把失败纳入自己的工厂
 * 回滚；Core不会保留模块级可变业务状态。
 *
 * Applies all matching extensions before publication and permits one successful
 * application per Entity instance. The caller includes failures in its factory
 * rollback; Core retains no module-level mutable business state.
 */
export function applyEntityExtensions(entity: Entity): EntityExtensionApplyResult {
  if (!(entity instanceof Entity)) throw new Error("entity extension target must be an Entity");
  entity.AssertAlive();
  if (applied.has(entity)) {
    throw new Error(`entity extensions are already applied: ${entity.constructor.name}`);
  }
  if (applying.has(entity)) {
    throw new Error(`recursive entity extension application: ${entity.constructor.name}`);
  }

  applying.add(entity);
  try {
    const matches = bindings.Values()
      .filter((binding) => entity instanceof binding.target)
      .sort((left, right) =>
        left.order - right.order ||
        left.id.localeCompare(right.id, "en") ||
        left.targetId - right.targetId
      );
    for (const binding of matches) {
      const handler = getHandler(binding.handler);
      const result = handler.Attach(entity) as unknown;
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch((error) => {
          CoreLogger.error("async entity extension failed", {
            entity: entity.constructor.name,
            extension: binding.id,
            error,
          });
        });
        throw new Error(
          `entity extension must be synchronous: ${binding.handler.name}.Attach`,
        );
      }
    }
    applied.add(entity);
    return { handlerCount: matches.length };
  } finally {
    applying.delete(entity);
  }
}

function getHandler(
  ctor: new () => EntityExtensionHandler<Entity>,
): EntityExtensionHandler<Entity> {
  let instance = handlerInstances.get(ctor) as EntityExtensionHandler<Entity> | undefined;
  if (!instance) {
    instance = new ctor();
    handlerInstances.set(ctor, instance);
  }
  return instance;
}

function idOf(target: Function): number {
  let id = targetIds.get(target);
  if (id !== undefined) return id;
  id = nextTargetId;
  nextTargetId += 1;
  targetIds.set(target, id);
  return id;
}

function normalizeOptions(options: EntityExtensionHandlerOptions): {
  readonly id: string;
  readonly order: number;
} {
  if (!options || typeof options !== "object") {
    throw new Error("entity extension options must be an object");
  }
  const id = options.id?.trim();
  if (!id) throw new Error("entity extension id must not be empty");
  const order = options.order ?? 0;
  if (!Number.isSafeInteger(order)) {
    throw new Error(`entity extension order must be a safe integer: ${order}`);
  }
  return { id, order };
}
