import type { EntrySceneCtor } from "./types";

const sceneTypes = new Map<string, EntrySceneCtor>();

export function entryScene(target: Function): void;
export function entryScene(sceneType?: string): ClassDecorator;
export function entryScene(arg?: string | Function): ClassDecorator | void {
  if (typeof arg === "function") {
    registerScene(defaultSceneType(arg.name), arg);
    return;
  }

  return (target) => {
    registerScene(arg ?? defaultSceneType(target.name), target);
  };
}

export function getEntrySceneCtor(sceneType: string): EntrySceneCtor | undefined {
  return sceneTypes.get(sceneType);
}

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
