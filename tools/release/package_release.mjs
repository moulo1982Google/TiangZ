import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const options = parseOptions(process.argv.slice(2));
const targetName = `TiangZ-${packageJson.version}-${process.platform}-${process.arch}`;
const outputRoot = path.join(root, "dist", "release");
const output = path.join(outputRoot, targetName);

if (!options.skipBuild) {
  await run(process.execPath, [requiredNpmExecPath(), "run", "build"]);
  await run("cargo", ["build", "--release", "--locked", "--bin", "TiangZ"]);
}

rmSync(output, { recursive: true, force: true });
mkdirSync(path.join(output, "dist"), { recursive: true });
const executable = process.platform === "win32" ? "TiangZ.exe" : "TiangZ";
copyRequired(path.join(root, "target", "release", executable), path.join(output, executable));
for (const runtimeFile of [
  "model.js",
  "hotfix.js",
  "model.manifest.json",
  "hotfix.manifest.json",
]) {
  copyRequired(path.join(root, "dist", runtimeFile), path.join(output, "dist", runtimeFile));
}
copyRequired(path.join(root, "dist", "smoke_client.cjs"), path.join(output, "dist", "smoke_client.cjs"));
cpSync(path.join(root, "configs"), path.join(output, "configs"), { recursive: true });
copyRequired(path.join(root, "README.md"), path.join(output, "README.md"));
copyRequired(path.join(root, "LICENSE"), path.join(output, "LICENSE"));

writeFileSync(path.join(output, "VERSION.json"), `${JSON.stringify({
  version: packageJson.version,
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
if (!options.skipSmoke) await smokeRelease(output, executable);
console.log(`[release] packaged: ${output}`);

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

async function capture(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: root, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

/** 在最终制品目录中启动Runtime并完成登录、进图和协议校验。 / Starts the packaged Runtime and verifies login, map entry, and protocol flow. */
async function smokeRelease(directory, executable) {
  console.log("[release] smoke testing packaged artifact");
  const runtime = spawn(path.join(directory, executable), ["configs/local/all.json"], {
    cwd: directory,
    env: { ...process.env, TIANGZ_WATCHER_CONTROL: "stdin" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let outputText = "";
  runtime.stdout.setEncoding("utf8").on("data", (chunk) => outputText += chunk);
  runtime.stderr.setEncoding("utf8").on("data", (chunk) => outputText += chunk);
  try {
    await Promise.all([7000, 7001, 7002, 7201, 7301].map((port) => waitForPort(port, runtime)));
    await run(process.execPath, [path.join(directory, "dist", "smoke_client.cjs")], directory);
  } catch (error) {
    throw new Error(`${error.message}\n[release runtime]\n${outputText}`);
  } finally {
    await stopRuntime(runtime);
  }
}

function waitForPort(port, runtime, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (runtime.exitCode !== null) {
        reject(new Error(`packaged Runtime exited before port ${port} was ready`));
        return;
      }
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(300);
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      const retry = () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error(`timed out waiting for port ${port}`));
        else setTimeout(attempt, 50);
      };
      socket.once("error", retry);
      socket.once("timeout", retry);
    };
    attempt();
  });
}

async function stopRuntime(runtime) {
  if (runtime.exitCode !== null || runtime.signalCode !== null) return;
  runtime.stdin.end("shutdown\n");
  await Promise.race([
    new Promise((resolve) => runtime.once("close", resolve)),
    new Promise((resolve) => setTimeout(resolve, 15_000)),
  ]);
  if (runtime.exitCode === null && runtime.signalCode === null) runtime.kill("SIGKILL");
}

function parseOptions(args) {
  const known = new Set(["--skip-build", "--skip-smoke"]);
  const unknown = args.filter((arg) => !known.has(arg));
  if (unknown.length > 0) {
    throw new Error("usage: npm run release:package -- [--skip-build] [--skip-smoke]");
  }
  return { skipBuild: args.includes("--skip-build"), skipSmoke: args.includes("--skip-smoke") };
}
