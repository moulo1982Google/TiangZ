import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cocosTypeConfig = path.join(root, "client_demo/cocos_client3D_3.8.8", "temp", "tsconfig.cocos.json");

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
