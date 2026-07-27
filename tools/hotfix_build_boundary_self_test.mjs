import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
await run(["tools/build_runtime_bundles.mjs"]);
await run(["tools/build_runtime_bundles.mjs", "--hotfix-only"]);

const modelManifestFile = path.join(root, "dist", "model.manifest.json");
const original = await readFile(modelManifestFile, "utf8");
const manifest = JSON.parse(original);
manifest.modelSourceHash = "invalid";
await writeFile(modelManifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
try {
  const result = await run(["tools/build_runtime_bundles.mjs", "--hotfix-only"], true);
  if (result.code === 0 || !result.stderr.includes("Model source changed")) {
    throw new Error("Hotfix-only build did not reject a changed Model source fingerprint");
  }
} finally {
  await writeFile(modelManifestFile, original, "utf8");
}
process.stdout.write("hotfix build boundary self-test passed\n");

function run(args, allowFailure = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0 || allowFailure) resolve({ code, stdout, stderr });
      else reject(new Error(`${stderr}\n${stdout}`));
    });
  });
}
