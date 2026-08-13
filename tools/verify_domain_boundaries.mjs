import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function importsOf(source) {
  const imports = [];
  const pattern = /\b(?:from|import)\s*(?:\(\s*)?["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) imports.push(match[1]);
  return imports;
}

function report(file, message) {
  violations.push(`${file}: ${message}`);
}

function resolveRelativeImport(file, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  return path.resolve(path.dirname(file), specifier).replaceAll(path.sep, "/");
}

function relativeTarget(file, specifier) {
  const absolute = resolveRelativeImport(file, specifier);
  return absolute ? path.relative(root, absolute).replaceAll(path.sep, "/") : undefined;
}

async function verifyTypeScriptBoundaries() {
  for (const rootPath of ["app/core", "app/model", "app/hotfix"]) {
    const files = await walk(path.join(root, rootPath), (file) => file.endsWith(".ts"));
    for (const file of files) {
      const fileName = relative(file);
      const source = await readFile(file, "utf8");
      for (const specifier of importsOf(source)) {
        const normalized = specifier.replaceAll("\\", "/");
        const target = relativeTarget(file, specifier);

        if (rootPath === "app/core") {
          if (
            normalized === "#tiangz/model" ||
            target?.startsWith("app/model/") ||
            target?.startsWith("app/hotfix/")
          ) {
            report(fileName, `Core must not import Demo or Hotfix: ${specifier}`);
          }
          continue;
        }

        if (rootPath === "app/model") {
          if (normalized === "#tiangz/model" || target?.startsWith("app/hotfix/")) {
            report(fileName, `Model must not import itself or Hotfix: ${specifier}`);
          }
          if (
            target?.startsWith("app/core/") &&
            target !== "app/core/public" &&
            fileName !== "app/model/main.ts" &&
            fileName !== "app/model/public.ts" &&
            fileName !== "app/model/bench/bootstrap.ts"
          ) {
            report(fileName, `Model must use the Stable Core entrypoint: ${specifier}`);
          }
          continue;
        }

        if (target?.startsWith("app/core/") || target?.startsWith("app/model/")) {
          report(fileName, `Hotfix must import Stable Model, not deep Core/Model paths: ${specifier}`);
        }
      }
    }
  }
}

async function verifyRustGameBoundary() {
  const files = await walk(path.join(root, "src/game"), (file) => file.endsWith(".rs"));
  const forbidden = /crate::(?:allocator|config|health|host|hotfix|logging|process|shutdown|transport|watcher)\b/;
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (forbidden.test(source)) report(relative(file), "src/game may not depend on Runtime host modules");
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
