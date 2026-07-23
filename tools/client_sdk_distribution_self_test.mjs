import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(await readFile(path.join(root, "codegen.config.json"), "utf8"));
const sdk = config.typescriptClientSdk;

assert.equal(sdk?.enabled, true, "typescriptClientSdk must be enabled");
const sourceRoot = path.resolve(root, sdk.sourceRoot);
const sourceFiles = await discover(sourceRoot);
assert.ok(sourceFiles.length > 0, "canonical TypeScript SDK is empty");

for (const configuredRoot of sdk.outputRoots) {
  const outputRoot = path.resolve(root, configuredRoot);
  const outputFiles = await discover(outputRoot);
  assert.deepEqual(
    outputFiles.map((file) => path.relative(outputRoot, file).replaceAll("\\", "/")),
    sourceFiles.map((file) => path.relative(sourceRoot, file).replaceAll("\\", "/")),
    `${configuredRoot} SDK file list differs from canonical SDK`,
  );
  for (const sourceFile of sourceFiles) {
    const relative = path.relative(sourceRoot, sourceFile);
    assert.equal(
      normalize(await readFile(path.join(outputRoot, relative), "utf8")),
      normalize(await readFile(sourceFile, "utf8")),
      `${configuredRoot}/${relative.replaceAll("\\", "/")} differs from canonical SDK`,
    );
  }
}

console.log(
  `client SDK distribution self-test passed: ${sourceFiles.length} files, ${sdk.outputRoots.length} clients`,
);

async function discover(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await discover(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(fullPath);
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

function normalize(content) {
  return content.replaceAll("\r\n", "\n");
}
