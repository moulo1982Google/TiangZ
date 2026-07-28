import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const bench = process.argv.includes("--bench");
const debug = process.argv.includes("--debug");
const hotfixOnly = process.argv.includes("--hotfix-only");
const requestedHotfixOut = argumentValue("--hotfix-out");
const requestedHotfixEntry = argumentValue("--hotfix-entry");
const buildMode = bench ? "bench" : "demo";
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const gameConfigManifest = JSON.parse(
  await readFile(path.join(root, "game_config", "generated", "game-config.manifest.json"), "utf8"),
);

if ((requestedHotfixOut || requestedHotfixEntry) && !hotfixOnly) {
  throw new Error("--hotfix-out and --hotfix-entry require --hotfix-only");
}

const automaticCandidate = hotfixOnly && !requestedHotfixOut;
const hotfixOutputDirectory = hotfixOnly
  ? path.resolve(root, requestedHotfixOut ?? "dist/hotfix-candidates/.building")
  : dist;
const hotfixCandidateFile = path.join(hotfixOutputDirectory, "hotfix.candidate.js");
const hotfixOutputFile = path.join(hotfixOutputDirectory, "hotfix.js");
const hotfixManifestFile = path.join(hotfixOutputDirectory, "hotfix.manifest.json");
const hotfixEntry = requestedHotfixEntry
  ? path.resolve(root, requestedHotfixEntry)
  : path.join(root, bench ? "app/hotfix/main.bench.ts" : "app/hotfix/main.ts");

if (!hotfixOnly) await rm(path.join(dist, "main.js"), { force: true });
if (automaticCandidate) await rm(hotfixOutputDirectory, { recursive: true, force: true });
await mkdir(hotfixOutputDirectory, { recursive: true });
await rm(hotfixCandidateFile, { force: true });

const common = {
  bundle: true,
  platform: "neutral",
  target: "es2022",
  sourcemap: debug ? "inline" : false,
  sourcesContent: debug,
  logLevel: "info",
};

const modelSourceHash = await hashModelSources();
let modelManifest;
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
  await rm(path.join(dist, "model.js"), { force: true });
  await build({
    ...common,
    format: "esm",
    entryPoints: [path.join(root, bench ? "app/model/main.bench.ts" : "app/model/main.ts")],
    outfile: path.join(dist, "model.js"),
  });
}

await build({
  ...common,
  format: "iife",
  banner: {
    js: `var require = (specifier) => {
  if (specifier !== "tiangz:model") throw new Error("unsupported Hotfix external: " + specifier);
  const model = globalThis.__tiangzModelExports;
  if (!model) throw new Error("immutable Model exports are not installed");
  return model;
};`,
  },
  entryPoints: [hotfixEntry],
  outfile: hotfixCandidateFile,
  plugins: [{
    name: "immutable-model-boundary",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^#tiangz\/model$/ }, () => ({
        path: "tiangz:model",
        external: true,
      }));
      buildApi.onResolve({ filter: /^#tiangz\/model\// }, (args) => ({
        errors: [{ text: `Hotfix must import only #tiangz/model, not ${args.path}` }],
      }));
    },
  }],
});

const modelBytes = await readFile(path.join(dist, "model.js"));
const hotfixBytes = await readFile(hotfixCandidateFile);
if (!hotfixOnly) {
  modelManifest = {
    formatVersion: 1,
    version: packageJson.version,
    modelFingerprint: sha256(modelBytes),
    modelSourceHash,
    protocolFingerprint: await hashFiles([
      path.join(root, "proto", "opcode.lock.json"),
      path.join(root, "proto", "schema.lock.json"),
    ]),
    stableCoreApiHash: await hashFiles([
      path.join(root, "app", "core", "public-api.lock.json"),
    ]),
    nativeSchemaHash: await hashDirectory(path.join(root, "native_data"), ".native"),
    gameConfigSchemaFingerprint: gameConfigManifest.schemaFingerprint,
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
  hotfixHash: sha256(hotfixBytes),
  buildMode,
};

if (!hotfixOnly) await writeJson(path.join(dist, "model.manifest.json"), modelManifest);
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
  `[build:runtime] ${buildMode} model=${modelManifest.modelFingerprint.slice(0, 12)} hotfix=${hotfixManifest.hotfixHash.slice(0, 12)} output=${path.relative(root, publishedDirectory).replaceAll(path.sep, "/")}\n`,
);

async function hashDirectory(directory, extension) {
  const files = await collect(directory, extension);
  return hashFiles(files);
}

async function hashModelSources() {
  const files = [
    ...await collect(path.join(root, "app", "core"), ".ts"),
    ...await collect(path.join(root, "app", "model"), ".ts"),
    ...await collect(path.join(root, "app", "generated", "model"), ".ts"),
    ...await collect(path.join(root, "app", "generated", "bootstrap"), ".ts"),
    ...await collect(path.join(root, "native_data"), ".native"),
    path.join(root, "proto", "opcode.lock.json"),
    path.join(root, "proto", "schema.lock.json"),
    path.join(root, "app", "core", "public-api.lock.json"),
  ];
  return hashFiles([...new Set(files)].sort((left, right) => left.localeCompare(right)));
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
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(root, file).replaceAll(path.sep, "/"));
    hash.update("\0");
    hash.update(await readFile(file));
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
