import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cocosTypeConfig = path.join(root, "client_demo/cocos_client3D_3.8.8", "temp", "tsconfig.cocos.json");
const cocosDemoSource = path.join(root, "client_demo/cocos_client3D_3.8.8", "assets", "scripts", "Demo");

verifyNoIteratorSpread(cocosDemoSource);

if (existsSync(cocosTypeConfig)) {
  console.log("[cocos3d-check] detected Cocos editor types; running full TypeScript check");
  await run(process.execPath, [
    path.join(root, "node_modules", "typescript", "bin", "tsc"),
    "-p", "client_demo/cocos_client3D_3.8.8/tsconfig.json", "--noEmit",
  ]);
} else {
  console.log("[cocos3d-check] Cocos editor types are absent; running engine-independent bundle check");
  await runEsbuild([
    "client_demo/cocos_client3D_3.8.8/assets/scripts/Demo/GameBootstrap3D.ts",
    "--bundle",
    "--platform=browser",
    "--format=esm",
    "--target=es2022",
    "--tsconfig=client_demo/cocos_client2D_3.8.6/tsconfig.bundle.json",
    "--external:cc",
    "--external:cc/env",
    "--outfile=dist/cocos3d_demo_check.js",
  ]);
}

function runEsbuild(args) {
  const executable = path.join(root, "node_modules", "esbuild", "bin", "esbuild");
  return process.platform === "win32"
    ? run(process.execPath, [executable, ...args])
    : run(executable, args);
}

/**
 * Cocos 3.8.8 Web可能把`[...map.values()]`错误降级为`[].concat(map.values())`，导致UI拿到迭代器而不是元素。
 * Cocos 3.8.8 Web may lower `[...map.values()]` into `[].concat(map.values())`, feeding an iterator to UI code.
 */
function verifyNoIteratorSpread(directory) {
  const violations = [];
  for (const file of listTypeScriptFiles(directory)) {
    const source = readFileSync(file, "utf8");
    const lines = source.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      if (/\[\s*\.\.\.[^\]]*\.(?:values|keys|entries)\(\s*\)/u.test(lines[index])) {
        violations.push(`${path.relative(root, file)}:${index + 1}`);
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `[cocos3d-check] 禁止展开Map/Set迭代器，请使用Array.from(...)：\n${violations.join("\n")}`,
    );
  }
}

function listTypeScriptFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listTypeScriptFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(absolute);
  }
  return files;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} failed with code=${code} signal=${signal ?? "none"}`));
    });
  });
}
