import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

const MODULE_FILE = "tiangz.module.json";
const MODULE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$/;
const CAPABILITY_ID = /^[a-z][a-z0-9]*(?:[.:/-][a-z0-9][a-z0-9-]*)*$/;
const ENTRY_KEYS = new Set(["model", "hotfix", "modelRoots", "hotfixRoots"]);
const GAME_CONFIG_KEYS = new Set(["project", "target", "generatedCode", "generatedData", "client"]);
const PROTOCOL_KEYS = new Set([
  "source",
  "opcodeLock",
  "schemaLock",
  "serverOutput",
  "typescriptOutput",
  "godotOutput",
  "godotClassName",
]);
const TOP_LEVEL_KEYS = new Set([
  "formatVersion",
  "id",
  "version",
  "description",
  "engine",
  "dependencies",
  "capabilities",
  "entries",
  "gameConfig",
  "protocol",
  "publicApi",
  "native",
]);

/**
 * 读取、验证并按依赖顺序排列构建期游戏模块。模块目录可以是仓库内目录或显式传入
 * 的外部目录，但每个入口和源码根都必须留在自己的模块根内。
 *
 * Reads, validates, and dependency-orders build-time game modules. A module
 * root may be in-repository or explicitly external, while every entry and
 * source root must remain contained by that module root.
 */
export async function loadGameModuleCatalog({
  projectRoot,
  modulesDirectory = path.join(projectRoot, "modules"),
  engineVersion,
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedModulesDirectory = path.resolve(modulesDirectory);
  const currentEngineVersion = engineVersion ?? await readProjectVersion(resolvedProjectRoot);
  const moduleRoots = await discoverModuleRoots(resolvedModulesDirectory);
  const modules = [];
  for (const root of moduleRoots) {
    modules.push(await readModule(root, currentEngineVersion));
  }

  const byId = new Map();
  for (const module of modules) {
    const previous = byId.get(module.id);
    if (previous) {
      throw new Error(
        `duplicate game module id ${module.id}: ${previous.manifestFile} and ${module.manifestFile}`,
      );
    }
    byId.set(module.id, module);
  }
  validateDependencies(modules, byId);
  const ordered = topologicalOrder(modules, byId);
  const graph = ordered.map((module) => ({
    id: module.id,
    version: module.version,
    engine: { ...module.engine },
    dependencies: module.dependencies.map((dependency) => ({ ...dependency })),
    capabilities: [...module.capabilities],
    entries: {
      model: module.entries.modelRelative,
      hotfix: module.entries.hotfixRelative,
      modelRoots: [...module.entries.modelRootRelatives],
      hotfixRoots: [...module.entries.hotfixRootRelatives],
    },
    ...(module.gameConfig ? { gameConfig: { ...module.gameConfig.relative } } : {}),
    ...(module.protocol ? { protocol: { ...module.protocol.relative } } : {}),
    ...(module.publicApi ? { publicApi: module.publicApi.relative } : {}),
    ...(module.native ? { native: module.native.relative } : {}),
  }));
  const canonicalGraph = `${JSON.stringify({ formatVersion: 1, modules: graph })}\n`;

  return {
    directory: resolvedModulesDirectory,
    engineVersion: currentEngineVersion,
    modules: ordered,
    graph,
    canonicalGraph,
    graphHash: sha256(canonicalGraph),
    moduleForFile(file) {
      const absolute = path.resolve(file);
      return ordered.find((module) =>
        isWithin(module.root, absolute) || isWithin(module.realRoot, absolute)
      );
    },
  };
}

async function discoverModuleRoots(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const roots = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const root = path.join(directory, entry.name);
    const manifest = path.join(root, MODULE_FILE);
    try {
      const details = await stat(manifest);
      if (!details.isFile()) throw new Error(`game module manifest is not a file: ${manifest}`);
      roots.push(root);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`game module directory is missing ${MODULE_FILE}: ${root}`);
      }
      throw error;
    }
  }
  return roots;
}

async function readModule(root, engineVersion) {
  const realRoot = await realpath(root);
  const manifestFile = path.join(root, MODULE_FILE);
  const manifestDetails = await lstat(manifestFile).catch((error) => {
    throw new Error(`game module manifest does not exist: ${manifestFile}`, { cause: error });
  });
  if (manifestDetails.isSymbolicLink() || !manifestDetails.isFile()) {
    throw new Error(`game module manifest must be a regular file: ${manifestFile}`);
  }
  let value;
  try {
    value = JSON.parse(await readFile(manifestFile, "utf8"));
  } catch (error) {
    throw new Error(`failed to read game module manifest ${manifestFile}: ${error.message}`, {
      cause: error,
    });
  }
  requireObject(value, manifestFile);
  rejectUnknownKeys(value, TOP_LEVEL_KEYS, manifestFile);
  if (value.formatVersion !== 1) {
    throw new Error(`${manifestFile}: unsupported formatVersion ${String(value.formatVersion)}`);
  }
  const id = requireIdentifier(value.id, "id", MODULE_ID, manifestFile);
  const version = requireVersion(value.version, "version", manifestFile);
  if (value.description !== undefined && typeof value.description !== "string") {
    throw new Error(`${manifestFile}: description must be a string`);
  }
  const engine = requireVersionWindow(value.engine, "engine", manifestFile);
  assertVersionInWindow(engineVersion, engine, `${manifestFile}: TiangZ ${engineVersion}`);
  const dependencies = requireDependencies(value.dependencies ?? [], manifestFile);
  const capabilities = requireStringArray(value.capabilities ?? [], "capabilities", manifestFile)
    .map((capability) => requireIdentifier(capability, "capability", CAPABILITY_ID, manifestFile));
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error(`${manifestFile}: capabilities must be unique`);
  }
  requireObject(value.entries, `${manifestFile}: entries`);
  rejectUnknownKeys(value.entries, ENTRY_KEYS, `${manifestFile}: entries`);

  const modelRelative = requireSafeRelativePath(value.entries.model, "entries.model", manifestFile);
  const hotfixRelative = requireSafeRelativePath(value.entries.hotfix, "entries.hotfix", manifestFile);
  const model = path.resolve(root, modelRelative);
  const hotfix = path.resolve(root, hotfixRelative);
  await requireContainedFile(root, model, `${manifestFile}: entries.model`);
  await requireContainedFile(root, hotfix, `${manifestFile}: entries.hotfix`);

  const modelRootRelatives = value.entries.modelRoots === undefined
    ? [path.dirname(modelRelative)]
    : requirePathArray(value.entries.modelRoots, "entries.modelRoots", manifestFile);
  const hotfixRootRelatives = value.entries.hotfixRoots === undefined
    ? [path.dirname(hotfixRelative)]
    : requirePathArray(value.entries.hotfixRoots, "entries.hotfixRoots", manifestFile);
  const modelRoots = await Promise.all(
    modelRootRelatives.map((item) => requireContainedDirectory(root, item, `${manifestFile}: model root`)),
  );
  const hotfixRoots = await Promise.all(
    hotfixRootRelatives.map((item) => requireContainedDirectory(root, item, `${manifestFile}: hotfix root`)),
  );
  const [modelRealRoots, hotfixRealRoots] = await Promise.all([
    Promise.all(modelRoots.map((item) => realpath(item))),
    Promise.all(hotfixRoots.map((item) => realpath(item))),
  ]);
  const [modelRealEntry, hotfixRealEntry] = await Promise.all([realpath(model), realpath(hotfix)]);
  requireEntryInDeclaredRoots(
    model,
    modelRealEntry,
    modelRoots,
    modelRealRoots,
    `${manifestFile}: entries.model`,
  );
  requireEntryInDeclaredRoots(
    hotfix,
    hotfixRealEntry,
    hotfixRoots,
    hotfixRealRoots,
    `${manifestFile}: entries.hotfix`,
  );
  for (let modelIndex = 0; modelIndex < modelRoots.length; modelIndex += 1) {
    for (let hotfixIndex = 0; hotfixIndex < hotfixRoots.length; hotfixIndex += 1) {
      const modelRoot = modelRoots[modelIndex];
      const hotfixRoot = hotfixRoots[hotfixIndex];
      const modelRealRoot = modelRealRoots[modelIndex];
      const hotfixRealRoot = hotfixRealRoots[hotfixIndex];
      if (
        isWithin(modelRoot, hotfixRoot) ||
        isWithin(hotfixRoot, modelRoot) ||
        isWithin(modelRealRoot, hotfixRealRoot) ||
        isWithin(hotfixRealRoot, modelRealRoot)
      ) {
        throw new Error(`${manifestFile}: Model and Hotfix source roots must not overlap`);
      }
    }
  }
  await Promise.all([
    ...modelRoots.map((item) => requireSymlinkFreeSourceTree(
      root,
      item,
      `${manifestFile}: Model source tree`,
    )),
    ...hotfixRoots.map((item) => requireSymlinkFreeSourceTree(
      root,
      item,
      `${manifestFile}: Hotfix source tree`,
    )),
  ]);

  const gameConfig = value.gameConfig === undefined
    ? undefined
    : await requireGameConfig(
      root,
      value.gameConfig,
      [...modelRoots, ...hotfixRoots],
      hotfixRoots,
      manifestFile,
    );
  const protocol = value.protocol === undefined
    ? undefined
    : await requireProtocol(root, value.protocol, modelRoots, manifestFile);
  let publicApi;
  if (value.publicApi !== undefined) {
    const relative = requireSafeRelativePath(value.publicApi, "publicApi", manifestFile);
    const file = path.resolve(root, relative);
    await requireContainedFile(root, file, `${manifestFile}: publicApi`);
    if (!modelRoots.some((directory) => isWithin(directory, file)) || !file.endsWith(".ts")) {
      throw new Error(`${manifestFile}: publicApi must be a TypeScript file in Model roots`);
    }
    publicApi = { file, relative: normalizeRelative(relative) };
  }
  let native;
  if (value.native !== undefined) {
    const label = `${manifestFile}: native`;
    requireObject(value.native, label);
    rejectUnknownKeys(value.native, new Set(["source", "crate", "crateName", "generatedRust", "generatedTypeScript"]), label);
    const relative = {};
    for (const name of ["source", "crate", "generatedRust", "generatedTypeScript"]) {
      relative[name] = normalizeRelative(requireSafeRelativePath(value.native[name], `native.${name}`, manifestFile));
    }
    if (typeof value.native.crateName !== "string" || !/^[a-z][a-z0-9_-]*$/.test(value.native.crateName)) throw new Error(`${label}.crateName is invalid`);
    relative.crateName = value.native.crateName;
    native = { relative, crateName: relative.crateName };
    for (const name of ["source", "crate", "generatedRust", "generatedTypeScript"]) native[name] = path.resolve(root, relative[name]);
    await requireContainedDirectory(root, native.source, label);
    await requireContainedFile(root, path.join(native.crate, "Cargo.toml"), label);
    await requireSymlinkFreeSourceTree(root, native.source, label);
    await requireSymlinkFreeSourceTree(root, path.join(native.crate, "src"), label);
    if (!isWithin(path.join(native.crate, "src"), native.generatedRust) || native.generatedRust === path.join(native.crate, "src")) throw new Error(`${label}.generatedRust must be inside crate/src`);
    if (!modelRoots.some((directory) => isWithin(directory, native.generatedTypeScript) && directory !== native.generatedTypeScript)) throw new Error(`${label}.generatedTypeScript must be inside Model roots`);
    for (const output of [native.generatedRust, native.generatedTypeScript]) {
      if (isWithin(output, native.source) || isWithin(native.source, output)) throw new Error(`${label} output overlaps native source`);
    }
  }
  const generatedOutputs = [
    ...(protocol ? [protocol.serverOutput, protocol.typescriptOutput, protocol.godotOutput] : []),
    ...(gameConfig ? [gameConfig.generatedCode, gameConfig.generatedData,
      ...(gameConfig.client ? [gameConfig.client.generatedCode, gameConfig.client.generatedData] : [])] : []),
    ...(native ? [native.generatedRust, native.generatedTypeScript] : []),
  ];
  for (let index = 0; index < generatedOutputs.length; index++) {
    const output = generatedOutputs[index];
    await requireSafeOutput(root, output, manifestFile);
    for (const other of generatedOutputs.slice(index + 1)) {
      if (isWithin(output, other) || isWithin(other, output)) throw new Error(`${manifestFile}: generated outputs must not overlap`);
    }
  }

  return {
    root: path.resolve(root),
    realRoot,
    manifestFile,
    id,
    version,
    description: value.description ?? "",
    engine,
    dependencies,
    capabilities: capabilities.sort((left, right) => left.localeCompare(right, "en")),
    gameConfig,
    protocol,
    publicApi,
    native,
    entries: {
      model,
      hotfix,
      modelRelative: normalizeRelative(modelRelative),
      hotfixRelative: normalizeRelative(hotfixRelative),
      modelRootRelatives: modelRootRelatives.map(normalizeRelative),
      hotfixRootRelatives: hotfixRootRelatives.map(normalizeRelative),
      modelRoots,
      hotfixRoots,
      modelRealRoots,
      hotfixRealRoots,
    },
  };
}

async function requireSafeOutput(root, output, label) {
  const relative = path.relative(root, output);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label}: unsafe generated output`);
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const details = await lstat(current).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!details) break;
    if (details.isSymbolicLink() || !details.isDirectory()) throw new Error(`${label}: generated output must use regular directories: ${current}`);
  }
  try { await requireSymlinkFreeSourceTree(root, output, label); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function requireProtocol(root, value, modelRoots, manifestFile) {
  const label = `${manifestFile}: protocol`;
  requireObject(value, label);
  rejectUnknownKeys(value, PROTOCOL_KEYS, label);
  const sourceRelative = requireSafeRelativePath(
    value.source ?? "proto",
    "protocol.source",
    manifestFile,
  );
  const opcodeLockRelative = requireSafeRelativePath(
    value.opcodeLock ?? path.join(sourceRelative, "opcode.lock.json"),
    "protocol.opcodeLock",
    manifestFile,
  );
  const schemaLockRelative = requireSafeRelativePath(
    value.schemaLock ?? path.join(sourceRelative, "schema.lock.json"),
    "protocol.schemaLock",
    manifestFile,
  );
  const serverOutputRelative = requireSafeRelativePath(
    value.serverOutput ?? path.join("src", "model", "generated", "protocol"),
    "protocol.serverOutput",
    manifestFile,
  );
  const typescriptOutputRelative = requireSafeRelativePath(
    value.typescriptOutput ?? path.join("generated", "typescript"),
    "protocol.typescriptOutput",
    manifestFile,
  );
  const godotOutputRelative = requireSafeRelativePath(
    value.godotOutput ?? path.join("generated", "godot"),
    "protocol.godotOutput",
    manifestFile,
  );
  const godotClassName = value.godotClassName ?? "TiangZModuleProto";
  if (typeof godotClassName !== "string" || !/^[A-Z][A-Za-z0-9]*$/.test(godotClassName)) {
    throw new Error(`${label}.godotClassName must be a PascalCase identifier`);
  }

  const source = path.resolve(root, sourceRelative);
  const opcodeLock = path.resolve(root, opcodeLockRelative);
  const schemaLock = path.resolve(root, schemaLockRelative);
  const serverOutput = path.resolve(root, serverOutputRelative);
  const typescriptOutput = path.resolve(root, typescriptOutputRelative);
  const godotOutput = path.resolve(root, godotOutputRelative);
  await requireContainedDirectory(root, source, `${label}.source`);
  for (const [name, output] of [
    ["serverOutput", serverOutput],
    ["typescriptOutput", typescriptOutput],
    ["godotOutput", godotOutput],
  ]) {
    if (!isWithin(root, output)) throw new Error(`${label}.${name} escapes the module root`);
  }
  if (new Set([serverOutput, typescriptOutput, godotOutput]).size !== 3) {
    throw new Error(`${label} output directories must be distinct`);
  }
  if (isWithin(source, serverOutput) || isWithin(serverOutput, source)) {
    throw new Error(`${label}.serverOutput must not overlap protocol.source`);
  }
  if (isWithin(source, typescriptOutput) || isWithin(typescriptOutput, source)) {
    throw new Error(`${label}.typescriptOutput must not overlap protocol.source`);
  }
  if (isWithin(source, godotOutput) || isWithin(godotOutput, source)) {
    throw new Error(`${label}.godotOutput must not overlap protocol.source`);
  }
  for (const [name, lock] of [["opcodeLock", opcodeLock], ["schemaLock", schemaLock]]) {
    if (!isWithin(source, lock)) throw new Error(`${label}.${name} must be inside protocol.source`);
  }
  const modelOutputAllowed = modelRoots.some((directory) => isWithin(directory, serverOutput));
  if (!modelOutputAllowed) {
    throw new Error(`${label}.serverOutput must be inside a declared Model source root`);
  }
  return {
    source,
    opcodeLock,
    schemaLock,
    serverOutput,
    typescriptOutput,
    godotOutput,
    godotClassName,
    relative: {
      source: normalizeRelative(sourceRelative),
      opcodeLock: normalizeRelative(opcodeLockRelative),
      schemaLock: normalizeRelative(schemaLockRelative),
      serverOutput: normalizeRelative(serverOutputRelative),
      typescriptOutput: normalizeRelative(typescriptOutputRelative),
      godotOutput: normalizeRelative(godotOutputRelative),
      godotClassName,
    },
  };
}

async function requireGameConfig(root, value, sourceRoots, hotfixRoots, manifestFile) {
  const label = `${manifestFile}: gameConfig`;
  requireObject(value, label);
  rejectUnknownKeys(value, GAME_CONFIG_KEYS, label);
  const projectRelative = requireSafeRelativePath(value.project, "gameConfig.project", manifestFile);
  const generatedCodeRelative = requireSafeRelativePath(
    value.generatedCode,
    "gameConfig.generatedCode",
    manifestFile,
  );
  const generatedDataRelative = requireSafeRelativePath(
    value.generatedData,
    "gameConfig.generatedData",
    manifestFile,
  );
  const target = value.target ?? "server";
  if (typeof target !== "string" || !/^[a-z][a-z0-9_-]*$/.test(target)) {
    throw new Error(`${label}: target must be a lowercase identifier`);
  }
  const project = path.resolve(root, projectRelative);
  const generatedCode = path.resolve(root, generatedCodeRelative);
  const generatedData = path.resolve(root, generatedDataRelative);
  await requireContainedFile(root, project, `${label}.project`);
  for (const [name, output] of [["generatedCode", generatedCode], ["generatedData", generatedData]]) {
    if (!isWithin(root, output)) throw new Error(`${label}.${name} escapes the module root`);
  }
  const codeAllowed = hotfixRoots.some((directory) =>
    path.resolve(directory) !== generatedCode && isWithin(directory, generatedCode)
  );
  if (!codeAllowed) {
    throw new Error(`${label}.generatedCode must be inside a declared Hotfix source root`);
  }
  if (sourceRoots.some((directory) =>
    isWithin(directory, generatedData) || isWithin(generatedData, directory)
  )) {
    throw new Error(`${label}.generatedData must not overlap a declared source root`);
  }
  if (isWithin(generatedCode, generatedData) || isWithin(generatedData, generatedCode)) {
    throw new Error(`${label} generated outputs must not overlap`);
  }
  if (isWithin(generatedCode, project) || isWithin(generatedData, project)) {
    throw new Error(`${label} generated outputs must not contain the Luban project`);
  }
  let client;
  if (value.client !== undefined) {
    requireObject(value.client, `${label}.client`);
    rejectUnknownKeys(value.client, new Set(["target", "generatedCode", "generatedData"]), `${label}.client`);
    const relative = {
      target: value.client.target ?? "client",
      generatedCode: requireSafeRelativePath(value.client.generatedCode, "gameConfig.client.generatedCode", manifestFile),
      generatedData: requireSafeRelativePath(value.client.generatedData, "gameConfig.client.generatedData", manifestFile),
    };
    if (!/^[a-z][a-z0-9_-]*$/.test(relative.target)) throw new Error(`${label}.client.target is invalid`);
    client = {
      target: relative.target,
      generatedCode: path.resolve(root, relative.generatedCode),
      generatedData: path.resolve(root, relative.generatedData),
      relative,
    };
    const outputs = [generatedCode, generatedData, client.generatedCode, client.generatedData];
    for (let index = 0; index < outputs.length; index++) {
      for (const other of outputs.slice(index + 1)) {
        if (isWithin(outputs[index], other) || isWithin(other, outputs[index])) throw new Error(`${label} generated outputs must not overlap`);
      }
    }
    for (const output of [client.generatedCode, client.generatedData]) {
      if (isWithin(output, project) || sourceRoots.some((source) => isWithin(source, output) || isWithin(output, source))) {
        throw new Error(`${label}.client output overlaps source roots or Luban project`);
      }
    }
  }
  return {
    project,
    generatedCode,
    generatedData,
    target,
    client,
    relative: {
      project: normalizeRelative(projectRelative),
      target,
      generatedCode: normalizeRelative(generatedCodeRelative),
      generatedData: normalizeRelative(generatedDataRelative),
      ...(client ? { client: client.relative } : {}),
    },
  };
}

function requireDependencies(value, manifestFile) {
  if (!Array.isArray(value)) throw new Error(`${manifestFile}: dependencies must be an array`);
  const dependencies = value.map((dependency, index) => {
    const label = `${manifestFile}: dependencies[${index}]`;
    requireObject(dependency, label);
    rejectUnknownKeys(
      dependency,
      new Set(["id", "minVersion", "maxVersionExclusive"]),
      label,
    );
    return {
      id: requireIdentifier(dependency.id, "id", MODULE_ID, label),
      minVersion: requireVersion(dependency.minVersion, "minVersion", label),
      maxVersionExclusive: requireVersion(
        dependency.maxVersionExclusive,
        "maxVersionExclusive",
        label,
      ),
    };
  });
  const ids = dependencies.map((item) => item.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${manifestFile}: dependency ids must be unique`);
  }
  for (const dependency of dependencies) {
    if (compareVersions(dependency.minVersion, dependency.maxVersionExclusive) >= 0) {
      throw new Error(`${manifestFile}: dependency ${dependency.id} has an empty version window`);
    }
  }
  return dependencies.sort((left, right) => left.id.localeCompare(right.id, "en"));
}

function validateDependencies(modules, byId) {
  for (const module of modules) {
    for (const dependency of module.dependencies) {
      const installed = byId.get(dependency.id);
      if (!installed) {
        throw new Error(`game module ${module.id} requires missing module ${dependency.id}`);
      }
      assertVersionInWindow(installed.version, dependency, `game module ${module.id} dependency ${dependency.id}`);
    }
  }
}

function topologicalOrder(modules, byId) {
  const dependents = new Map(modules.map((module) => [module.id, []]));
  const indegree = new Map(modules.map((module) => [module.id, module.dependencies.length]));
  for (const module of modules) {
    for (const dependency of module.dependencies) {
      dependents.get(dependency.id).push(module.id);
    }
  }
  for (const values of dependents.values()) values.sort((left, right) => left.localeCompare(right, "en"));
  const ready = modules
    .filter((module) => indegree.get(module.id) === 0)
    .map((module) => module.id)
    .sort((left, right) => left.localeCompare(right, "en"));
  const ordered = [];
  while (ready.length > 0) {
    const id = ready.shift();
    ordered.push(byId.get(id));
    for (const dependent of dependents.get(id)) {
      const next = indegree.get(dependent) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort((left, right) => left.localeCompare(right, "en"));
      }
    }
  }
  if (ordered.length !== modules.length) {
    const cycle = modules
      .map((module) => module.id)
      .filter((id) => indegree.get(id) > 0)
      .sort((left, right) => left.localeCompare(right, "en"));
    throw new Error(`game module dependency cycle: ${cycle.join(" -> ")}`);
  }
  return ordered;
}

function requireVersionWindow(value, name, label) {
  requireObject(value, `${label}: ${name}`);
  rejectUnknownKeys(value, new Set(["minVersion", "maxVersionExclusive"]), `${label}: ${name}`);
  const result = {
    minVersion: requireVersion(value.minVersion, `${name}.minVersion`, label),
    maxVersionExclusive: requireVersion(value.maxVersionExclusive, `${name}.maxVersionExclusive`, label),
  };
  if (compareVersions(result.minVersion, result.maxVersionExclusive) >= 0) {
    throw new Error(`${label}: ${name} has an empty version window`);
  }
  return result;
}

function assertVersionInWindow(version, window, label) {
  requireVersion(version, "resolved version", label);
  if (
    compareVersions(version, window.minVersion) < 0 ||
    compareVersions(version, window.maxVersionExclusive) >= 0
  ) {
    throw new Error(
      `${label} is outside [${window.minVersion}, ${window.maxVersionExclusive})`,
    );
  }
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const key of ["major", "minor", "patch"]) {
    const compared = compareNumericIdentifiers(a[key], b[key]);
    if (compared !== 0) return compared;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return compareNumericIdentifiers(leftIdentifier, rightIdentifier);
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

function requireVersion(value, name, label) {
  if (typeof value !== "string" || !parseVersion(value)) {
    throw new Error(`${label}: ${name} must be a SemVer version`);
  }
  return value;
}

function parseVersion(value) {
  if (typeof value !== "string") return undefined;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) return undefined;
  const prerelease = match[4]?.split(".") ?? [];
  const build = match[5]?.split(".") ?? [];
  if (prerelease.some((item) => !isPrereleaseIdentifier(item))) return undefined;
  if (build.some((item) => !/^[0-9A-Za-z-]+$/.test(item))) return undefined;
  return {
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease,
  };
}

function isPrereleaseIdentifier(value) {
  if (!/^[0-9A-Za-z-]+$/.test(value)) return false;
  return !/^\d+$/.test(value) || value === "0" || !value.startsWith("0");
}

function compareNumericIdentifiers(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: expected an object`);
  }
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}: unknown field ${key}`);
  }
}

function requireIdentifier(value, name, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label}: invalid ${name} ${String(value)}`);
  }
  return value;
}

function requireStringArray(value, name, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label}: ${name} must be a string array`);
  }
  return [...value];
}

function requirePathArray(value, name, label) {
  const paths = requireStringArray(value, name, label)
    .map((item) => requireSafeRelativePath(item, name, label));
  if (paths.length === 0 || new Set(paths).size !== paths.length) {
    throw new Error(`${label}: ${name} must contain unique paths`);
  }
  return paths.sort((left, right) => left.localeCompare(right, "en"));
}

function requireSafeRelativePath(value, name, label) {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)) {
    throw new Error(`${label}: ${name} must be a relative path`);
  }
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`${label}: ${name} escapes the module root`);
  }
  return normalized;
}

async function requireContainedFile(root, file, label) {
  await requireContained(root, file, label, (details) => details.isFile(), "file");
}

async function requireContainedDirectory(root, relative, label) {
  const directory = path.resolve(root, relative);
  await requireContained(root, directory, label, (details) => details.isDirectory(), "directory");
  return directory;
}

async function requireContained(root, target, label, predicate, kind) {
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]).catch((error) => {
    throw new Error(`${label} does not exist: ${target}`, { cause: error });
  });
  if (!isWithin(realRoot, realTarget)) throw new Error(`${label} escapes the module root`);
  const details = await stat(realTarget);
  if (!predicate(details)) throw new Error(`${label} must point to a ${kind}`);
}

function requireEntryInDeclaredRoots(entry, realEntry, roots, realRoots, label) {
  const lexicalMatch = roots.some((root) => isWithin(root, entry));
  const realMatch = realRoots.some((root) => isWithin(root, realEntry));
  if (!lexicalMatch || !realMatch) {
    throw new Error(`${label} must be inside its declared source roots`);
  }
}

async function requireSymlinkFreeSourceTree(root, directory, label) {
  const relative = path.relative(path.resolve(root), path.resolve(directory));
  let current = path.resolve(root);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const details = await lstat(current);
    if (details.isSymbolicLink()) {
      throw new Error(`${label} contains a symbolic link: ${current}`);
    }
  }
  await visit(directory);

  async function visit(parent) {
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      const fullPath = path.join(parent, entry.name);
      const details = await lstat(fullPath);
      if (details.isSymbolicLink()) {
        throw new Error(`${label} contains a symbolic link: ${fullPath}`);
      }
      if (details.isDirectory()) await visit(fullPath);
    }
  }
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeRelative(value) {
  return value.replaceAll(path.sep, "/");
}

async function readProjectVersion(projectRoot) {
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  return requireVersion(packageJson.version, "package.json version", projectRoot);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
