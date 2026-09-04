import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { loadGameModuleCatalog } from "./game_module_catalog.mjs";

const root = path.resolve(import.meta.dirname, "..");
const modulesArgument = argumentValue("--modules-dir") ?? process.env.TIANGZ_MODULES_DIR;
const catalog = await loadGameModuleCatalog({
  projectRoot: root,
  modulesDirectory: modulesArgument
    ? path.resolve(root, modulesArgument)
    : path.join(root, "modules"),
});
const compiler = path.join(root, "node_modules", "typescript", "bin", "tsc");

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
  await runCompiler(project, module.id);
}

process.stdout.write(`game module typecheck passed: modules=${catalog.modules.length}\n`);

function runCompiler(project, moduleId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      compiler,
      "--project",
      project,
      "--noEmit",
      "--pretty",
      "false",
    ], {
      cwd: root,
      env: process.env,
      windowsHide: true,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`game module ${moduleId} typecheck failed with exitCode=${code ?? 1}`));
    });
  });
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
