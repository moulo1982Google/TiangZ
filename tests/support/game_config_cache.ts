import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";

interface CacheStamp {
  version: number;
  inputs: string;
  outputs: string;
}

/** 调用方持有生成锁；只有输入与完整输出内容均未变才复用结果。 / The caller holds the generation lock; results are reused only when inputs and complete outputs are unchanged. */
export async function ensureGameConfig(
  root: string,
  generate: () => void | Promise<void>,
): Promise<"cached" | "generated"> {
  const cacheFile = path.join(root, "temp", "vitest-game-config-cache.json");
  const inputs = await inputFingerprint(root);
  const previous = await readStamp(cacheFile);
  if (previous?.version === 1 && previous.inputs === inputs &&
      previous.outputs === await outputFingerprint(root)) return "cached";

  // 先使旧缓存失效；失败或中断的生成不能留下可复用的成功标记。 / Invalidate first so failed or interrupted generation cannot leave a reusable success stamp.
  await unlink(cacheFile).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await generate();
  if (await inputFingerprint(root) !== inputs) {
    throw new Error("game config inputs changed during generation; rerun the test");
  }
  await writeFile(cacheFile, JSON.stringify({
    version: 1, inputs, outputs: await outputFingerprint(root),
  } satisfies CacheStamp));
  return "generated";
}

async function readStamp(file: string): Promise<CacheStamp | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as CacheStamp;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function inputFingerprint(root: string): Promise<string> {
  return fingerprint(root, [
    "tests/support/game_config_cache.ts",
    "tools/codegen_game_config.mjs",
    "tools/codegen_manifest.mjs",
    ...await filesUnder(root, "game_config", [".conf", ".xml", ".xlsx"]),
    ...await filesUnder(root, "tools/third_party/luban/4.10.2"),
  ]);
}

async function outputFingerprint(root: string): Promise<string> {
  return fingerprint(root, [
    ...await filesUnder(root, "game_config/generated"),
    ...await filesUnder(root, "app/generated/model/config"),
    ...await filesUnder(root, "client_sdk/typescript/Generated/Config"),
  ]);
}

async function filesUnder(root: string, relative: string, extensions?: readonly string[]): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path.join(root, relative), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const file = `${relative}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await filesUnder(root, file, extensions));
    else if (entry.isFile() && (!extensions || extensions.includes(path.extname(file).toLowerCase()))) files.push(file);
  }
  return files;
}

async function fingerprint(root: string, files: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const file of [...files].sort()) {
    const content = await readFile(path.join(root, file));
    hash.update(JSON.stringify([file, content.length])).update(content);
  }
  return hash.digest("hex");
}
