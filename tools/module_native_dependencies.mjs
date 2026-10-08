import path from "node:path";

/** Native 使用的 TiangZ 库必须属于本次宿主；不自动改写模块依赖。 / A Native TiangZ library must come from the selected host; never rewrite module dependencies. */
export function assertNativeHostIdentity(metadata, engineRoot) {
  const normalize = file => {
    const resolved = path.resolve(file);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const expected = normalize(path.join(engineRoot, "Cargo.toml"));
  const packages = new Map(metadata.packages.map(item => [item.id, item]));
  const nodes = new Map(metadata.resolve?.nodes.map(item => [item.id, item]) ?? []);
  const pending = [metadata.resolve?.root], visited = new Set();
  while (pending.length) {
    const id = pending.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    const pkg = packages.get(id), node = nodes.get(id);
    if (!pkg || !node) throw new Error("Incomplete Native host dependency metadata");
    if (pkg.name === "TiangZ" && normalize(pkg.manifest_path) !== expected) {
      throw new Error(`Native host mismatch: TiangZ library resolves ${pkg.manifest_path}, but the selected host is ${expected}. Explicitly align the module Cargo.toml dependency before rebuilding; equal version numbers do not prove source identity.`);
    }
    pending.push(...(node.deps ?? []).filter(dep => !dep.dep_kinds || dep.dep_kinds.some(kind => kind.kind === null)).map(dep => dep.pkg));
  }
}

// Native extensions must return the host's exact Rust deno_core type identity.
export function assertNativeDenoIdentity(metadata, modules) {
  const packages=new Map(metadata.packages.map(item=>[item.id,item]));
  const nodes=new Map(metadata.resolve?.nodes.map(item=>[item.id,item])??[]);
  const normalDeps=node=>(node?.deps??[]).filter(dep=>!dep.dep_kinds||dep.dep_kinds.some(kind=>kind.kind===null));
  const host=nodes.get(metadata.resolve?.root);
  const core=normalDeps(host).find(dep=>dep.name==='deno_core');
  if(!core||!packages.has(core.pkg))throw new Error('Native composition metadata is missing the host deno_core dependency');
  for(const [index,module] of modules.entries()) {
    const entry=normalDeps(host).find(dep=>dep.name===`tiangz_module_${index}`);
    if(!entry)throw new Error(`Native composition metadata is missing module ${module.id}`);
    const pending=[entry.pkg],visited=new Set();
    while(pending.length) {
      const id=pending.pop();if(visited.has(id))continue;visited.add(id);
      const pkg=packages.get(id),node=nodes.get(id);
      if(!pkg||!node)throw new Error(`Incomplete Native dependency metadata for ${module.id}`);
      if(pkg.name==='deno_core'&&id!==core.pkg) {
        throw new Error(`Native dependency mismatch: ${module.id} resolves deno_core ${pkg.version} (${id}), but the host resolves ${packages.get(core.pkg).version} (${core.pkg}). Align the module Cargo.toml with the host and resolve its composition lock before building; dependencies are not rewritten automatically.`);
      }
      pending.push(...normalDeps(node).map(dep=>dep.pkg));
    }
  }
}
