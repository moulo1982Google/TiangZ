import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";

/** 记录检查实际选择的源字节与解析包，不把版本号/清单图当源码身份。 / Record selected source bytes and resolved packages separately from manifest versions. */
export async function gameProjectCheckIdentity(engine, catalog) {
  const dependencies = [];
  for (const name of ["@tiangz/developer-tools-core", "@tiangz/native-language-core", "typescript", "esbuild"]) {
    const directory = path.join(engine, "node_modules", name);
    const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    dependencies.push({ name, version: manifest.version, root: await realpath(directory),
      ...await snapshot(directory, [directory]) });
  }
  const modules = [];
  for (const module of catalog.modules) {
    const declared = [...(module.entries?.modelRealRoots ?? []), ...(module.entries?.hotfixRealRoots ?? []),
      ...(module.publicApi ? [module.publicApi.file] : []), ...(module.protocol ? [module.protocol.source] : []),
      ...(module.native ? [module.native.source, path.join(module.native.crate, "src"), path.join(module.native.crate, "Cargo.toml")] : []),
      ...(module.gameConfig ? [path.dirname(module.gameConfig.project), module.gameConfig.generatedCode] : [])];
    const excluded = new Set(["node_modules", "target", "dist", "temp", ".git",
      ...(module.native ? [path.relative(module.realRoot, path.join(module.native.crate, "target")).replaceAll(path.sep, "/")] : [])]);
    modules.push({ id: module.id, version: module.version,
      ...await snapshot(module.realRoot, [module.realRoot], excluded, declared) });
  }
  return { engineVersion: catalog.engineVersion, graphHash: catalog.graphHash, dependencies, modules, hasNative: catalog.modules.some(module => module.native),
    engine: await snapshot(engine, [path.join(engine, "app"), path.join(engine, "tools"), path.join(engine, "src"),
      ...["build.rs", "rust-toolchain.toml", "package.json", "package-lock.json", "Cargo.toml", "Cargo.lock", "tsconfig.json", "codegen.manifest.json"].map(file => path.join(engine, file))]),
    sourceScope: "engine app/tools/src/build/manifests; selected module roots with only explicit cache paths excluded and declared roots taking priority; resolved package files and internal link bindings included" };
}

/** 按逻辑相对路径及逐文件 SHA 计算快照；只读取，不生成或修改输入。 / Hash relative paths and file digests without writing inputs. */
async function snapshot(root, inputs, excluded = new Set(), declared = []) {
  const files = new Set(), directories = new Set();
  const links = new Map();
  const base = await realpath(root);
  // 声明源码根优先：同名 dist/temp 不能被当作构建缓存遗漏。 / Declared roots take priority over cache names.
  for (const input of declared) await collect(input, true);
  for (const input of inputs) await collect(input, false);
  const hash = createHash("sha256");
  for (const [name, target] of [...links].sort(([left], [right]) => left.localeCompare(right))) hash.update(`link\0${name}\0${target}\0`);
  for (const file of [...files].sort()) {
    hash.update(path.relative(base, file).replaceAll(path.sep, "/") + "\0");
    hash.update(await hashFile(file));
    hash.update("\0");
  }
  return { sourceSha256: hash.digest("hex"), fileCount: files.size, links: Object.fromEntries([...links].sort()) };
  async function collect(input, declaredRoot) {
    const logical = path.relative(base, input).replaceAll(path.sep, "/");
    if (!declaredRoot && excluded.has(logical)) return;
    const original = await lstat(input), resolved = await realpath(input);
    const relative = path.relative(base, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error(`check identity source link escapes its selected root: ${input}`);
    if (original.isSymbolicLink()) {
      await readlink(input); // 仅确认实际链接，不调用输入对象方法。 / Confirm the filesystem link itself.
      links.set(logical, relative.replaceAll(path.sep, "/"));
    }
    const details = original.isSymbolicLink() ? await stat(resolved) : original;
    if (details.isFile()) { files.add(resolved); return; }
    if (!details.isDirectory() || directories.has(resolved)) return;
    directories.add(resolved);
    for (const entry of await readdir(resolved, { withFileTypes: true })) {
      await collect(path.join(resolved, entry.name), declaredRoot);
    }
  }
}

async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}
