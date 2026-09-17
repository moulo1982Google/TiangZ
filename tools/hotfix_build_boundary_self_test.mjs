import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import assert from "node:assert/strict";
import { atomicReleaseId, releaseIdentityFields } from "./atomic_release_identity.mjs";

const root = path.resolve(import.meta.dirname, "..");
await run(["tools/build_runtime_bundles.mjs"]);
await run(["tools/build_runtime_bundles.mjs", "--hotfix-only"]);
await run(["tools/build_runtime_bundles.mjs", "--hotfix-only"]);
const releaseManifest = JSON.parse(await readFile(path.join(root, "dist/hotfix.manifest.json"), "utf8"));
assert.equal(atomicReleaseId(releaseManifest), releaseManifest.releaseId);
for (const field of releaseIdentityFields) {
  assert.notEqual(atomicReleaseId({ ...releaseManifest, [field]: `${releaseManifest[field]}-changed` }), releaseManifest.releaseId, `${field} must affect the release identity`);
}
assert.notEqual(atomicReleaseId({ ...releaseManifest, bundleVersion: "other-version" }), releaseManifest.releaseId);

const hotfixBundle = await readFile(path.join(root, "dist", "hotfix.js"), "utf8");
if (/^\s*import\s/m.test(hotfixBundle)) {
  throw new Error("Hotfix bundle must be a self-contained IIFE, not an ESM module");
}
if (!hotfixBundle.includes("globalThis.__tiangzModelExports")) {
  throw new Error("Hotfix bundle does not use the immutable Model export bridge");
}

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
