import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dockerfile = path.join(root, "tools", "docker", "linux-builder", "Dockerfile");
const image = "tiangz-linux-builder:ubuntu-24.04";
const targetVolume = "tiangz-linux-builder-target";
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const releaseName = `TiangZ-${packageJson.version}-linux-x64`;
const excludedTopLevel = new Set([
  ".git",
  "dist",
  "node_modules",
  "perf",
  "target",
  "temp",
  "tools-projects",
]);
const options = parseOptions(process.argv.slice(2));
const fingerprint = builderFingerprint();
const fingerprintImage = `tiangz-linux-builder:toolchain-${fingerprint.slice(0, 16)}`;

if (options.fingerprintOnly) {
  console.log(fingerprint);
  process.exit(0);
}

assertLinuxDocker();
const installedImage = imageId(fingerprintImage);
if (options.rebuildImage || options.refreshBase || installedImage === null) {
  const reason = installedImage === null
    ? "builder image is missing"
    : options.rebuildImage
      ? "builder rebuild was requested"
      : "base image refresh was requested";
  console.log(`[linux-release] ${reason}; building ${image}`);
  buildImage();
} else {
  if (imageId(image) !== installedImage) run("docker", ["tag", fingerprintImage, image], { quiet: true });
  console.log(`[linux-release] reusing ${image} fingerprint=${fingerprint.slice(0, 12)}`);
}

verifyImage();
if (options.imageOnly) {
  console.log(`[linux-release] builder ready: ${image}`);
  process.exit(0);
}

const stagingRoot = mkdtempSync(path.join(os.tmpdir(), "tiangz-linux-release-"));
const stagedSource = path.join(stagingRoot, "source");
const outputRoot = path.join(root, "dist", "release");
const container = `tiangz-linux-release-${process.pid}-${randomUUID().slice(0, 8)}`;

try {
  console.log("[linux-release] copying current source into an isolated build context");
  cpSync(root, stagedSource, {
    recursive: true,
    dereference: false,
    filter: shouldCopySource,
  });
  mkdirSync(outputRoot, { recursive: true });
  run("docker", ["volume", "create", targetVolume], { quiet: true });
  run("docker", [
    "create",
    "--name",
    container,
    "--init",
    "--mount",
    `type=volume,source=${targetVolume},target=/workspace/target`,
    "--mount",
    `type=bind,source=${outputRoot},target=/output`,
    image,
    "bash",
    "-lc",
    "sleep infinity",
  ]);
  run("docker", ["start", container], { quiet: true });
  run("docker", ["cp", `${stagedSource}${path.sep}.`, `${container}:/workspace/`]);

  const smokeOption = options.skipSmoke ? " --skip-smoke" : "";
  const command = [
    "set -euo pipefail",
    "ln -s /opt/tiangz-deps/node_modules /workspace/node_modules",
    "mkdir -p /workspace/tools/third_party/luban",
    "rm -rf /workspace/tools/third_party/luban/4.10.2",
    "ln -s /opt/tiangz/luban/4.10.2 /workspace/tools/third_party/luban/4.10.2",
    "npm run build",
    "cargo build --release --locked --bin TiangZ",
    `npm run release:package -- --skip-build${smokeOption}`,
    `rm -rf /output/${releaseName}.next`,
    `cp -a /workspace/dist/release/${releaseName} /output/${releaseName}.next`,
    `rm -rf /output/${releaseName}`,
    `mv /output/${releaseName}.next /output/${releaseName}`,
  ].join(" && ");
  run("docker", ["exec", container, "bash", "-lc", command]);
  console.log(`[linux-release] packaged: ${path.join(outputRoot, releaseName)}`);
} finally {
  runOptional("docker", ["rm", "--force", container]);
  rmSync(stagingRoot, { recursive: true, force: true });
}

/** 工具链指纹只包含依赖与固定工具；业务TS、Rust和Excel变化不会触发镜像重建。 */
function builderFingerprint() {
  const hash = createHash("sha256");
  for (const file of [
    dockerfile,
    path.join(root, "Cargo.lock"),
    path.join(root, "rust-toolchain.toml"),
  ]) appendFile(hash, file);
  appendPackageLock(hash, path.join(root, "package-lock.json"));
  appendCargoManifest(hash, path.join(root, "Cargo.toml"));
  appendDirectory(hash, path.join(root, "tools", "third_party", "luban", "4.10.2"));
  return hash.digest("hex");
}

function appendDirectory(hash, directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const value = path.join(directory, entry.name);
    if (entry.isDirectory()) appendDirectory(hash, value);
    else if (entry.isFile()) appendFile(hash, value);
  }
}

function appendFile(hash, file) {
  appendContent(hash, file, readFileSync(file));
}

function appendCargoManifest(hash, file) {
  const normalized = readFileSync(file, "utf8").replace(
    /(^\[package\][\s\S]*?^version\s*=\s*)"[^"]+"/mu,
    '$1"<release-version>"',
  );
  appendContent(hash, file, normalized);
}

function appendPackageLock(hash, file) {
  const lock = JSON.parse(readFileSync(file, "utf8"));
  lock.version = "<release-version>";
  if (lock.packages?.[""]) lock.packages[""].version = "<release-version>";
  appendContent(hash, file, JSON.stringify(lock));
}

function appendContent(hash, file, content) {
  hash.update(path.relative(root, file).replaceAll("\\", "/"));
  hash.update("\0");
  hash.update(content);
  hash.update("\0");
}

function imageId(name) {
  const result = spawnSync("docker", ["image", "inspect", name, "--format", "{{.Id}}"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function buildImage() {
  const args = [
    "build",
    "--progress=plain",
    "--file",
    dockerfile,
    "--tag",
    image,
    "--tag",
    fingerprintImage,
  ];
  if (options.rebuildImage) args.push("--no-cache");
  if (options.refreshBase) args.push("--pull");
  args.push(root);
  run("docker", args);
}

function verifyImage() {
  run("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "bash",
    image,
    "-lc",
    [
      "node --version",
      "npm --version",
      "rustc --version",
      "cargo --version",
      "dotnet --list-runtimes | grep '^Microsoft.NETCore.App 8\\.'",
      "test -d /opt/tiangz-deps/node_modules",
      "test -f /opt/tiangz/luban/4.10.2/Luban.dll",
    ].join(" && "),
  ]);
}

function assertLinuxDocker() {
  const result = spawnSync("docker", ["info", "--format", "{{.OSType}}/{{.Architecture}}"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error("Docker Desktop is unavailable or not running");
  const platform = result.stdout.trim();
  if (platform !== "linux/x86_64") {
    throw new Error(`Linux x64 Docker is required, current=${platform}`);
  }
}

function shouldCopySource(source) {
  const relative = path.relative(root, source).replaceAll("\\", "/");
  if (relative === "") return true;
  const top = relative.split("/", 1)[0];
  if (excludedTopLevel.has(top)) {
    return false;
  }
  if (relative.startsWith("tools/third_party/luban/4.10.2")) return false;
  if (/codegen\.manifest\.json\.(?:lock|tmp)/u.test(relative)) return false;
  if (relative.endsWith(".log")) return false;
  if (relative.startsWith("client_demo/")) {
    const segments = new Set(relative.split("/"));
    for (const generated of [
      ".godot",
      ".vs",
      "Binaries",
      "Build",
      "Builds",
      "DerivedDataCache",
      "Intermediate",
      "Library",
      "Logs",
      "Saved",
      "Temp",
      "UserSettings",
      "build",
      "library",
      "local",
      "native",
      "node_modules",
      "obj",
      "profiles",
      "temp",
    ]) {
      if (segments.has(generated)) return false;
    }
  }
  return true;
}

function parseOptions(args) {
  const known = new Set([
    "--fingerprint-only",
    "--image-only",
    "--rebuild-image",
    "--refresh-base",
    "--skip-smoke",
  ]);
  const unknown = args.filter((arg) => !known.has(arg));
  if (unknown.length > 0) {
    throw new Error(
      "usage: node run_linux_release.mjs [--fingerprint-only] [--image-only] [--rebuild-image] [--refresh-base] [--skip-smoke]",
    );
  }
  return {
    fingerprintOnly: args.includes("--fingerprint-only"),
    imageOnly: args.includes("--image-only"),
    rebuildImage: args.includes("--rebuild-image"),
    refreshBase: args.includes("--refresh-base"),
    skipSmoke: args.includes("--skip-smoke"),
  };
}

function run(command, args, options = {}) {
  if (!options.quiet) console.log(`[linux-release] $ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: options.quiet ? "ignore" : "inherit",
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with code=${result.status} signal=${result.signal ?? "none"}`);
  }
}

function runOptional(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "ignore",
    shell: false,
    windowsHide: true,
  });
  return result.status === 0;
}
