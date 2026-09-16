import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  existsSync,
  renameSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadGameModuleCatalog } from "../game_module_catalog.mjs";
import { moduleNativeFingerprint } from "../module_native.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
if (process.argv[2] === "--smoke-existing") {
  if (process.argv.length !== 4) throw new Error("--smoke-existing requires one packaged directory");
  const directory = path.resolve(process.argv[3]);
  const checksums = readFileSync(path.join(directory, "SHA256SUMS"), "utf8").trim().split(/\r?\n/);
  for (const line of checksums) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) throw new Error("invalid packaged checksum entry");
    const file = path.resolve(directory, match[2]);
    const relative = path.relative(directory, file);
    if (relative.startsWith("..") || path.isAbsolute(relative) || sha256(file) !== match[1]) throw new Error("packaged file integrity check failed");
  }
  await smokeRelease(directory, process.platform === "win32" ? "TiangZ.exe" : "TiangZ");
  console.log(`[release] existing artifact smoke passed: ${directory}`);
  process.exit(0);
}
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const options = parseOptions(process.argv.slice(2));
const profile = options.debug ? "debug" : "release";
const bundles = path.resolve(root, options.bundleDirectory ?? "dist");
if (options.bundleDirectory && !options.skipBuild) throw new Error("--bundle-dir consumes a prebuilt bundle; use --skip-build after building that directory");
const outputRoot = path.join(root, "dist", "release");
const catalog = await loadGameModuleCatalog({ projectRoot: root,
  modulesDirectory: path.resolve(root, process.env.TIANGZ_MODULES_DIR ?? "modules") });
const hasNative = catalog.modules.some((module) => module.native);

if (!options.skipBuild) {
  await run(process.execPath, [requiredNpmExecPath(), "run", "build"]);
  if (hasNative) await run(process.execPath, ["tools/build_module_native.mjs", ...(options.debug ? [] : ["--release"]), "--locked"]);
  else await run("cargo", ["build", ...(options.debug ? [] : ["--release"]), "--locked", "--bin", "TiangZ"]);
}

const executable = process.platform === "win32" ? "TiangZ.exe" : "TiangZ";
const nativeBuild = path.join(root, "temp/module-native-build", catalog.graphHash);
const nativeManifest = hasNative ? JSON.parse(readFileSync(path.join(nativeBuild, `${profile}.manifest.json`), "utf8")) : undefined;
const binary = hasNative ? path.resolve(nativeBuild, nativeManifest.binaryPath ?? path.join("target", profile, executable)) : path.join(root, "target", profile, executable);
if (hasNative && !binary.startsWith(nativeBuild + path.sep)) throw new Error("Native release binary is stale: path escapes composition directory");
const model = JSON.parse(readFileSync(path.join(bundles, "model.manifest.json"), "utf8"));
const hotfix = JSON.parse(readFileSync(path.join(bundles, "hotfix.manifest.json"), "utf8"));
const config = JSON.parse(readFileSync(path.join(bundles, "game-config/game-config.manifest.json"), "utf8"));
if (model.moduleGraphHash !== catalog.graphHash || hotfix.moduleGraphHash !== catalog.graphHash ||
    model.modelFingerprint !== hotfix.modelFingerprint || sha256(path.join(bundles, "model.js")) !== model.modelFingerprint ||
    sha256(path.join(bundles, "hotfix.js")) !== hotfix.hotfixHash) throw new Error("release bundles do not match the installed module graph or hashes");
const moduleConfigs = JSON.parse(config.moduleConfigsJson ?? "[]");
const schemas = model.moduleConfigSchemas ?? {};
if (!Array.isArray(moduleConfigs) || moduleConfigs.length !== Object.keys(schemas).length ||
    new Set(moduleConfigs.map((item) => item.moduleId)).size !== moduleConfigs.length ||
    moduleConfigs.some((item) => schemas[item.moduleId] !== item.schemaFingerprint) ||
    (config.moduleConfigsJson !== undefined && createHash("sha256").update(config.moduleConfigsJson).digest("hex") !== config.moduleConfigsHash) ||
    config.schemaFingerprint !== model.gameConfigSchemaFingerprint) throw new Error("release module config is incomplete or uses a different Model schema");
for (const [file, field] of [["server.json", "serverHash"], ["server.hot.json", "serverHotHash"], ["server.cold.json", "serverColdHash"],
  ["client.json", "clientHash"], ["client.hot.json", "clientHotHash"], ["client.cold.json", "clientColdHash"]]) {
  if (sha256(path.join(bundles, "game-config", file)) !== config[field]) throw new Error(`release config hash mismatch: ${file}`);
}
if (hasNative) {
  const native = JSON.parse(readFileSync(path.join(nativeBuild, `${profile}.manifest.json`), "utf8"));
  if (native.nativeModuleHash !== await moduleNativeFingerprint(catalog) || native.nativeModuleHash !== model.nativeModuleHash ||
      native.moduleGraphHash !== catalog.graphHash || native.binaryHash !== sha256(binary) ||
      native.cargoLockHash !== sha256(path.join(nativeBuild, "Cargo.lock"))) throw new Error("Native release binary is stale or belongs to another module set");
}
const identity = createHash("sha256").update(JSON.stringify({ model, hotfix, config, binary: sha256(binary) })).digest("hex");
const targetName = `TiangZ-${packageJson.version}-${process.platform}-${process.arch}-${profile}-${identity.slice(0, 16)}`;
const published = path.join(outputRoot, targetName);
if (existsSync(published)) throw new Error(`immutable release already exists: ${published}`);
mkdirSync(outputRoot, { recursive: true });
const output = mkdtempSync(path.join(outputRoot, ".building-"));
mkdirSync(path.join(output, "dist"), { recursive: true });
copyRequired(binary, path.join(output, executable));
if (hasNative) {
  copyRequired(path.join(nativeBuild, `${profile}.manifest.json`), path.join(output, "NATIVE.json"));
  copyRequired(path.join(nativeBuild, "Cargo.lock"), path.join(output, "native.Cargo.lock"));
}
for (const runtimeFile of [
  "model.js",
  "hotfix.js",
  "model.manifest.json",
  "hotfix.manifest.json",
]) {
  copyRequired(path.join(bundles, runtimeFile), path.join(output, "dist", runtimeFile));
}
cpSync(path.join(bundles, "game-config"), path.join(output, "dist", "game-config"), { recursive: true });
cpSync(path.join(root, "configs"), path.join(output, "configs"), { recursive: true });
// 游戏地图与部署实例由游戏工程打包，不把宿主的导航测试夹具当作默认内容。
// Game projects package their maps and instances; host navigation fixtures are not default game content.
copyRequired(path.join(root, "README.md"), path.join(output, "README.md"));
copyRequired(path.join(root, "LICENSE"), path.join(output, "LICENSE"));

writeFileSync(path.join(output, "VERSION.json"), `${JSON.stringify({
  version: packageJson.version,
  platform: process.platform,
  arch: process.arch,
  builtAt: new Date().toISOString(),
  rustc: await capture("rustc", ["--version"]),
  node: process.version,
  profile,
  moduleGraphHash: catalog.graphHash,
  modules: catalog.graph,
  releaseIdentity: identity,
}, null, 2)}\n`, "utf8");

const checksums = collectFiles(output)
  .filter((file) => path.basename(file) !== "SHA256SUMS")
  .map((file) => `${sha256(file)}  ${path.relative(output, file).replaceAll("\\", "/")}`)
  .join("\n");
writeFileSync(path.join(output, "SHA256SUMS"), `${checksums}\n`, "utf8");
if (!options.skipSmoke) await smokeRelease(output, executable);
renameSync(output, published);
console.log(`[release] packaged: ${published}`);

function copyRequired(source, destination) {
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function collectFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const value = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(value));
    else if (entry.isFile()) files.push(value);
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function requiredNpmExecPath() {
  if (!process.env.npm_execpath) throw new Error("run release packaging through npm run release:package");
  return process.env.npm_execpath;
}

function run(command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed with code=${code} signal=${signal ?? "none"}`));
    });
  });
}

async function capture(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: root, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

/** 验证无游戏宿主制品可执行；游戏联机验收由消费工程负责。 / Verifies the neutral host artifact executes; consumers own gameplay smoke tests. */
async function smokeRelease(directory, executable) {
  const output = await capture(path.join(directory, executable), ["--version"]);
  const version = JSON.parse(readFileSync(path.join(directory, "VERSION.json"), "utf8")).version;
  if (!output.includes(version)) throw new Error("packaged runtime version mismatch");
  console.log("[release] packaged binary version probe passed (not a gameplay acceptance)");
}

function parseOptions(args) {
  const directoryIndex = args.indexOf("--bundle-dir");
  const bundleDirectory = directoryIndex >= 0 ? args[directoryIndex + 1] : undefined;
  if (directoryIndex >= 0 && (!bundleDirectory || bundleDirectory.startsWith("--"))) throw new Error("--bundle-dir requires a directory");
  if (directoryIndex >= 0) args = [...args.slice(0, directoryIndex), ...args.slice(directoryIndex + 2)];
  const known = new Set(["--skip-build", "--skip-smoke", "--debug"]);
  const unknown = args.filter((arg) => !known.has(arg));
  if (unknown.length > 0) {
    throw new Error("usage: npm run release:package -- [--skip-build] [--skip-smoke] [--debug] [--bundle-dir <prebuilt-directory>]");
  }
  return { skipBuild: args.includes("--skip-build"), skipSmoke: args.includes("--skip-smoke"), debug: args.includes("--debug"), bundleDirectory };
}
