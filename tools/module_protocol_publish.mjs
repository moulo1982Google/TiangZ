import { lstat, readFile, readdir, rename, rm, mkdir } from "node:fs/promises";
import path from "node:path";

// 先比较全部目标，再发布；异常时恢复旧目录与锁。 / Compare all targets first; restore outputs and locks on failure.
export async function publishProtocolOutputs(entries, check, move = rename) {
  const changed = [];
  for (const entry of entries) {
    if (!await equalTree(entry.staged, entry.target)) changed.push(entry);
  }
  if (check) {
    if (changed.length) throw new Error(`stale module protocol outputs:\n${changed.map(e => e.target).join("\n")}`);
    return;
  }
  const completed = [];
  try {
    for (const [index, entry] of changed.entries()) {
      await mkdir(path.dirname(entry.target), { recursive: true });
      const backup = path.join(path.dirname(entry.staged), `backup-${index}`);
      const exists = await lstat(entry.target).catch(e => { if (e.code !== "ENOENT") throw e; });
      if (exists?.isSymbolicLink()) throw new Error(`generated target is a symbolic link: ${entry.target}`);
      const record = { ...entry, backup, saved: false, installed: false };
      completed.push(record);
      if (exists) { await move(entry.target, backup); record.saved = true; }
      await move(entry.staged, entry.target);
      record.installed = true;
    }
  } catch (error) {
    try {
      for (const entry of completed.reverse()) {
        if (entry.installed) await rm(entry.target, { recursive: true, force: true });
        if (entry.saved) await rename(entry.backup, entry.target);
      }
    } catch (rollbackError) {
      const failure = new AggregateError([error, rollbackError], "protocol rollback failed; staging backups preserved");
      failure.preserveStaging = true;
      throw failure;
    }
    throw error;
  }
}

async function equalTree(staged, target) {
  const expected = await lstat(staged);
  const actual = await lstat(target).catch(e => { if (e.code !== "ENOENT") throw e; });
  if (!actual) return false;
  if (actual.isSymbolicLink()) throw new Error(`generated target is a symbolic link: ${target}`);
  if (expected.isDirectory() !== actual.isDirectory()) return false;
  if (!expected.isDirectory()) return (await readFile(staged)).equals(await readFile(target));
  const names = (await readdir(staged)).sort();
  if (JSON.stringify(names) !== JSON.stringify((await readdir(target)).sort())) return false;
  for (const name of names) if (!await equalTree(path.join(staged, name), path.join(target, name))) return false;
  return true;
}
