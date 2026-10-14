import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { assertValidNativeWorkspace, toNativeCamelCase } from "@tiangz/native-language-core";
import { loadGameModuleCatalog } from "./game_module_catalog.mjs";
import { collectNativeFiles, moduleNativeGlobalName } from "./module_native.mjs";
import { modelModuleBoundaryPlugin } from "./module_model_build_support.mjs";

const root = path.resolve(import.meta.dirname, "..");
const [temporary, modulesDirectory] = process.argv.slice(2);
if (!temporary || !modulesDirectory || !path.isAbsolute(temporary) || !path.isAbsolute(modulesDirectory)) {
  throw new Error("Use the owned Model export check entry point");
}
const result = { formatVersion: 1, ok: false, status: "failed", modules: [], nativeExecutionVerified: false, diagnostics: [] };
try {
  const catalog = await loadGameModuleCatalog({ projectRoot: root, modulesDirectory });
  result.modules = catalog.modules.map(module => ({ id: module.id, version: module.version }));
  result.graphHash = catalog.graphHash;
  for (const module of catalog.modules.filter(module => module.native)) await installNativeCheckBindings(module);
  const apiModules = catalog.modules.filter(module => module.publicApi);
  const source = [
    `import { sealGameModules } from ${JSON.stringify(path.join(root, "app/core/modules/GameModuleSystem.ts"))};`,
    ...catalog.modules.map(module => `import ${JSON.stringify(module.entries.model)};`),
    ...apiModules.map((module, index) => `import * as Api${index} from ${JSON.stringify(module.publicApi.file)};`),
    `sealGameModules(${JSON.stringify(result.modules)}, {${apiModules.map((module, index) => `${JSON.stringify(module.id)}: Api${index}`).join(",")}});`,
  ].join("\n");
  const bundle = await build({ stdin: { contents: source, resolveDir: root, sourcefile: "model-export-probe.ts", loader: "ts" },
    bundle: true, platform: "node", target: "es2022", format: "esm", write: false, logLevel: "silent",
    plugins: [modelModuleBoundaryPlugin(catalog, root)] });
  const bundleFile = path.join(temporary, "model.mjs");
  await writeFile(bundleFile, bundle.outputFiles[0].contents);
  await import(pathToFileURL(bundleFile).href);
  result.ok = true;
  result.status = "passed";
} catch (error) {
  result.status = error?.code === "tiangz.model.check-unavailable" ? "unavailable" : "failed";
  result.diagnostics.push({ code: error?.code ?? "tiangz.model.load-failed", message: error?.message ?? String(error),
    ...(error?.moduleId ? { moduleId: error.moduleId } : {}), ...(error?.exportPath ? { exportPath: error.exportPath } : {}),
    ...(Array.isArray(error?.errors) ? { causes: error.errors.map(item => ({ message: item.text, location: item.location })) } : {}) });
}
await writeFile(path.join(temporary, "result.json"), `${JSON.stringify(result)}\n`);
process.exitCode = result.ok ? 0 : 1;

/** 绑定名称和方法只从所选模块声明/schema 推导；方法调用始终拒绝，不能伪造 Native 结果。 / Derive declared bindings and reject all Native calls rather than inventing results. */
async function installNativeCheckBindings(module) {
  const sources = await Promise.all((await collectNativeFiles(module.native.source)).filter(file => file.endsWith(".native"))
    .map(async uri => ({ uri, text: await readFile(uri, "utf8") })));
  const schema = assertValidNativeWorkspace(sources);
  const deny = operation => () => { throw Object.assign(new Error(`Native execution is unavailable during Model export checks: ${module.id}:${operation}`),
    { code: "tiangz.model.check-unavailable", moduleId: module.id }); };
  const operations = Object.create(null);
  for (const operation of schema.operations) operations[toNativeCamelCase(operation.name)] = deny(operation.name);
  const globalName = moduleNativeGlobalName(module.id);
  Object.defineProperty(globalThis, globalName, { value: Object.freeze(operations) });
  const workers = Object.create(null);
  for (const worker of module.native.relative.workers ?? []) workers[worker.name] = Object.freeze({
    call: deny(`${worker.name}.call`), drain: deny(`${worker.name}.drain`), stats: deny(`${worker.name}.stats`),
  });
  Object.defineProperty(globalThis, `${globalName}_workers`, { value: Object.freeze(workers) });
  if (!Object.hasOwn(globalThis, "__tiangzModuleNativeFingerprint")) {
    Object.defineProperty(globalThis, "__tiangzModuleNativeFingerprint", { value: "model-export-check-only" });
  }
}
