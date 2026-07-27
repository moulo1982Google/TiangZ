import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const publicFile = path.join(root, "app", "core", "public.ts");
const lockFile = path.join(root, "app", "core", "public-api.lock.json");
const updateLock = process.argv.includes("--update-lock");

const stableExports = collectPublicExports();
if (updateLock) {
  await writeFile(
    lockFile,
    `${JSON.stringify({ schemaVersion: 1, stableExports }, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`core API lock updated: ${stableExports.length} exports\n`);
} else {
  const lock = JSON.parse(await readFile(lockFile, "utf8"));
  if (lock.schemaVersion !== 1 || !Array.isArray(lock.stableExports)) {
    throw new Error("unsupported or malformed app/core/public-api.lock.json");
  }
  if (JSON.stringify(lock.stableExports) !== JSON.stringify(stableExports)) {
    throw new Error(
      "stable Core API changed; review compatibility, then run npm run core-api:update-lock",
    );
  }
}

const boundaryErrors = [];
await scanDirectory(path.join(root, "app", "core"), checkCoreImport);
await scanDirectory(path.join(root, "app", "model"), checkModelImport);
if (boundaryErrors.length > 0) {
  throw new Error(`Core API boundary violations:\n- ${boundaryErrors.join("\n- ")}`);
}

process.stdout.write(
  `core API verified: ${stableExports.length} stable exports, no boundary violations\n`,
);

function collectPublicExports() {
  const configFile = ts.readConfigFile(
    path.join(root, "tsconfig.json"),
    ts.sys.readFile,
  );
  if (configFile.error) throw new Error(formatDiagnostic(configFile.error));
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
  const program = ts.createProgram([publicFile], parsed.options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    throw new Error(diagnostics.map(formatDiagnostic).join("\n"));
  }
  const source = program.getSourceFile(publicFile);
  const checker = program.getTypeChecker();
  const symbol = source && checker.getSymbolAtLocation(source);
  if (!symbol) throw new Error("cannot resolve app/core/public.ts exports");
  return checker
    .getExportsOfModule(symbol)
    .map((item) => item.getName())
    .sort();
}

async function scanDirectory(directory, checkImport) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await scanDirectory(file, checkImport);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const source = ts.createSourceFile(
      file,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    source.forEachChild((node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        checkImport(file, node.moduleSpecifier.text);
      }
    });
  }
}

function checkCoreImport(file, specifier) {
  const resolved = resolveRelative(file, specifier);
  if (!resolved) return;
  if (isWithin(resolved, path.join(root, "app", "model"))) {
    boundaryErrors.push(`${relative(file)} imports Model module ${specifier}`);
  }
  if (isWithin(resolved, path.join(root, "app", "hotfix"))) {
    boundaryErrors.push(`${relative(file)} imports Hotfix module ${specifier}`);
  }
  if (isWithin(resolved, path.join(root, "app", "generated"))) {
    boundaryErrors.push(`${relative(file)} imports Generated module ${specifier}`);
  }
}

function checkModelImport(file, specifier) {
  const modelFile = relative(file);
  if (/^app\/model\/main(?:\.[^/]+)?\.ts$/.test(modelFile)) return;
  if (modelFile.startsWith("app/model/bench/")) return;
  const resolved = resolveRelative(file, specifier);
  if (!resolved || !isWithin(resolved, path.join(root, "app", "core"))) return;
  const publicModule = path.normalize(publicFile.slice(0, -3));
  if (stripTypeScriptExtension(resolved) !== publicModule) {
    boundaryErrors.push(
      `${relative(file)} deep-imports ${specifier}; Model business code must use app/core/public.ts`,
    );
  }
}

function resolveRelative(file, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  return path.normalize(path.resolve(path.dirname(file), specifier));
}

function stripTypeScriptExtension(file) {
  return file.endsWith(".ts") ? file.slice(0, -3) : file;
}

function isWithin(file, directory) {
  const relativePath = path.relative(directory, file);
  return relativePath === "" || (
    !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
  );
}

function relative(file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

function formatDiagnostic(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}
