const PREFIX = "#tiangz/modules/";

/** 只解析显式直接依赖的公开入口，禁止使用传递依赖或深层路径。
 * Resolves direct dependency APIs only; transitive and deep imports are rejected.
 */
export function resolveModuleApi(catalog, owner, specifier) {
  if (!specifier.startsWith(PREFIX)) return undefined;
  const id = specifier.slice(PREFIX.length);
  if (!owner || !owner.dependencies.some((dependency) => dependency.id === id)) {
    throw new Error(`module API requires a declared direct dependency: ${owner?.id ?? "host"} -> ${id}`);
  }
  const target = catalog.modules.find((module) => module.id === id);
  if (!target?.publicApi) throw new Error(`module does not declare publicApi: ${id}`);
  return target;
}
