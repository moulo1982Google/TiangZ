import type { EntrySceneCtor } from "./types";

const sceneTypes = new Map<string, EntrySceneCtor>();

export function entryScene(target: Function): void;
export function entryScene(sceneType?: string): ClassDecorator;
/** 按显式类型或 `FooScene -> Foo` 类名规则注册 EntryScene。 / Registers an EntryScene under an explicit type or its `FooScene -> Foo` class name. */
export function entryScene(arg?: string | Function): ClassDecorator | void {
  if (typeof arg === "function") {
    registerScene(defaultSceneType(arg.name), arg);
    return;
  }

  return (target) => {
    registerScene(arg ?? defaultSceneType(target.name), target);
  };
}

/** 解析已注册的 Scene 构造器，但不创建实例。 / Resolves a registered Scene constructor without instantiating it. */
export function getEntrySceneCtor(sceneType: string): EntrySceneCtor | undefined {
  return sceneTypes.get(sceneType);
}

/** 列出已注册类型供启动校验和工具使用，不承担服务发现。 / Lists registered types for startup validation and tooling, not service discovery. */
export function listEntrySceneTypes(): string[] {
  return [...sceneTypes.keys()];
}

function defaultSceneType(className: string): string {
  return className.endsWith("Scene") ? className.slice(0, -"Scene".length) : className;
}

function registerScene(sceneType: string, target: Function): void {
  if (!sceneType) throw new Error(`scene type is empty for ${target.name}`);
  if (sceneTypes.has(sceneType)) throw new Error(`duplicate scene type: ${sceneType}`);
  sceneTypes.set(sceneType, target as unknown as EntrySceneCtor);
}
