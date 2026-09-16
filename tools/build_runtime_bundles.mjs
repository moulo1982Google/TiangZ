import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

import { build } from "esbuild";
import { loadGameModuleCatalog } from "./game_module_catalog.mjs";
import { resolveModuleApi } from "./game_module_imports.mjs";
import { moduleNativeFingerprint } from "./module_native.mjs";
import { moduleHostConfig } from "./module_host_config.mjs";
import { resolveHostProfile } from "./host_profile.mjs";

const root = path.resolve(import.meta.dirname, "..");
const requestedOutputDirectory = argumentValue("--out-dir");
const requestedModulesDirectory = argumentValue("--modules-dir") ?? process.env.TIANGZ_MODULES_DIR;
const dist = path.resolve(root, requestedOutputDirectory ?? "dist");
const bench = process.argv.includes("--bench");
const debug = process.argv.includes("--debug");
const hotfixOnly = process.argv.includes("--hotfix-only");
const requestedHotfixOut = argumentValue("--hotfix-out");
const requestedHotfixEntry = argumentValue("--hotfix-entry");
const hostProfile = resolveHostProfile();
if (bench && hostProfile !== "demo") throw new Error("--bench cannot use the modules host profile");
const modulesOnly = hostProfile === "modules";
if (modulesOnly && requestedHotfixEntry) throw new Error("modules host does not accept a built-in Hotfix entry");
const buildMode = modulesOnly ? "modules" : bench ? "bench" : "demo";
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const moduleCatalog = await loadGameModuleCatalog({
  projectRoot: root,
  modulesDirectory: requestedModulesDirectory
    ? path.resolve(root, requestedModulesDirectory)
    : path.join(root, "modules"),
  engineVersion: packageJson.version,
});
const moduleProtocolLockFiles = moduleCatalog.modules
  .filter((module) => module.protocol)
  .flatMap((module) => [module.protocol.opcodeLock, module.protocol.schemaLock]);
const nativeModules = moduleCatalog.modules.filter((module) => module.native);
const nativeModuleHash = nativeModules.length ? await moduleNativeFingerprint(moduleCatalog) : "";
const gameConfigManifest = modulesOnly ? moduleHostConfig().manifest : JSON.parse(
  await readFile(path.join(root, "game_config", "generated", "game-config.manifest.json"), "utf8"),
);

if (modulesOnly) execFileSync(process.execPath, [path.join(root, "tools/typecheck_game_modules.mjs"),
  "--host-profile", "modules", "--modules-dir", moduleCatalog.directory],
  { cwd: root, stdio: "inherit", windowsHide: true });

if ((requestedHotfixOut || requestedHotfixEntry) && !hotfixOnly) {
  throw new Error("--hotfix-out and --hotfix-entry require --hotfix-only");
}

const automaticCandidate = hotfixOnly && !requestedHotfixOut;
const hotfixOutputDirectory = hotfixOnly
  ? requestedHotfixOut
    ? path.resolve(root, requestedHotfixOut)
    : path.join(dist, "hotfix-candidates", ".building")
  : dist;
const hotfixCandidateFile = path.join(hotfixOutputDirectory, "hotfix.candidate.js");
const hotfixOutputFile = path.join(hotfixOutputDirectory, "hotfix.js");
const hotfixManifestFile = path.join(hotfixOutputDirectory, "hotfix.manifest.json");
const hotfixEntry = requestedHotfixEntry
  ? path.resolve(root, requestedHotfixEntry)
  : path.join(root, bench ? "app/hotfix/main.bench.ts" : "app/hotfix/main.ts");

if (automaticCandidate) await rm(hotfixOutputDirectory, { recursive: true, force: true });
await mkdir(hotfixOutputDirectory, { recursive: true });
await rm(hotfixCandidateFile, { force: true });

const common = {
  metafile: modulesOnly,
  bundle: true,
  platform: "neutral",
  target: "es2022",
  sourcemap: debug ? "inline" : false,
  sourcesContent: debug,
  logLevel: "info",
};

const modelSourceHash = await hashModelSources();
let modelManifest;
let builtModelBytes;
if (hotfixOnly) {
  modelManifest = JSON.parse(
    await readFile(path.join(dist, "model.manifest.json"), "utf8"),
  );
  if (modelManifest.buildMode !== buildMode) {
    throw new Error(
      `cannot build ${buildMode} Hotfix against ${modelManifest.buildMode} Model`,
    );
  }
  if (modelManifest.modelSourceHash !== modelSourceHash) {
    throw new Error(
      "Model source changed; Hotfix-only build is forbidden. Build and deploy the complete pair, then restart the Process.",
    );
  }
} else {
  const result = await build({
    ...common,
    format: "esm",
    stdin: {
      contents: modelEntrySource(moduleCatalog, bench),
      resolveDir: root,
      sourcefile: "tiangz-game-module-model-entry.ts",
      loader: "ts",
    },
    outfile: path.join(dist, "model.js"),
    write: false,
    plugins: [modelModuleBoundaryPlugin(moduleCatalog)],
  });
  builtModelBytes = result.outputFiles[0].contents;
  if (modulesOnly) assertModuleHostInputs(result.metafile);
}

const hotfixBuild = await build({
  ...common,
  format: "iife",
  banner: {
    js: `var require = (specifier) => {
  if (specifier === "tiangz:model") {
    const model = globalThis.__tiangzModelExports;
    if (!model) throw new Error("immutable Model exports are not installed");
    return model;
  }
  const modulePrefix = "tiangz:module-model:";
  const apiPrefix = "tiangz:module-api:";
  if (specifier.startsWith(apiPrefix)) {
    const api = globalThis.__tiangzModulePublicApis?.[specifier.slice(apiPrefix.length)];
    if (!api) throw new Error("immutable module public API is not installed: " + specifier);
    return api;
  }
  if (specifier.startsWith(modulePrefix)) {
    const moduleId = specifier.slice(modulePrefix.length);
    const modules = globalThis.__tiangzModuleModelExports;
    const model = modules && modules[moduleId];
    if (!model) throw new Error("immutable game module Model exports are not installed: " + moduleId);
    return model;
  }
  throw new Error("unsupported Hotfix external: " + specifier);
};`,
  },
  stdin: {
    contents: hotfixEntrySource(moduleCatalog, hotfixEntry),
    resolveDir: root,
    sourcefile: "tiangz-game-module-hotfix-entry.ts",
    loader: "ts",
  },
  outfile: hotfixCandidateFile,
  plugins: [hotfixModuleBoundaryPlugin(moduleCatalog)],
});
if (modulesOnly) assertModuleHostInputs(hotfixBuild.metafile);

const modelBytes = builtModelBytes ?? await readFile(path.join(dist, "model.js"));
const hotfixBytes = await readFile(hotfixCandidateFile);
if (!hotfixOnly) {
  modelManifest = {
    formatVersion: 1,
    version: packageJson.version,
    modelFingerprint: sha256(modelBytes),
    modelSourceHash,
    protocolFingerprint: await hashFiles([
      ...(modulesOnly ? [] : [path.join(root, "proto", "opcode.lock.json"), path.join(root, "proto", "schema.lock.json")]),
      ...moduleProtocolLockFiles,
    ]),
    stableCoreApiHash: await hashFiles([
      path.join(root, "app", "core", "public-api.lock.json"),
    ]),
    nativeSchemaHash: sha256(`${modulesOnly ? "" : await hashDirectory(path.join(root, "native_data"), ".native")}:${nativeModuleHash}`),
    nativeModuleHash,
    gameConfigSchemaFingerprint: gameConfigManifest.schemaFingerprint,
    moduleConfigSchemas: Object.fromEntries(await Promise.all(moduleCatalog.modules.filter((module) => module.gameConfig).map(async (module) => [
      module.id, sha256((await readFile(path.join(module.gameConfig.generatedCode, "schema.ts"), "utf8")).replaceAll("\r\n", "\n")),
    ]))),
    moduleGraphHash: moduleCatalog.graphHash,
    modules: moduleCatalog.graph,
    buildMode,
  };
}
const hotfixManifest = {
  formatVersion: 1,
  bundleVersion: `${packageJson.version}+${sha256(hotfixBytes).slice(0, 12)}`,
  modelFingerprint: modelManifest.modelFingerprint,
  modelSourceHash: modelManifest.modelSourceHash,
  protocolFingerprint: modelManifest.protocolFingerprint,
  stableCoreApiHash: modelManifest.stableCoreApiHash,
  nativeSchemaHash: modelManifest.nativeSchemaHash,
  gameConfigSchemaFingerprint: modelManifest.gameConfigSchemaFingerprint,
  moduleGraphHash: modelManifest.moduleGraphHash,
  modules: modelManifest.modules,
  hotfixHash: sha256(hotfixBytes),
  buildMode,
};

if (!hotfixOnly) {
  await writeFile(path.join(dist, "model.js"), modelBytes);
  await writeJson(path.join(dist, "model.manifest.json"), modelManifest);
  await rm(path.join(dist, "main.js"), { force: true });
}
await writeFile(hotfixOutputFile, hotfixBytes);
await writeJson(hotfixManifestFile, hotfixManifest);
await rm(hotfixCandidateFile, { force: true });
let publishedDirectory = hotfixOutputDirectory;
if (automaticCandidate) {
  publishedDirectory = path.join(dist, "hotfix-candidates", hotfixManifest.hotfixHash.slice(0, 16));
  await rm(publishedDirectory, { recursive: true, force: true });
  await rename(hotfixOutputDirectory, publishedDirectory);
}
process.stdout.write(
  `[build:runtime] ${buildMode} modules=${moduleCatalog.modules.length} graph=${moduleCatalog.graphHash.slice(0, 12)} model=${modelManifest.modelFingerprint.slice(0, 12)} hotfix=${hotfixManifest.hotfixHash.slice(0, 12)} output=${path.relative(root, publishedDirectory).replaceAll(path.sep, "/")}\n`,
);
process.stdout.write(`[build:runtime:result] ${JSON.stringify({ formatVersion: 1, kind: hotfixOnly && automaticCandidate ? "hotfix" : "bundle", candidateDirectory: publishedDirectory, buildMode })}\n`);

function modelEntrySource(catalog, includeBench) {
  const configModules = catalog.modules.filter((module) => module.gameConfig);
  const configImports = configModules.map((module, index) =>
    `import { Tables as ModuleTables${index} } from ${JSON.stringify(importSpecifier(path.join(module.gameConfig.generatedCode, "schema.ts")))};\n` +
    `import { ModuleGameConfigSchemaFingerprint as ModuleSchema${index} } from ${JSON.stringify(importSpecifier(path.join(module.gameConfig.generatedCode, "fingerprint.ts")))};` +
    (module.gameConfig.validator ? `\nimport { validate as ModuleValidate${index} } from ${JSON.stringify(importSpecifier(module.gameConfig.validator.file))};` : "")
  ).join("\n");
  const configSchemas = configModules.map((module, index) =>
    `{ moduleId: ${JSON.stringify(module.id)}, schemaFingerprint: ModuleSchema${index}, validate: (tables, previous) => { new ModuleTables${index}((name) => { if (!Object.hasOwn(tables, name)) throw new Error("module config table missing: " + name); return tables[name]; }); ${module.gameConfig.validator ? `ModuleValidate${index}(tables, previous);` : ""} } }`
  ).join(",\n");
  const publicModules = catalog.modules.filter((module) => module.publicApi);
  const apiImports = publicModules.map((module, index) =>
    `import * as ModuleApi${index} from ${JSON.stringify(importSpecifier(module.publicApi.file))};`
  ).join("\n");
  const apiValues = publicModules.map((module, index) =>
    `${JSON.stringify(module.id)}: ModuleApi${index}`
  ).join(",");
  const imports = catalog.modules
    .map((module) => `import ${JSON.stringify(importSpecifier(module.entries.model))};`)
    .join("\n");
  const protocolModules = catalog.modules.filter((module) => module.protocol);
  const protocolImports = protocolModules
    .map((module, index) => (
      `import { AllRpcDescriptors as ModuleRpcDescriptors${index}, AllMessageDescriptors as ModuleMessageDescriptors${index} } from ${JSON.stringify(importSpecifier(path.join(module.protocol.serverOutput, "index.ts")))};`
    ))
    .join("\n");
  const protocolRegistration = protocolModules.length > 0
    ? `import { registerKnownRpcs } from "./app/core/protocol/rpc";
import { registerKnownMessages } from "./app/core/protocol/message";
${protocolImports}

${protocolModules.map((_, index) => `registerKnownRpcs(ModuleRpcDescriptors${index});\nregisterKnownMessages(ModuleMessageDescriptors${index});`).join("\n")}`
    : "";
  const expected = catalog.modules.map((module) => ({ id: module.id, version: module.version }));
  const hostEntry = modulesOnly ? `import * as CorePublic from "./app/model/public.ts";
import { installProcessBootstrap } from "./app/core/process/ProcessBootstrap.ts";
import { installEmptyHostConfig } from "./app/core/content/EmptyHostConfig.ts";
import { configureGameModuleServices, takeGameModuleMetrics } from "./app/core/modules/GameModuleSystem.ts";
installProcessBootstrap({ modelExports: CorePublic,
  configureProcess: configureGameModuleServices,
  takeMetrics: takeGameModuleMetrics,
  installGameConfig: (manifest, data) => installEmptyHostConfig(${JSON.stringify(gameConfigManifest.schemaFingerprint)}, manifest, data),
});` : `import ${JSON.stringify(includeBench ? "./app/model/main.bench.ts" : "./app/model/main.ts")};`;
  return `${protocolRegistration}${protocolRegistration ? "\n" : ""}${hostEntry}
import { sealGameModules } from "./app/core/modules/GameModuleSystem.ts";
import { ModuleConfigRegistry } from "./app/core/content/ModuleConfigRegistry.ts";
${imports}
${apiImports}
${configImports}

sealGameModules(${JSON.stringify(expected)}, {${apiValues}});
if ((globalThis.__tiangzModuleNativeFingerprint ?? "") !== ${JSON.stringify(nativeModuleHash)}) {
  throw new Error("module Native binary does not match Model; rebuild Native and restart Process");
}
ModuleConfigRegistry.__configure([${configSchemas}]);
const installHostConfig = globalThis.__etsInstallGameConfig;
globalThis.__etsInstallGameConfig = (manifestJson, dataJson) => {
  const manifest = JSON.parse(manifestJson);
  const commitModules = ModuleConfigRegistry.__prepare(JSON.parse(manifest.moduleConfigsJson ?? "[]"));
  const hostStatus = installHostConfig(manifestJson, dataJson);
  commitModules();
  return JSON.stringify({ ...JSON.parse(hostStatus), moduleConfigGeneration: ModuleConfigRegistry.Generation });
};
`;
}

function hotfixEntrySource(catalog, entry) {
  const imports = catalog.modules
    .map((module) => `import ${JSON.stringify(importSpecifier(module.entries.hotfix))};`)
    .join("\n");
  return `${modulesOnly ? "" : `import ${JSON.stringify(importSpecifier(entry))};`}
${imports}
`;
}

function modelModuleBoundaryPlugin(catalog) {
  return {
    name: "game-module-model-boundary",
    setup(buildApi) {
      installModuleApiResolver(buildApi, catalog, false);
      buildApi.onResolve({ filter: /^#tiangz\/core$/ }, () => ({
        path: path.join(root, "app", "core", "public.ts"),
      }));
      buildApi.onResolve({ filter: /^#tiangz\/domains$/ }, () => ({ path: path.join(root, "app/model/domains/public.ts") }));
      buildApi.onResolve({ filter: /^#tiangz\/model$/ }, () => ({
        path: path.join(root, modulesOnly ? "app/model/public.ts" : "app/model/public.ts"),
      }));
      buildApi.onResolve({ filter: /^#tiangz\/(?:core|model)\// }, (args) => ({
        errors: [{ text: `Game module Model must use a Stable entrypoint, not ${args.path}` }],
      }));
      buildApi.onResolve({ filter: /^#tiangz\/module(?:\/|$)/ }, (args) => ({
        errors: [{ text: `Game module Model cannot import its Hotfix bridge: ${args.path}` }],
      }));
      buildApi.onResolve({ filter: /^[^./]/ }, (args) => rejectModuleBareImport(
        catalog,
        args,
        "Model",
      ));
      buildApi.onResolve({ filter: /^\./ }, (args) => validateModuleRelativeImport(
        catalog,
        args,
        "model",
      ));
    },
  };
}

function hotfixModuleBoundaryPlugin(catalog) {
  return {
    name: "immutable-model-and-game-module-boundary",
    setup(buildApi) {
      installModuleApiResolver(buildApi, catalog, true);
      buildApi.onResolve({ filter: /^#tiangz\/model$/ }, () => ({
        path: "tiangz:model",
        external: true,
      }));
      buildApi.onResolve({ filter: /^#tiangz\/model\// }, (args) => ({
        errors: [{ text: `Hotfix must import only #tiangz/model, not ${args.path}` }],
      }));
      buildApi.onResolve({ filter: /^#tiangz\/module$/ }, (args) => {
        const owner = catalog.moduleForFile(args.importer);
        if (!owner) {
          return { errors: [{ text: "#tiangz/module is only available inside a game module Hotfix" }] };
        }
        return {
          path: `tiangz:module-model:${owner.id}`,
          external: true,
        };
      });
      buildApi.onResolve({ filter: /^#tiangz\/module\// }, (args) => ({
        errors: [{ text: `Game module Hotfix must import only #tiangz/module, not ${args.path}` }],
      }));
      buildApi.onResolve({ filter: /^#tiangz\/core(?:\/|$)/ }, (args) => ({
        errors: [{ text: `Hotfix must reach Core through #tiangz/model, not ${args.path}` }],
      }));
      buildApi.onResolve({ filter: /^[^./]/ }, (args) => rejectModuleBareImport(
        catalog,
        args,
        "Hotfix",
      ));
      buildApi.onResolve({ filter: /^\./ }, (args) => validateModuleRelativeImport(
        catalog,
        args,
        "hotfix",
      ));
    },
  };
}

function installModuleApiResolver(buildApi, catalog, hotfix) {
  buildApi.onResolve({ filter: /^#tiangz\/modules\// }, (args) => {
    try {
      const target = resolveModuleApi(catalog, catalog.moduleForFile(args.importer), args.path);
      return hotfix
        ? { path: `tiangz:module-api:${target.id}`, external: true }
        : { path: target.publicApi.file };
    } catch (error) {
      return { errors: [{ text: error.message }] };
    }
  });
}

function rejectModuleBareImport(catalog, args, layer) {
  const owner = catalog.moduleForFile(args.importer);
  if (!owner) return undefined;
  return {
    errors: [{
      text: `Game module ${owner.id} ${layer} cannot import undeclared package ${args.path}`,
    }],
  };
}

function validateModuleRelativeImport(catalog, args, layer) {
  const owner = catalog.moduleForFile(args.importer);
  if (!owner) return undefined;
  const target = path.resolve(args.resolveDir, args.path);
  if (layer === "model" && owner.gameConfig && isWithin(owner.gameConfig.generatedCode, args.importer) && isWithin(owner.gameConfig.generatedCode, target)) return undefined;
  if (
    owner.protocol &&
    [owner.protocol.serverOutput, path.join(owner.realRoot, owner.protocol.relative.serverOutput)].some(directory => isWithin(directory, args.importer)) &&
    (
      isWithin(owner.protocol.serverOutput, target) ||
      ["protocol/binary", "protocol/message", "protocol/rpc", "broadcast/index"].some(file => target.replace(/\.ts$/, "") === path.join(root, "app/core", file))
    )
  ) {
    return undefined;
  }
  const allowedRoots = layer === "model"
    ? [...owner.entries.modelRoots, ...owner.entries.modelRealRoots]
    : [...owner.entries.hotfixRoots, ...owner.entries.hotfixRealRoots];
  if (allowedRoots.some((allowed) => isWithin(allowed, target))) return undefined;
  return {
    errors: [{
      text: `Game module ${owner.id} ${layer} relative import escapes its declared ${layer}Roots: ${args.path}`,
    }],
  };
}

function importSpecifier(file) {
  const relative = path.relative(root, file).replaceAll(path.sep, "/");
  if (path.isAbsolute(relative)) return path.resolve(file).replaceAll(path.sep, "/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function assertModuleHostInputs(metafile) {
  const forbidden = Object.keys(metafile.inputs).filter(file =>
    /(?:^|\/)app\/(?:model\/mmorpg|hotfix\/mmorpg|generated\/model\/config|generated\/model\/server\/demo)\//.test(file.replaceAll("\\", "/")));
  if (forbidden.length) throw new Error(`module-only host includes built-in game content:\n${forbidden.join("\n")}`);
}

function isWithin(directory, target) {
  const relative = path.relative(path.resolve(directory), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function hashDirectory(directory, extension) {
  const files = await collect(directory, extension);
  return hashFiles(files);
}

async function hashModelSources() {
  const baseFiles = [
    ...await collect(path.join(root, "app", "core"), ".ts"),
    ...(modulesOnly ? [path.join(root, "app/model/public.ts"), ...await collect(path.join(root, "app/model/domains"), ".ts")] : [
    ...await collect(path.join(root, "app", "model"), ".ts"),
    ...await collect(path.join(root, "app", "generated", "model"), ".ts"),
    ...await collect(path.join(root, "app", "generated", "bootstrap"), ".ts"),
    ]),
    ...(modulesOnly ? [] : [...await collect(path.join(root, "native_data"), ".native"),
      path.join(root, "proto", "opcode.lock.json"), path.join(root, "proto", "schema.lock.json")]),
    path.join(root, "app", "core", "public-api.lock.json"),
  ];
  const entries = [...new Set(baseFiles)]
    .sort((left, right) => left.localeCompare(right))
    .map((file) => ({
      label: path.relative(root, file).replaceAll(path.sep, "/"),
      file,
    }));
  entries.push({ label: "game-modules/graph.json", content: moduleCatalog.canonicalGraph });
  entries.push({ label: "host-profile", content: `${buildMode}:${gameConfigManifest.schemaFingerprint}` });
  entries.push({ label: "game-modules/native-fingerprint", content: nativeModuleHash });
  for (const module of moduleCatalog.modules) {
    entries.push({
      label: `game-modules/${module.id}/${path.basename(module.manifestFile)}`,
      file: module.manifestFile,
    });
    const files = [];
    for (const sourceRoot of module.entries.modelRoots) {
      files.push(...await collectModuleSources(sourceRoot));
    }
    for (const file of [...new Set(files)].sort((left, right) => left.localeCompare(right, "en"))) {
      entries.push({
        label: `game-modules/${module.id}/${path.relative(module.root, file).replaceAll(path.sep, "/")}`,
        file,
      });
    }
    if (module.protocol) {
      entries.push({
        label: `game-modules/${module.id}/${module.protocol.relative.opcodeLock}`,
        file: module.protocol.opcodeLock,
      });
      entries.push({
        label: `game-modules/${module.id}/${module.protocol.relative.schemaLock}`,
        file: module.protocol.schemaLock,
      });
    }
    if (module.gameConfig) {
      entries.push({
        label: `game-modules/${module.id}/game-config-schema`,
        file: path.join(module.gameConfig.generatedCode, "schema.ts"),
      });
      entries.push({
        label: `game-modules/${module.id}/game-config-fingerprint`,
        file: path.join(module.gameConfig.generatedCode, "fingerprint.ts"),
      });
    }
  }
  return hashEntries(entries);
}

async function collect(directory, extension) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await collect(fullPath, extension));
    else if (entry.isFile() && entry.name.endsWith(extension)) result.push(fullPath);
  }
  return result.sort((left, right) => left.localeCompare(right));
}

async function hashFiles(files) {
  return hashEntries(files.map((file) => ({
    label: path.relative(root, file).replaceAll(path.sep, "/"),
    file,
  })));
}

async function collectModuleSources(directory) {
  const result = [];
  await visit(directory);
  return result.sort((left, right) => left.localeCompare(right, "en"));

  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if ([".git", "dist", "node_modules"].includes(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && [".json", ".ts", ".tsx"].includes(path.extname(entry.name))) {
        result.push(fullPath);
      }
    }
  }
}

async function hashEntries(entries) {
  const hash = createHash("sha256");
  for (const entry of entries.sort((left, right) => left.label.localeCompare(right.label, "en"))) {
    hash.update(entry.label);
    hash.update("\0");
    hash.update(entry.content ?? await readFile(entry.file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function argumentValue(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
