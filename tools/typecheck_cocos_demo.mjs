import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cocosTypeConfig = path.join(root, "cocos_client2D", "temp", "tsconfig.cocos.json");

if (existsSync(cocosTypeConfig)) {
  console.log("[cocos-check] detected Cocos editor types; running full TypeScript check");
  await run(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"),
    "-p", "cocos_client2D/tsconfig.json", "--noEmit",
  ]);
} else {
  console.log("[cocos-check] Cocos editor types are absent; running engine-independent bundle check");
  await run(path.join(root, "node_modules", "esbuild", "bin", "esbuild"), [
    "cocos_client2D/assets/scripts/Demo/GameBootstrap.ts",
    "--bundle",
    "--platform=browser",
    "--format=esm",
    "--target=es2022",
    "--tsconfig=cocos_client2D/tsconfig.bundle.json",
    "--external:cc",
    "--external:cc/env",
    "--outfile=dist/cocos_demo_check.js",
  ]);
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
