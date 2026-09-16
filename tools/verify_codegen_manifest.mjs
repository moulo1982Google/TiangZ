import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const engine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectIndex = process.argv.indexOf("--project");
if (projectIndex >= 0 && (!process.argv[projectIndex + 1] || process.argv[projectIndex + 1].startsWith("--"))) throw new Error("--project requires a directory");
const root = projectIndex >= 0 ? path.resolve(process.argv[projectIndex + 1]) : engine;
const manifestPath = path.join(root, "codegen.manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const errors = [];

if (manifest.version !== 1 || typeof manifest.generators !== "object") {
  throw new Error("unsupported or malformed codegen.manifest.json");
}

for (const [generator, descriptor] of Object.entries(manifest.generators)) {
  if (descriptor.implementationFingerprint && descriptor.implementationFingerprint !== hashText(await readFile(path.join(engine, "tools/codegen_manifest.mjs"), "utf8"))) errors.push(`${generator}: generator implementation changed`);
  await verifyHashes(generator, "input", descriptor.contentInputs);
  await verifyHashes(generator, "output", descriptor.outputs);
  for (const outputRoot of descriptor.outputRoots) {
    const actual = await collectFiles(outputRoot);
    const expected = Object.keys(descriptor.outputs)
      .filter((file) => file === outputRoot.path || file.startsWith(`${outputRoot.path}/`))
      .sort((left, right) => left.localeCompare(right, "en"));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      errors.push(
        `${generator}: generated file set differs under ${outputRoot.path}; run ${descriptor.command}`,
      );
    }
  }
}

if (errors.length > 0) {
  throw new Error(`generated artifacts are stale:\n- ${errors.join("\n- ")}`);
}
console.log(`codegen manifest verified (${Object.keys(manifest.generators).length} generators)`);

async function verifyHashes(generator, kind, files) {
  for (const [relative, expected] of Object.entries(files)) {
    try {
      const actual = hashText(await readFile(path.join(root, relative), "utf8"));
      if (actual !== expected) {
        errors.push(`${generator}: ${kind} changed: ${relative}`);
      }
    } catch (error) {
      if (error?.code === "ENOENT") errors.push(`${generator}: ${kind} missing: ${relative}`);
      else throw error;
    }
  }
}

async function collectFiles(outputRoot) {
  const files = [];
  const ignored = new Set(outputRoot.ignore ?? []);
  await walk(path.join(root, outputRoot.path));
  return files.sort((left, right) => left.localeCompare(right, "en"));

  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile() || !outputRoot.extensions.includes(path.extname(entry.name))) continue;
      const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
      if (!ignored.has(relative)) files.push(relative);
    }
  }
}

function hashText(content) {
  return createHash("sha256").update(content.replaceAll("\r\n", "\n"), "utf8").digest("hex");
}
