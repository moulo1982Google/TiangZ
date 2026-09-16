import { readFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";

/** 开发工程配置不是 Runtime 配置；统一 CLI 与插件使用的路径。 / Development project paths are separate from runtime configuration. */
export async function loadGameProject(directory) {
  const root = path.resolve(directory);
  const file = path.join(root, "tiangz.project.json");
  const details = await lstat(file);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`开发工程声明必须是普通文件：${file}`);
  const data = JSON.parse(await readFile(file, "utf8"));
  const fields = new Set(["formatVersion", "engineRoot", "hostProfile", "modulesDirectory", "processConfig", "machineConfig"]);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`开发工程声明必须是 JSON 对象：${file}`);
  for (const key of Object.keys(data)) if (!fields.has(key)) throw new Error(`未知开发工程字段：${key}`);
  if (data.formatVersion !== 1 || data.hostProfile !== "modules") throw new Error("当前开发工程要求 formatVersion=1、hostProfile=modules");
  if (typeof data.engineRoot !== "string" || !data.engineRoot.trim()) throw new Error("engineRoot 必须指向 TiangZ 主工程");
  const result = { root, file, engineRoot: path.resolve(root, data.engineRoot), hostProfile: "modules" };
  const realRoot = await realpath(root);
  for (const key of ["modulesDirectory", "processConfig", "machineConfig"]) {
    const value = data[key];
    if (typeof value !== "string" || !value || path.isAbsolute(value) || /[\\:\x00]/.test(value)
      || value.split("/").some(part => !part || part === ".." || part === ".")) throw new Error(`${key} 必须是工程内的相对路径`);
    const target = path.resolve(root, value);
    const resolved = await realpath(target).catch(error => { throw new Error(`${key} 无法访问：${target}；核对 tiangz.project.json (${error.code})`); });
    const type = await lstat(resolved);
    if (key === "modulesDirectory" ? !type.isDirectory() : !type.isFile()) throw new Error(`${key} 必须指向${key === "modulesDirectory" ? "目录" : "文件"}：${target}`);
    const relative = path.relative(realRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${key} 不得通过链接逃逸工程目录`);
    result[key] = target;
  }
  if (path.basename(result.machineConfig).toLowerCase() !== "startmachine.json") throw new Error("machineConfig 必须指向 StartMachine.json");
  return result;
}
