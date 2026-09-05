import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { ensureGameConfig } from "../support/game_config_cache";

const fixtures: string[] = [];
afterEach(async () => {
  for (const root of fixtures.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "tiangz-config-cache-"));
  fixtures.push(root);
  const put = async (file: string, content: string | Uint8Array) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  };
  await mkdir(path.join(root, "temp"));
  for (const file of [
    "tests/support/game_config_cache.ts", "tools/codegen_game_config.mjs",
    "tools/codegen_manifest.mjs", "game_config/luban.conf", "game_config/schemas/test.xml",
    "tools/third_party/luban/4.10.2/Luban.dll",
  ]) await put(file, "initial");
  // 0x80与0x81解码为UTF-8文本时相同；缓存必须按原始字节区分Excel。 / 0x80 and 0x81 decode identically as UTF-8; Excel fingerprints must distinguish their raw bytes.
  await put("game_config/data/test.xlsx", Uint8Array.of(0x80));
  let generations = 0;
  const generate = async () => {
    generations++;
    await put("game_config/generated/server.json", "{}");
    await put("app/generated/model/config/schema.ts", "export {};");
    await put("client_sdk/typescript/Generated/Config/schema.ts", "export {};");
  };
  return { root, put, generate, count: () => generations };
}

test("reuses unchanged config and invalidates on source, toolchain, or output changes", async () => {
  const f = await fixture();
  expect(await ensureGameConfig(f.root, f.generate)).toBe("generated");
  expect(await ensureGameConfig(f.root, f.generate)).toBe("cached");
  expect(f.count()).toBe(1);
  for (const change of [
    () => f.put("game_config/data/test.xlsx", Uint8Array.of(0x81)),
    () => f.put("game_config/schemas/new.xml", "<new />"),
    () => rm(path.join(f.root, "game_config/schemas/new.xml")),
    () => f.put("tools/codegen_game_config.mjs", "changed"),
    () => f.put("tools/third_party/luban/4.10.2/Luban.dll", "changed"),
    () => f.put("game_config/generated/server.json", "corrupted"),
    () => rm(path.join(f.root, "game_config/generated/server.json")),
    () => rm(path.join(f.root, "app/generated/model/config/schema.ts")),
  ]) {
    const before = f.count();
    await change();
    expect(await ensureGameConfig(f.root, f.generate)).toBe("generated");
    expect(f.count()).toBe(before + 1);
    expect(await ensureGameConfig(f.root, f.generate)).toBe("cached");
  }
});

test("never caches failed generation or inputs changed during generation", async () => {
  const f = await fixture();
  await expect(ensureGameConfig(f.root, async () => {
    await f.generate();
    throw new Error("Luban failed");
  })).rejects.toThrow("Luban failed");
  expect(await ensureGameConfig(f.root, f.generate)).toBe("generated");
  await f.put("game_config/luban.conf", "changed");
  await expect(ensureGameConfig(f.root, async () => {
    await f.generate();
    await f.put("game_config/luban.conf", "changed again");
  })).rejects.toThrow("inputs changed during generation");
  await expect(readFile(path.join(f.root, "temp/vitest-game-config-cache.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await ensureGameConfig(f.root, f.generate)).toBe("generated");
});
