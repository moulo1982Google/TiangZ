import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "temp", "game-module-build-self-test");
const modulesDirectory = path.join(root, "tools", "fixtures", "game-modules");
try {
  await rm(output, { recursive: true, force: true });
  await run([
    path.join("node_modules", "typescript", "bin", "tsc"),
    "--project", path.join(modulesDirectory, "greeting", "tsconfig.json"),
    "--noEmit",
  ]);
  await run([
    "tools/build_runtime_bundles.mjs",
    "--out-dir", output,
    "--modules-dir", modulesDirectory,
  ]);
  await run([
    "tools/verify_hotfix_boundary.mjs",
    "--modules-dir", modulesDirectory,
  ]);
  const modelManifest = JSON.parse(await readFile(path.join(output, "model.manifest.json"), "utf8"));
  const hotfixManifest = JSON.parse(await readFile(path.join(output, "hotfix.manifest.json"), "utf8"));
  if (modelManifest.moduleGraphHash !== hotfixManifest.moduleGraphHash) {
    throw new Error("Model and Hotfix module graph hashes differ");
  }
  if (modelManifest.modules?.[0]?.id !== "org.tiangz.fixture.greeting") {
    throw new Error(`neutral fixture module is missing from manifest: ${JSON.stringify(modelManifest.modules)}`);
  }
  const modelBundle = await readFile(path.join(output, "model.js"), "utf8");
  const hotfixBundle = await readFile(path.join(output, "hotfix.js"), "utf8");
  if (!modelBundle.includes("org.tiangz.fixture.greeting")) {
    throw new Error("neutral fixture Model was not composed into model.js");
  }
  if (!hotfixBundle.includes("tiangz:module-model:org.tiangz.fixture.greeting")) {
    throw new Error("neutral fixture Hotfix does not use the immutable module Model bridge");
  }
  for (const extensionId of [
    "org.tiangz.fixture.greeting.npc-marker",
    "org.tiangz.fixture.greeting.interactable-marker",
  ]) {
    if (!hotfixBundle.includes(extensionId)) {
      throw new Error(`neutral fixture Hotfix omitted ${extensionId}`);
    }
  }
  await verifyEntityFactoryExtensionOrder(
    "app/hotfix/mmorpg/npc/NpcComponentSystem.ts",
    "const npc = this.units.Create",
    "applyEntityExtensions(npc)",
    "this.npcs.set(npc.UnitId, npc)",
  );
  await verifyEntityFactoryExtensionOrder(
    "app/hotfix/mmorpg/interactable/InteractableComponentSystem.ts",
    "const interactable = this.units.Create",
    "applyEntityExtensions(interactable)",
    "this.interactables.set(interactable.UnitId, interactable)",
  );

  const customHotfixOutput = path.join(output, "custom-hotfix-entry");
  await run([
    "tools/build_runtime_bundles.mjs",
    "--hotfix-only",
    "--out-dir", output,
    "--modules-dir", modulesDirectory,
    "--hotfix-entry", "app/hotfix/main.ts",
    "--hotfix-out", customHotfixOutput,
  ]);
  const customHotfixBundle = await readFile(path.join(customHotfixOutput, "hotfix.js"), "utf8");
  if (!customHotfixBundle.includes("org.tiangz.fixture.greeting.counter")) {
    throw new Error("custom Hotfix entry omitted installed game module loaders");
  }

  await run([
    "tools/build_runtime_bundles.mjs",
    "--hotfix-only",
    "--out-dir", output,
    "--modules-dir", modulesDirectory,
  ]);
  const rejected = await run([
    "tools/build_runtime_bundles.mjs",
    "--hotfix-only",
    "--out-dir", output,
    "--modules-dir", path.join(root, "modules"),
  ], true);
  if (rejected.code === 0 || !rejected.stderr.includes("Model source changed")) {
    throw new Error("Hotfix-only build accepted a changed module graph");
  }
} finally {
  await rm(output, { recursive: true, force: true });
}

process.stdout.write("game module build self-test passed\n");

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

async function verifyEntityFactoryExtensionOrder(relativePath, createToken, extensionToken, publishToken) {
  const source = await readFile(path.join(root, relativePath), "utf8");
  const createIndex = source.indexOf(createToken);
  const extensionIndex = source.indexOf(extensionToken, createIndex);
  const publishIndex = source.indexOf(publishToken, createIndex);
  if (createIndex < 0 || extensionIndex < 0 || publishIndex < 0) {
    throw new Error(`entity extension factory seam is missing: ${relativePath}`);
  }
  if (!(createIndex < extensionIndex && extensionIndex < publishIndex)) {
    throw new Error(`entity extensions must run before publication: ${relativePath}`);
  }
}
