import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, realpath, symlink, copyFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadGameModuleCatalog } from "./game_module_catalog.mjs";
import { moduleNativeFingerprint } from "./module_native.mjs";
import { assertNativeDenoIdentity } from "./module_native_dependencies.mjs";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const profile = args.includes("--release") ? "release" : "debug";
const buildEnvironment = { ...process.env };
const hostTarget = /^host: (.+)$/m.exec(run("rustc", ["-vV"], { capture: true }))?.[1]?.trim();
if (!hostTarget) throw new Error("cannot determine Rust host target");
if (process.platform === "win32" && hostTarget.endsWith("-msvc")) {
  for (const name of ["CC", "CXX"]) {
    if (/^(?:gcc|g\+\+|cc|c\+\+)(?:\.exe)?$/i.test(path.basename(buildEnvironment[name] ?? ""))) {
      delete buildEnvironment[name];
      process.stdout.write(`[module-native-build] ignoring inherited GCC ${name} for the MSVC target\n`);
    }
  }
}
const index = args.indexOf("--modules-dir");
const catalog = await loadGameModuleCatalog({ projectRoot: root,
  modulesDirectory: path.resolve(root, index >= 0 ? args[index + 1] : process.env.TIANGZ_MODULES_DIR ?? "modules") });
const modules = catalog.modules.filter((module) => module.native);
if (!modules.length) { process.stdout.write("no module Native crates\n"); process.exit(0); }
const directory = path.join(root, "temp", "module-native-build", catalog.graphHash);
const targetDirectory = path.join(root, "temp", "module-native-target");
await mkdir(directory, { recursive: true });
const fingerprint = await moduleNativeFingerprint(catalog);
const dependencies = [];
for (const [index, module] of modules.entries()) {
  const crateRoot = await realpath(module.native.crate);
  const metadata = run("cargo", ["metadata", "--format-version", "1", "--no-deps", "--manifest-path", path.join(crateRoot, "Cargo.toml")], { capture: true });
  const packages = JSON.parse(metadata).packages;
  const crate = packages.find((item) => path.resolve(item.manifest_path) === path.join(crateRoot, "Cargo.toml"));
  if (crate?.name !== module.native.crateName) throw new Error(`native crate name mismatch: ${module.id}`);
  if (crate.targets.some((target) => target.kind.includes("custom-build"))) throw new Error(`module Native crates cannot run custom build scripts: ${module.id}`);
  dependencies.push(`tiangz_module_${index} = { package = ${quote(module.native.crateName)}, path = ${quote(crateRoot)} }`);
}
let manifest = await readFile(path.join(root, "Cargo.toml"), "utf8");
manifest = manifest.replace("[package]", `[package]\nautobins = false\nbuild = ${quote(path.join(root, "build.rs"))}`)
  .replace('name = "TiangZ"', 'name = "tiangz-module-host"')
  .replace('path = "src/transport_lib.rs"', `path = ${quote(path.join(root, "src/transport_lib.rs"))}`)
  .replace("[dependencies]", `[dependencies]\n${dependencies.join("\n")}`);
manifest += `\n[workspace]\n\n[[bin]]\nname = "TiangZ"\npath = ${quote(path.join(root, "src/main.rs"))}\n`;
await writeFile(path.join(directory, "Cargo.toml"), manifest);
const bridge = path.join(directory, "bridge.rs");
await writeFile(bridge,
  `pub(crate) const FINGERPRINT: &str = ${quote(fingerprint)};\n` +
  `pub(crate) fn extensions() -> Vec<deno_core::Extension> { vec![${modules.map((_, index) => `tiangz_module_${index}::extension()`).join(",")}] }\n` +
  `pub(crate) fn configure_project_root(root: &std::path::Path) -> anyhow::Result<()> { let _ = root; ${modules.map((module, index) => module.native.relative.configureProjectRoot ? `tiangz_module_${index}::configure_project_root(root).map_err(|error| anyhow::anyhow!("module {} resource root: {}", ${quote(module.id)}, error))?;` : "").join("\n")} Ok(()) }\n` +
  `pub(crate) fn bootstraps() -> &'static [(&'static str, &'static str)] { &[${modules.map((module, index) => `(${quote(module.id)}, tiangz_module_${index}::BOOTSTRAP)`).join(",")}] }\n`);
const lock = path.join(directory, "Cargo.lock");
try { await readFile(lock); } catch (error) {
  if (error.code !== "ENOENT") throw error;
  await writeFile(lock, await readFile(path.join(root, "Cargo.lock")));
}
const metadata = JSON.parse(run("cargo", ["metadata", "--format-version", "1", "--manifest-path", path.join(directory, "Cargo.toml"),
    "--filter-platform", hostTarget.trim(),
    ...(args.includes("--offline") ? ["--offline"] : []), ...(args.includes("--locked") ? ["--locked"] : [])], { capture: true }));
assertNativeDenoIdentity(metadata, modules);
if (process.platform === "win32") {
  const v8 = metadata.packages.find((item) => item.name === "v8");
  if (v8) {
    const source = await realpath(path.dirname(v8.manifest_path));
    const link = path.join(targetDirectory, profile, "gn_root");
    if (path.parse(source).root.toLowerCase() !== path.parse(link).root.toLowerCase()) {
      // V8跨盘构建需要同盘视图；目录联接不要求Windows符号链接特权。
      // V8 cross-drive builds need a same-drive view; junctions require no Windows symlink privilege.
      await mkdir(path.dirname(link), { recursive: true });
      let existing;
      try { existing = await realpath(link); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (existing && existing !== source) throw new Error("Native build cache refers to another V8 version; use a fresh output directory");
      if (!existing) await symlink(source, link, "junction");
    }
  }
}
run("cargo", [args.includes("--check") ? "check" : "build", "--bin", "TiangZ", "--manifest-path", path.join(directory, "Cargo.toml"),
  "--target-dir", targetDirectory, ...(args.includes("--offline") ? ["--offline"] : []),
  ...(args.includes("--release") ? ["--release"] : []), ...(args.includes("--locked") ? ["--locked"] : [])], {
  env: { ...buildEnvironment, TIANGZ_ENGINE_ROOT: root, TIANGZ_MODULE_NATIVE_BRIDGE: bridge },
});
const binary = path.join(directory, "bin", profile, process.platform === "win32" ? "TiangZ.exe" : "TiangZ");
if (!args.includes("--check")) {
  await mkdir(path.dirname(binary), { recursive: true });
  await copyFile(path.join(targetDirectory, profile, path.basename(binary)), binary);
  await writeFile(path.join(directory, `${profile}.manifest.json`), JSON.stringify({
    formatVersion: 1, moduleGraphHash: catalog.graphHash, nativeModuleHash: fingerprint,
    binaryPath: path.relative(directory, binary).replaceAll(path.sep, "/"),
    binaryHash: createHash("sha256").update(await readFile(binary)).digest("hex"),
    cargoLockHash: createHash("sha256").update(await readFile(lock)).digest("hex"),
  }, null, 2) + "\n");
}
process.stdout.write(`[module-native-build] fingerprint=${fingerprint} ${args.includes("--check") ? "checked" : `output=${path.relative(root, binary)}`}\n`);

function quote(value) { return JSON.stringify(value.replaceAll(path.sep, "/")); }
function run(command, argumentsList, options = {}) {
  const result = spawnSync(command, argumentsList, { cwd: root, env: options.env ?? process.env,
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr ?? result.status}`);
  return result.stdout;
}
