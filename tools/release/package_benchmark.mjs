import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const project = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const options = parseOptions(process.argv.slice(2));
const suffix = process.platform === "win32" ? ".exe" : "";
const defaultName = `TiangZ-rpc-benchmark-${project.version}-${process.platform}-${process.arch}`;
const output = path.resolve(root, options.output ?? path.join("dist", "benchmark", defaultName));

if (!options.skipBuild) {
  await run(process.execPath, [requiredNpmExecPath(), "run", "build:bench"]);
  await run("cargo", ["build", "--release", "--locked", "--bin", "TiangZ", "--bin", "runtime_load"]);
}

rmSync(output, { recursive: true, force: true });
mkdirSync(path.join(output, "dist", "game-config"), { recursive: true });
mkdirSync(path.join(output, "configs", "bench"), { recursive: true });
mkdirSync(path.join(output, "perf", "rpc_baseline"), { recursive: true });

copyRequired(path.join(root, "target", "release", `TiangZ${suffix}`), path.join(output, `TiangZ${suffix}`));
copyRequired(path.join(root, "target", "release", `runtime_load${suffix}`), path.join(output, `runtime_load${suffix}`));
for (const file of ["model.js", "hotfix.js", "model.manifest.json", "hotfix.manifest.json"]) {
  copyRequired(path.join(root, "dist", file), path.join(output, "dist", file));
}
cpSync(path.join(root, "dist", "game-config"), path.join(output, "dist", "game-config"), { recursive: true });
copyRequired(path.join(root, "configs", "bench", "bench.json"), path.join(output, "configs", "bench", "bench.json"));
copyRequired(
  path.join(root, "perf", "rpc_baseline", "run_rpc_baseline.mjs"),
  path.join(output, "perf", "rpc_baseline", "run_rpc_baseline.mjs"),
);

writeFileSync(path.join(output, "package.json"), `${JSON.stringify({
  name: "tiangz-rpc-benchmark",
  private: true,
  type: "module",
  engines: { node: ">=20" },
  scripts: { "perf:rpc-baseline": "node perf/rpc_baseline/run_rpc_baseline.mjs" },
}, null, 2)}\n`, "utf8");
writeFileSync(path.join(output, "README.md"), buildReadme(project.version), "utf8");
writeFileSync(path.join(output, "BENCHMARK.json"), `${JSON.stringify({
  version: project.version,
  package: "rpc-baseline",
  platform: process.platform,
  arch: process.arch,
  builtAt: new Date().toISOString(),
  rustc: await capture("rustc", ["--version"]),
  node: process.version,
}, null, 2)}\n`, "utf8");

const checksums = collectFiles(output)
  .filter((file) => path.basename(file) !== "SHA256SUMS")
  .map((file) => `${sha256(file)}  ${path.relative(output, file).replaceAll("\\", "/")}`)
  .join("\n");
writeFileSync(path.join(output, "SHA256SUMS"), `${checksums}\n`, "utf8");

console.log(`[benchmark] packaged: ${path.relative(root, output)}`);
console.log(`[benchmark] run: cd ${path.relative(process.cwd(), output) || "."} && npm run perf:rpc-baseline -- --skip-build`);

function copyRequired(source, destination) {
  if (!existsSync(source)) throw new Error(`required benchmark artifact is missing: ${path.relative(root, source)}`);
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
  if (!process.env.npm_execpath) throw new Error("run benchmark packaging through npm run perf:package");
  return process.env.npm_execpath;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed with code=${code} signal=${signal ?? "none"}`));
    });
  });
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: root, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

function buildReadme(version) {
  return [
    `# TiangZ RPC Benchmark ${version}`,
    "",
    "这是不包含源码的 RPC 基准测试制品。只需要 Node.js 20+，不需要 npm 依赖、Rust 或 Cargo。",
    "",
    "## 运行",
    "",
    "```bash",
    "npm run perf:rpc-baseline -- --skip-build \\",
    "  --warmup 10 --duration 60 \\",
    "  --connections 8 --concurrency 512 \\",
    "  --payloads 64,256,1024,4096,16384",
    "```",
    "",
    "报告和 Runtime 标准输出会写入 `perf/results/`。默认使用 Release 二进制和 `configs/bench/bench.json`。",
    "",
  ].join("\n");
}

function parseOptions(args) {
  let skipBuild = false;
  let output;
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--skip-build") {
      skipBuild = true;
      continue;
    }
    if (name === "--output") {
      output = args[++index];
      if (!output) throw new Error("--output requires a directory");
      continue;
    }
    throw new Error("usage: npm run perf:package -- [--skip-build] [--output <directory>]");
  }
  return { skipBuild, output };
}
