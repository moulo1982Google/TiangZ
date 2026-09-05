import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/** 检查每个进程内自测都有Vitest入口，防止新测试被静默遗漏。 / Requires a Vitest entry for every in-process self-test so new tests cannot be silently omitted. */
export async function findMissingSelfTestWrappers(root) {
  const entries = await readdir(path.join(root, "tools"), { withFileTypes: true });
  const failures = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (!entry.isFile() || !entry.name.endsWith("_self_test.ts")) continue;
    const wrapper = `tests/legacy/${entry.name.slice(0, -3)}.test.ts`;
    try {
      if ((await stat(path.join(root, wrapper))).isFile()) continue;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    failures.push(`tools/${entry.name}: missing Vitest wrapper ${wrapper}`);
  }
  return failures;
}
