import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { loadGameModuleCatalog } from "./game_module_catalog.mjs";
import { resolveHostProfile } from "./host_profile.mjs";
import { runModuleCompiler } from "./module_typecheck.mjs";
const root = path.resolve(import.meta.dirname, "..");
let modulesOnly;
let catalog;
const json = process.argv.includes("--json");
const contractWarnings = [];
try {
  modulesOnly = resolveHostProfile() === "modules";
  const modulesArgument = argumentValue("--modules-dir") ?? process.env.TIANGZ_MODULES_DIR;
  catalog = await loadGameModuleCatalog({
    projectRoot: root,
    modulesDirectory: modulesArgument
      ? path.resolve(root, modulesArgument)
      : path.join(root, "modules"),
  });

  for (const module of catalog.modules) {
    const project = path.join(module.root, "tsconfig.json");
    const details = await lstat(project).catch((error) => {
      throw new Error(`game module ${module.id} is missing tsconfig.json: ${project}`, {
        cause: error,
      });
    });
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new Error(`game module ${module.id} tsconfig.json must be a regular file`);
    }
    const realProject = await realpath(project);
    if (!isWithin(module.realRoot, realProject)) {
      throw new Error(`game module ${module.id} tsconfig.json escapes the module root`);
    }
    runModuleCompiler({ project, moduleId: module.id, root, catalog, modulesOnly, json, contractWarnings });
  }

  process.stdout.write(json ? `${JSON.stringify({ formatVersion: 1, ok: true, modules: catalog.modules.map(module => module.id), diagnostics: contractWarnings })}\n` : `game module typecheck passed: modules=${catalog.modules.length}\n`);
} catch (error) {
  if (json) process.stdout.write(`${JSON.stringify({ formatVersion: 1, ok: false, diagnostics: error.diagnostics ?? [{ code: "tiangz.module.typecheck", message: error.message }] })}\n`);
  else process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function argumentValue(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
