import { HotfixSystem } from "../hotReload/HotfixSystem";

type GameModuleModelType = abstract new (...args: any[]) => object;

export interface GameModuleDefinition<
  TModelExports extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  readonly id: string;
  readonly version: string;
  readonly modelExports?: TModelExports;
  readonly requiredSystems?: readonly GameModuleModelType[];
}

export interface GameModuleIdentity {
  readonly id: string;
  readonly version: string;
}

interface RegisteredGameModule {
  readonly identity: GameModuleIdentity;
  readonly modelExports: Readonly<Record<string, unknown>>;
  readonly requiredSystems: readonly GameModuleModelType[];
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
  for (const value of Object.values(modelExports)) collectModelObjects(value, visited, modelObjects);
  for (const value of modelObjects) Object.freeze(value);

  registeredModules.push({
    identity: Object.freeze({ id: definition.id, version: definition.version }),
    modelExports: Object.freeze(modelExports),
    requiredSystems: Object.freeze(requiredSystems),
  });
}

/** 仅供构建生成的Model组合入口封闭模块图；业务代码不得调用。 / Seals the module graph from the generated Model composition entry only. */
export function sealGameModules(expected: readonly GameModuleIdentity[]): void {
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
  Object.freeze(exportsByModule);
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

function copyModelExports(value: unknown, moduleId: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`game module modelExports must be a plain object: ${moduleId}`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`game module modelExports must be a plain object: ${moduleId}`);
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const name of Reflect.ownKeys(value)) {
    if (typeof name !== "string" || !EXPORT_NAME.test(name)) {
      throw new Error(`invalid game module export: ${moduleId}:${String(name)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`game module exports must be enumerable data properties: ${moduleId}:${name}`);
    }
    if (descriptor.value === undefined) {
      throw new Error(`undefined game module export: ${moduleId}:${name}`);
    }
    result[name] = descriptor.value;
  }
  return result;
}

function collectModelObjects(value: unknown, visited: WeakSet<object>, result: object[]): void {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  if (typeof value === "function") return;
  if (visited.has(value)) return;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    throw new Error("game module Model exports must be constructors, primitives, arrays, or plain objects");
  }
  visited.add(value);
  result.push(value);
  for (const name of Reflect.ownKeys(value)) {
    if (typeof name !== "string") {
      throw new Error("game module Model export values must not contain symbol properties");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !("value" in descriptor)) {
      throw new Error("game module Model export values must contain data properties only");
    }
    collectModelObjects(descriptor.value, visited, result);
  }
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
