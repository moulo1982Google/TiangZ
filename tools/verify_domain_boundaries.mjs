import { readdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDependencyProgram, dependencyDiagnostics } from "./dependency_rules.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const violations = [];

async function walk(directory, predicate) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "generated" || entry.name === "node_modules") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute, predicate));
    else if (predicate(absolute)) files.push(absolute);
  }
  return files;
}

function relative(absolute) {
  return path.relative(root, absolute).replaceAll(path.sep, "/");
}

function report(file, message) {
  violations.push(`${file}: ${message}`);
}

async function verifyTypeScriptBoundaries() {
  const program = createDependencyProgram(root);
  for (const rootPath of ["app/core", "app/model", "app/hotfix"]) {
    const files = await walk(path.join(root, rootPath), (file) => file.endsWith(".ts"));
    for (const file of files) {
      const source = program.getSourceFile(file);
      if (!source) throw new Error(`dependency source is missing from the selected Program: ${file}`);
      for (const item of dependencyDiagnostics(program, [source], { root })) {
        const text = `${relative(item.file)}:${item.line}:${item.column}: [${item.code}] ${item.message}`;
        if (item.severity === "error") violations.push(text);
        else console.warn(`warning ${text}`);
      }
    }
  }
}

async function verifyRustGameBoundary() {
  for (const directory of ["src/game", "app/model/mmorpg", "app/hotfix/mmorpg", "client_demo"]) {
    try { await access(path.join(root, directory)); report(directory, "game examples belong in external modules, not the engine source tree"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

await verifyTypeScriptBoundaries();
await verifyRustGameBoundary();

if (violations.length > 0) {
  process.stderr.write(`Domain boundary check failed (${violations.length}):\n${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Domain boundary check passed: Core, Model, Hotfix and Rust game layers are isolated.\n");
}
