import path from "node:path";
import process from "node:process";

import { loadGameModuleCatalog } from "./game_module_catalog.mjs";

const root = path.resolve(import.meta.dirname, "..");
const command = process.argv[2] ?? "list";
const modulesArgument = argumentValue("--modules-dir") ?? process.env.TIANGZ_MODULES_DIR;
const catalog = await loadGameModuleCatalog({
  projectRoot: root,
  modulesDirectory: modulesArgument ? path.resolve(root, modulesArgument) : path.join(root, "modules"),
});

if (command === "validate") {
  process.stdout.write(
    `game module catalog valid: modules=${catalog.modules.length} graph=${catalog.graphHash}\n`,
  );
} else if (command === "list") {
  if (catalog.modules.length === 0) process.stdout.write("no game modules installed\n");
  for (const module of catalog.modules) {
    const dependencies = module.dependencies.map((item) => item.id).join(",") || "-";
    process.stdout.write(`${module.id}@${module.version} dependencies=${dependencies}\n`);
  }
} else if (command === "graph") {
  process.stdout.write(catalog.canonicalGraph);
} else {
  throw new Error(`unknown game module command: ${command}`);
}

function argumentValue(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
