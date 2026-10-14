import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/** 生成器与检查桥共享声明模块的绑定名称，不猜测任意全局。 / Share declared Native binding names without guessing globals. */
export function moduleNativeGlobalName(moduleId) {
  return `__etsModuleNative_${createHash("sha256").update(moduleId).digest("hex")}`;
}

/** Native源码、ABI和crate声明共同决定构建身份，Hotfix不得修改。
 * Native sources, ABI and crate declarations jointly define immutable build identity.
 */
export async function moduleNativeFingerprint(catalog) {
  const hash = createHash("sha256");
  for (const module of catalog.modules.filter((item) => item.native)) {
    const files = new Set([
      ...await collectNativeFiles(module.native.source),
      ...await collectNativeFiles(path.join(module.native.crate, "src")),
      path.join(module.native.crate, "Cargo.toml"),
    ]);
    hash.update(module.id + "\0" + JSON.stringify(module.native.relative) + "\0");
    for (const file of [...files].sort()) {
      hash.update(path.relative(module.root, file).replaceAll(path.sep, "/") + "\0");
      const bytes = await readFile(file);
      hash.update(/\.(native|rs|js|toml|json|ts|txt)$/.test(file) ? bytes.toString("utf8").replaceAll("\r\n", "\n") : bytes);
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

export async function collectNativeFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`native source symlinks are forbidden: ${file}`);
    if (entry.isDirectory()) files.push(...await collectNativeFiles(file));
    else if (entry.isFile()) files.push(file);
  }
  return files.sort();
}
