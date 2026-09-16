import path from "node:path";
import { readFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { loadGameModuleCatalog } from "./game_module_catalog.mjs";
import { moduleNativeFingerprint } from "./module_native.mjs";

/** 只解析并验证当前组合的宿主，不构建、不启动进程。 / Resolves and verifies the current composed host without building or starting it. */
export async function resolveModuleRuntimeBinary({ engineRoot, modulesDirectory, profile = "debug" }) {
  if (!["debug", "release"].includes(profile)) throw new Error("invalid runtime binary profile");
  const catalog = await loadGameModuleCatalog({ projectRoot: engineRoot, modulesDirectory });
  const name = process.platform === "win32" ? "TiangZ.exe" : "TiangZ";
  if (!catalog.modules.some(module => module.native)) {
    const binary = path.join(engineRoot, "target", profile, name); await access(binary); return binary;
  }
  const directory = path.join(engineRoot, "temp/module-native-build", catalog.graphHash);
  const manifest = JSON.parse(await readFile(path.join(directory, `${profile}.manifest.json`), "utf8"));
  const binary = path.resolve(directory, manifest.binaryPath ?? path.join("target", profile, name));
  if (!binary.startsWith(directory + path.sep) || manifest.moduleGraphHash !== catalog.graphHash
    || manifest.nativeModuleHash !== await moduleNativeFingerprint(catalog)
    || manifest.binaryHash !== createHash("sha256").update(await readFile(binary)).digest("hex")) {
    throw new Error("Module runtime binary is stale or mismatched; build the game's Native composition first");
  }
  return binary;
}
