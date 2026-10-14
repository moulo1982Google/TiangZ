import { HotfixSystem } from "../hotReload/HotfixSystem";
import type { ProcessConfig } from "../process/types";

type GameModuleModelType = abstract new (...args: any[]) => object;

export interface GameModuleDefinition<
  TModelExports extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  readonly id: string;
  readonly version: string;
  readonly modelExports?: TModelExports;
  readonly requiredSystems?: readonly GameModuleModelType[];
  readonly processServices?: {
    readonly configure: (config: ProcessConfig) => void;
    readonly takeMetrics: () => Readonly<Record<string, object>>;
  };
}

export interface GameModuleIdentity {
  readonly id: string;
  readonly version: string;
}

interface RegisteredGameModule {
  readonly identity: GameModuleIdentity;
  readonly modelExports: Readonly<Record<string, unknown>>;
  readonly requiredSystems: readonly GameModuleModelType[];
  readonly processServices?: GameModuleDefinition["processServices"];
}

const MODULE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$/;
const EXPORT_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const registeredModules: RegisteredGameModule[] = [];
let sealed = false;

/**
 * 在不可变Model装载期登记一个外置游戏模块。模块只能贡献显式Model导出和必需
 * System类型；运行状态仍必须归属于Scene、Entity或Component。
 *
 * Registers an external game module while the immutable Model is loading. A
 * module may contribute explicit Model exports and required System types only;
 * runtime state must still belong to a Scene, Entity, or Component.
 */
export function defineGameModule<
  TModelExports extends Readonly<Record<string, unknown>>,
>(definition: GameModuleDefinition<TModelExports>): void {
  if (sealed) throw new Error(`game module registration is sealed: ${definition.id}`);
  validateIdentity(definition);
  if (registeredModules.some((module) => module.identity.id === definition.id)) {
    throw new Error(`duplicate game module registration: ${definition.id}`);
  }
  if (definition.processServices) {
    for (const name of ["configure", "takeMetrics"] as const) {
      const method = definition.processServices[name];
      if (typeof method !== "function" || method.constructor.name === "AsyncFunction") {
        throw new Error(`module process service must be synchronous: ${definition.id}:${name}`);
      }
    }
  }

  const modelExports = copyModelExports(definition.modelExports ?? {}, definition.id);
  const requiredSystems = [...(definition.requiredSystems ?? [])];
  if (new Set(requiredSystems).size !== requiredSystems.length) {
    throw new Error(`duplicate required System in game module: ${definition.id}`);
  }
  const exportedValues = new Set(Object.values(modelExports));
  for (const target of requiredSystems) {
    if (typeof target !== "function") {
      throw new Error(`invalid required System target in game module: ${definition.id}`);
    }
    if (!exportedValues.has(target)) {
      throw new Error(
        `required System target must be a modelExports value: ${definition.id}:${target.name}`,
      );
    }
  }
  const modelObjects: object[] = [];
  const visited = new WeakSet<object>();
  for (const [name, value] of Object.entries(modelExports)) {
    collectModelObjects(value, visited, modelObjects, definition.id, exportPropertyPath("modelExports", name));
  }
  for (const value of modelObjects) Object.freeze(value);

  registeredModules.push({
    identity: Object.freeze({ id: definition.id, version: definition.version }),
    modelExports: Object.freeze(modelExports),
    requiredSystems: Object.freeze(requiredSystems),
    processServices: definition.processServices ? Object.freeze({ ...definition.processServices }) : undefined,
  });
}

/** 在 Process 启动边界同步配置模块服务，不创建或替代 Scene 生命周期。 / Configures module services synchronously at Process startup without replacing Scene lifecycles. */
export function configureGameModuleServices(config: ProcessConfig): void {
  if (!sealed) throw new Error("module services require a sealed module graph");
  for (const module of registeredModules) {
    const result: unknown = module.processServices?.configure(config);
    if (result !== undefined) throw new Error(`module process configure must return void synchronously: ${module.identity.id}`);
  }
}

/** 采样模块诊断，拒绝覆盖其他模块或宿主指标。 / Samples module diagnostics without overwriting another module or host metric. */
export function takeGameModuleMetrics(): Readonly<Record<string, object>> {
  const metrics: Record<string, object> = Object.create(null);
  const reserved = new Set(["metrics", "game", "actorMailbox", "pendingAsync", "pendingIngress"]);
  for (const module of registeredModules) {
    const sample = module.processServices?.takeMetrics();
    if (!sample) continue;
    if (typeof sample !== "object" || "then" in sample || Array.isArray(sample)) throw new Error(`invalid module metric sample: ${module.identity.id}`);
    for (const [key, value] of Object.entries(sample)) {
      if (reserved.has(key) || Object.hasOwn(metrics, key)) throw new Error(`duplicate or reserved module metric: ${module.identity.id}:${key}`);
      if (!value || typeof value !== "object" || "then" in value) throw new Error(`invalid module metric: ${module.identity.id}:${key}`);
      metrics[key] = value;
    }
  }
  return metrics;
}

/** 仅供构建生成的Model组合入口封闭模块图；业务代码不得调用。 / Seals the module graph from the generated Model composition entry only. */
export function sealGameModules(
  expected: readonly GameModuleIdentity[],
  publicApis: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {},
): void {
  if (sealed) throw new Error("game module registration is already sealed");
  if (expected.length !== registeredModules.length) {
    throw new Error(
      `game module registration count mismatch: expected ${expected.length}, actual ${registeredModules.length}`,
    );
  }
  const exportsByModule = Object.create(null) as Record<string, Readonly<Record<string, unknown>>>;
  for (let index = 0; index < expected.length; index += 1) {
    const wanted = expected[index];
    const actual = registeredModules[index];
    if (wanted.id !== actual.identity.id || wanted.version !== actual.identity.version) {
      throw new Error(
        `game module registration mismatch at ${index}: expected ${wanted.id}@${wanted.version}, ` +
          `actual ${actual.identity.id}@${actual.identity.version}`,
      );
    }
    for (const target of actual.requiredSystems) HotfixSystem.RequireType(target);
    exportsByModule[actual.identity.id] = actual.modelExports;
  }
  const installedApis = Object.create(null) as Record<string, Readonly<Record<string, unknown>>>;
  for (const [id, exports] of Object.entries(publicApis)) {
    if (!Object.prototype.hasOwnProperty.call(exportsByModule, id)) {
      throw new Error(`public API owner is not installed: ${id}`);
    }
    // 模块命名空间转为数据属性；引用保持同一份Model身份。
    // Copy module namespaces to data properties while preserving Model identity.
    const api = copyModelExports({ ...exports }, id, "publicApi");
    const objects: object[] = [];
    const visited = new WeakSet<object>();
    for (const [name, value] of Object.entries(api)) {
      collectModelObjects(value, visited, objects, id, exportPropertyPath("publicApi", name));
    }
    for (const object of objects) Object.freeze(object);
    installedApis[id] = Object.freeze(api);
  }
  Object.freeze(exportsByModule);
  Object.defineProperty(globalThis, "__tiangzModulePublicApis", {
    value: Object.freeze(installedApis),
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(globalThis, "__tiangzModuleModelExports", {
    value: exportsByModule,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  sealed = true;
}

/** 仅供Core启动期核对数据所有者；业务模块通过公开数据包目录读取自己的资料。 / Core-only bootstrap ownership check for installed runtime data packs. */
export function hasSealedGameModule(id: string): boolean {
  if (!sealed) throw new Error("game module registration must be sealed before runtime data packs");
  return registeredModules.some((module) => module.identity.id === id);
}

function copyModelExports(value: unknown, moduleId: string, exportPath = "modelExports"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw modelExportError(`game module modelExports must be a plain object: ${moduleId}`, moduleId, exportPath);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw modelExportError(`game module modelExports must be a plain object: ${moduleId}`, moduleId, exportPath);
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const name of Reflect.ownKeys(value)) {
    if (typeof name !== "string" || !EXPORT_NAME.test(name)) {
      throw modelExportError(`invalid game module export: ${moduleId}:${String(name)}`, moduleId, exportPropertyPath(exportPath, name));
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw modelExportError(`game module exports must be enumerable data properties: ${moduleId}:${name}`, moduleId, exportPropertyPath(exportPath, name));
    }
    if (descriptor.value === undefined) {
      throw modelExportError(`undefined game module export: ${moduleId}:${name}`, moduleId, exportPropertyPath(exportPath, name));
    }
    result[name] = descriptor.value;
  }
  return result;
}

function collectModelObjects(value: unknown, visited: WeakSet<object>, result: object[], moduleId: string, exportPath: string): void {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  if (typeof value === "function") return;
  if (visited.has(value)) return;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    throw modelExportError("game module Model exports must be constructors, primitives, arrays, or plain objects", moduleId, exportPath);
  }
  visited.add(value);
  result.push(value);
  for (const name of Reflect.ownKeys(value)) {
    if (typeof name !== "string") {
      throw modelExportError("game module Model export values must not contain symbol properties", moduleId, exportPropertyPath(exportPath, name));
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !("value" in descriptor)) {
      throw modelExportError("game module Model export values must contain data properties only", moduleId, exportPropertyPath(exportPath, name));
    }
    collectModelObjects(descriptor.value, visited, result, moduleId, exportPropertyPath(exportPath, name));
  }
}

/** 给真实加载错误附稳定模块与属性路径，不读取 getter 或改变合法值判断。 / Add module and property context without invoking getters or changing validation. */
function modelExportError(message: string, moduleId: string, exportPath: string): Error {
  return Object.assign(new Error(`${message} (${moduleId}:${exportPath})`), {
    code: "tiangz.model.invalid-export", moduleId, exportPath,
  });
}

/** 路径仅使用属性名，不调用被检查对象的方法。 / Render paths from property names only, never from inspected objects. */
function exportPropertyPath(parent: string, name: string | symbol): string {
  return typeof name === "string" && EXPORT_NAME.test(name)
    ? `${parent}.${name}` : `${parent}[${JSON.stringify(String(name))}]`;
}

function validateIdentity(definition: GameModuleDefinition): void {
  if (!definition || typeof definition !== "object") {
    throw new Error("game module definition must be an object");
  }
  if (typeof definition.id !== "string" || !MODULE_ID.test(definition.id)) {
    throw new Error(`invalid game module id: ${String(definition.id)}`);
  }
  if (typeof definition.version !== "string" || !isSemVer(definition.version)) {
    throw new Error(`invalid game module version: ${definition.id}@${String(definition.version)}`);
  }
}

function isSemVer(value: string): boolean {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) return false;
  const prerelease = match[4]?.split(".") ?? [];
  const build = match[5]?.split(".") ?? [];
  return prerelease.every((item) => {
    if (!/^[0-9A-Za-z-]+$/.test(item)) return false;
    return !/^\d+$/.test(item) || item === "0" || !item.startsWith("0");
  }) && build.every((item) => /^[0-9A-Za-z-]+$/.test(item));
}
