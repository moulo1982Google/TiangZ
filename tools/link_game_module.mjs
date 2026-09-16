import { lstat, mkdir, readFile, realpath, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { loadGameModuleCatalog } from "./game_module_catalog.mjs";

// 显式安装模块根，不覆盖已有目录，也不运行模块脚本。
// Install an explicit module root without overwriting directories or running module scripts.
const args = process.argv.slice(2);
const argument = name => { const index = args.indexOf(name); if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} is required`); return args[index + 1]; };
const source = await realpath(path.resolve(argument("--source")));
const destination = path.resolve(argument("--modules-dir"));
const name = argument("--name");
if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("--name must be a simple lower-case directory name");
const manifest = JSON.parse(await readFile(path.join(source, "tiangz.module.json"), "utf8"));
const target = path.join(destination, name);
if (source === target || source.startsWith(target + path.sep) || target.startsWith(source + path.sep)) throw new Error("module installation must not contain its source");
await mkdir(destination, { recursive: true });
const existing = await lstat(target).catch(error => { if (error.code !== "ENOENT") throw error; });
if (existing) {
  if (!existing.isSymbolicLink() || await realpath(target) !== source) throw new Error(`module installation already occupied: ${target}`);
} else {
  await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
}
try {
  await loadGameModuleCatalog({ projectRoot: path.resolve(import.meta.dirname, ".."), modulesDirectory: destination });
} catch (error) {
  // 失败只撤销本次创建且身份仍相符的安装联接，不改源模块或已有安装。
  // Roll back only our unchanged new installation link, never the source or existing installs.
  if (!existing && (await lstat(target)).isSymbolicLink() && await realpath(target) === source) await unlink(target);
  throw error;
}
console.log(`[module-link] ${manifest.id}: ${target} -> ${source}`);
