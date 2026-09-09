import { mkdir, mkdtemp, readFile, readdir, rename, rm, lstat } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import path from "node:path";

/** 完整验证或事务替换模块声明的生成目录，失败恢复所有旧目录。
 * Verifies or transactionally replaces complete declared generated directories, restoring all old directories on failure.
 */
export async function publishModuleOutputs(moduleRoot, groups, check) {
  for (const group of groups) {
    const relative = path.relative(moduleRoot, group.directory);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("generated directory escapes module root");
    for (const name of group.files.keys()) {
      if (path.basename(name) !== name || name === "." || name === "..") throw new Error("invalid generated filename");
    }
  }
  if (check) {
    for (const group of groups) {
      const names = (await readdir(group.directory)).sort();
      if (JSON.stringify(names) !== JSON.stringify([...group.files.keys()].sort())) throw new Error("stale module generated file set");
      for (const [name, content] of group.files) {
        const actual = await readFile(path.join(group.directory, name), "utf8");
        if (actual.replaceAll("\r\n", "\n") !== content.replaceAll("\r\n", "\n")) throw new Error(`stale module generated file: ${name}`);
      }
    }
    return;
  }
  const temporary = await mkdtemp(path.join(moduleRoot, ".tiangz-codegen-"));
  const installed = [];
  const backups = [];
  let cleanup = true;
  try {
    for (const [index, group] of groups.entries()) {
      const staging = path.join(temporary, String(index));
      await mkdir(staging);
      for (const [name, content] of group.files) await writeFile(path.join(staging, name), content);
    }
    for (const [index, group] of groups.entries()) {
      const backup = path.join(temporary, `backup-${index}`);
      const exists = await lstat(group.directory).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
      if (exists) {
        if (!exists.isDirectory() || exists.isSymbolicLink()) throw new Error("generated directory must be a regular directory");
        await rename(group.directory, backup);
        backups.push({ directory: group.directory, backup });
      }
      await mkdir(path.dirname(group.directory), { recursive: true });
      await rename(path.join(temporary, String(index)), group.directory);
      installed.push(group.directory);
    }
  } catch (error) {
    try {
      for (const directory of installed.reverse()) await rm(directory, { recursive: true, force: true });
      for (const entry of backups.reverse()) await rename(entry.backup, entry.directory);
    } catch (rollbackError) {
      cleanup = false;
      throw new AggregateError([error, rollbackError], `generated output rollback failed; backups preserved at ${temporary}`);
    }
    throw error;
  } finally {
    if (cleanup) await rm(temporary, { recursive: true, force: true });
  }
}
