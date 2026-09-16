import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";

/** 内容快照忽略 mtime 和临时文件；不跟随链接读取工作区外源码。 / Content snapshots ignore mtime and temporary files and never follow source links outside the workspace. */
export async function sourceFingerprint(targets) {
  const hash = createHash("sha256");
  for (const target of targets) {
    hash.update(JSON.stringify(target));
    await visit(target.source, target);
  }
  return hash.digest("hex");
  async function visit(file, target) {
    const info = await lstat(file).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!info) { hash.update(`missing:${file}\0`); return; }
    if (info.isSymbolicLink()) { hash.update(`link:${file}:${await readlink(file)}\0`); return; }
    if (info.isFile()) {
      if (target.extensions && !target.extensions.some(extension => file.endsWith(extension))) return;
      hash.update(`file:${file}\0`);
      hash.update(await readFile(file)); hash.update("\0");
    } else if (info.isDirectory()) {
      const items = (await readdir(file, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name, "en"));
      for (const item of items) {
        if (target.listingOnly) hash.update(`${item.name}:${item.isDirectory() ? "directory" : item.isSymbolicLink() ? "link" : "file"}\0`);
        else if (target.recursive || !item.isDirectory()) await visit(path.join(file, item.name), target);
      }
    }
  }
}

/** 防抖确认稳定源码变化，候选发布可等待待决检查；关闭时解除等待。 / Debounce stable source checks, let publication await pending checks, and release waiters on close. */
export async function createSourceChangeGuard(targets, onChange, onError, debounceMs = 250) {
  const baseline = await sourceFingerprint(targets);
  let timer;
  let pending;
  let resolvePending;
  let generation = 0;
  let closed = false;
  let checking = false;
  let lastSource;
  const settle = () => { resolvePending?.(); resolvePending = undefined; pending = undefined; };
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(check, debounceMs);
  }
  async function check() {
    if (closed || checking) return;
    checking = true;
    const currentGeneration = generation;
    try {
      const current = await sourceFingerprint(targets);
      if (closed) return;
      if (currentGeneration !== generation) { schedule(); return; }
      if (current !== baseline) onChange(lastSource);
      settle();
    } catch (error) {
      if (!closed && currentGeneration !== generation) { schedule(); return; }
      if (!closed) onError(error);
      settle();
    } finally { checking = false; }
  }
  return {
    notify(source) {
      if (closed) return;
      generation++; lastSource = source;
      if (!pending) pending = new Promise(resolve => { resolvePending = resolve; });
      schedule();
    },
    ready: () => pending ?? Promise.resolve(),
    close() { closed = true; clearTimeout(timer); settle(); },
  };
}
