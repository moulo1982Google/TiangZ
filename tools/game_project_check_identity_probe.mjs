import { gameProjectCheckIdentity } from "./game_project_check_identity.mjs";
import { loadGameModuleCatalog } from "./game_module_catalog.mjs";
import path from "node:path";

const engine = path.resolve(import.meta.dirname, "..");
try {
  const catalog = await loadGameModuleCatalog({ projectRoot: engine, modulesDirectory: process.argv[2] });
  const identity = await gameProjectCheckIdentity(engine, catalog);
  process.stdout.write(`${JSON.stringify({ formatVersion: 1, ok: true, identity })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ formatVersion: 1, ok: false, diagnostics: [{ message: error.message }] })}\n`);
  process.exitCode = 1;
}
