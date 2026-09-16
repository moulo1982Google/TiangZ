import { readFile, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { loadGameModuleCatalog } from "./game_module_catalog.mjs";
import { resolveModuleApi } from "./game_module_imports.mjs";
import { resolveHostProfile } from "./host_profile.mjs";
const modulesOnly = resolveHostProfile() === "modules";

const root = path.resolve(import.meta.dirname, "..");
const index = process.argv.indexOf("--modules-dir");
const requested = process.argv.find(a => a.startsWith("--modules-dir="))?.slice(14)
  ?? (index < 0 ? process.env.TIANGZ_MODULES_DIR : process.argv[index + 1]);
if (index >= 0 && (!requested || requested.startsWith("--"))) throw new Error("--modules-dir requires a directory");
const catalog = await loadGameModuleCatalog({ projectRoot: root, modulesDirectory: path.resolve(root, requested ?? "modules") });
const check = process.argv.includes("--check");
const updates = [];
for (const module of catalog.modules) {
  const file = path.join(module.root, "tsconfig.json");
  const details = await lstat(file);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`${file}: expected a regular configuration file`);
  const original = await readFile(file, "utf8");
  let config;
  try { config = JSON.parse(original); }
  catch { throw new Error(`${file}: modules:prepare requires JSON; convert JSONC explicitly to preserve comments`); }
  const parsed = ts.parseJsonConfigFileContent(structuredClone(config), ts.sys, module.root);
  if (parsed.errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
    getCanonicalFileName: f => f, getCurrentDirectory: () => root, getNewLine: () => "\n",
  }));
  const base = parsed.options.baseUrl ?? module.root;
  const relative = target => {
    const value = path.relative(base, target).replaceAll(path.sep, "/");
    return value.startsWith(".") ? value : `./${value}`;
  };
  const originalBase = parsed.options.baseUrl ?? parsed.options.pathsBasePath ?? module.root;
  const paths = Object.fromEntries(Object.entries(parsed.options.paths ?? {})
    .filter(([name]) => !name.startsWith("#tiangz/"))
    .map(([name, targets]) => [name, targets.map(target => relative(path.resolve(originalBase, target)))]));
  paths["#tiangz/core"] = [relative(path.join(root, "app/core/public.ts"))];
  paths["#tiangz/domains"] = [relative(path.join(root, "app/model/domains/public.ts"))];
  paths["#tiangz/model"] = [relative(path.join(root, modulesOnly ? "app/model/public.ts" : "app/model/public.ts"))];
  paths["#tiangz/module"] = [relative(module.entries.model)];
  for (const dependency of module.dependencies) {
    const name = `#tiangz/modules/${dependency.id}`;
    const target = catalog.modules.find(m => m.id === dependency.id);
    if (target.publicApi) paths[name] = [relative(resolveModuleApi(catalog, module, name).publicApi.file)];
  }
  config.compilerOptions = { ...config.compilerOptions, paths };
  const declarations = path.relative(module.root, path.join(root, "app/generated/bootstrap/systems/**/*.d.ts")).replaceAll(path.sep, "/");
  const includes = config.include ?? parsed.raw.include ?? (config.files || parsed.raw.files ? [] : ["**/*"]);
  config.include = [...includes.filter(p => !p.replaceAll("\\", "/").includes("/app/generated/bootstrap/systems/")), ...(modulesOnly ? [] : [declarations])];
  const text = `${JSON.stringify(config, null, 2)}\n`;
  if (JSON.stringify(JSON.parse(original)) !== JSON.stringify(config)) updates.push({ file, text });
}
if (check && updates.length) throw new Error(`stale module editor configuration; run modules:prepare:\n${updates.map(u => u.file).join("\n")}`);
for (const update of updates) await writeFile(update.file, update.text, "utf8");
process.stdout.write(`module editor configuration ${check ? "checked" : "prepared"}: modules=${catalog.modules.length} changed=${updates.length}\n`);
