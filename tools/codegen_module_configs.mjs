import { spawnSync } from "node:child_process";
import path from "node:path";
import { loadGameModuleCatalog } from "./game_module_catalog.mjs";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const index = args.indexOf("--modules-dir");
const catalog = await loadGameModuleCatalog({
  projectRoot: root,
  modulesDirectory: path.resolve(root, index >= 0 ? args[index + 1] : process.env.TIANGZ_MODULES_DIR ?? "modules"),
});
for (const module of catalog.modules.filter((module) => module.gameConfig)) {
  const result = spawnSync(process.execPath, ["tools/codegen_module_game_config.mjs", "--module-root", module.root,
    ...(args.includes("--check") ? ["--check"] : [])], { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`module config generation failed: ${module.id}`);
}
process.stdout.write("module config generation complete\n");
