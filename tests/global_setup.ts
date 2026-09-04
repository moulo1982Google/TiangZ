import { spawnSync } from "node:child_process";
import { mkdir, open, stat, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockFile = path.join(root, "temp", "vitest-game-config.lock");

/** 在任何测试worker启动前生成共享配置输入，避免并行用例争用生成目录。 / Generates shared configuration before any test worker starts so parallel cases never race on generated inputs. */
export default async function setup(): Promise<void> {
  await mkdir(path.dirname(lockFile), { recursive: true });
  const lock = await acquireGenerationLock();
  try {
    const result = spawnSync(process.execPath, ["tools/codegen_game_config.mjs"], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      throw result.error ?? new Error(`game config codegen failed with exit code ${result.status ?? 1}`);
    }
  } finally {
    await lock.close();
    await unlink(lockFile).catch(() => undefined);
  }
}

async function acquireGenerationLock(): Promise<FileHandle> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      return await open(lockFile, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lockStat = await stat(lockFile).catch(() => undefined);
      if (lockStat && Date.now() - lockStat.mtimeMs > 300_000) {
        await unlink(lockFile).catch(() => undefined);
        continue;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("timed out waiting for game config codegen lock");
}
