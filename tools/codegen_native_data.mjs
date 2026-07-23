import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertValidNativeWorkspace } from "@tiangz/native-language-core";
import { generateNativeFiles } from "@tiangz/native-language-core/codegen";
import { recordGenerator } from "./codegen_manifest.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptFile), "..");
const schemaRoot = path.join(root, "native_data");
const schemaFiles = await collectSchemaFiles(schemaRoot);
const sources = await Promise.all(schemaFiles.map(async (file) => ({
  uri: file,
  text: await readFile(file, "utf8"),
})));
const schema = assertValidNativeWorkspace(sources);
const generatedFiles = generateNativeFiles(schema);
const outputs = [];

for (const generatedFile of generatedFiles) {
  const output = resolveOutputPath(generatedFile.relativePath);
  outputs.push(output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, generatedFile.content, "utf8");
  if (generatedFile.format === "rust") formatRust(output);
}

await recordGenerator(root, {
  id: "native-data",
  command: "npm run codegen:native-data",
  contentInputs: [scriptFile, path.join(root, "package.json"), ...schemaFiles],
  outputs,
  outputRoots: [
    { path: path.join(root, "app", "generated", "model", "native"), extensions: [".ts"] },
    {
      path: path.join(root, "src", "generated"),
      extensions: [".js", ".rs"],
      ignore: [path.join(root, "src", "generated", "mod.rs")],
    },
  ],
});

const concreteEntityCount = schema.entities.filter((entity) => !entity.abstract).length;
console.log(
  `[codegen:native-data] generated native data, ${schema.operations.length} op binding(s), and ${concreteEntityCount} TS handle(s)`,
);

function resolveOutputPath(relativePath) {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`native codegen returned an absolute output path: ${relativePath}`);
  }
  const output = path.resolve(root, relativePath);
  const relativeToRoot = path.relative(root, output);
  if (relativeToRoot === "" || relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error(`native codegen output escapes the project root: ${relativePath}`);
  }
  return output;
}

function formatRust(file) {
  const result = spawnSync("rustfmt", ["--edition", "2024", file], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(`failed to start rustfmt: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`rustfmt failed:\n${result.stderr || result.stdout}`);
  }
}

async function collectSchemaFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectSchemaFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".native")) files.push(fullPath);
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}
