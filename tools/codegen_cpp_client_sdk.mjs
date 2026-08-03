import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectGeneratedFiles, recordGenerator } from "./codegen_manifest.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptFile), "..");
const configFile = path.join(root, "codegen.config.json");
const config = JSON.parse(await readFile(configFile, "utf8"));
const sdk = config.cppClientSdk;

if (!sdk?.enabled) process.exit(0);
if (typeof sdk.sourceRoot !== "string" || !Array.isArray(sdk.outputRoots)) {
  throw new Error("cppClientSdk requires sourceRoot and outputRoots");
}

const sourceRoot = path.resolve(root, sdk.sourceRoot);
const outputRoots = sdk.outputRoots.map((item) => path.resolve(root, item));
const sourceFiles = await discoverHeaders(sourceRoot);
for (const outputRoot of outputRoots) {
  await rm(outputRoot, { recursive: true, force: true });
  for (const sourceFile of sourceFiles) {
    const target = path.join(outputRoot, path.relative(sourceRoot, sourceFile));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(sourceFile));
  }
}

await recordGenerator(root, {
  id: "cpp-client-sdk",
  command: "npm run codegen:cpp-client-sdk",
  contentInputs: [scriptFile, configFile, ...sourceFiles],
  outputs: await collectGeneratedFiles(outputRoots.map((item) => ({ path: item, extensions: [".h"] }))),
  outputRoots: outputRoots.map((item) => ({ path: item, extensions: [".h"] })),
});

console.log(`[codegen:cpp-client-sdk] generated ${outputRoots.length} SDK copy/copies`);

async function discoverHeaders(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await discoverHeaders(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".h")) files.push(fullPath);
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}
