import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const appRoot = path.join(root, "app");
const publicFile = path.join(root, "app", "core", "public.ts");
const lockFile = path.join(root, "app", "core", "public-api.lock.json");
const updateLock = process.argv.includes("--update-lock");
const strictLock = updateLock || process.env.TIANGZ_LOCK_VERSIONS === "1" || process.argv.includes("--strict-lock");

const publicApi = collectPublicApi();
if (updateLock) {
  await writeFile(
    lockFile,
    `${JSON.stringify({
      schemaVersion: 3,
      stableExports: publicApi.stableExports,
      apiSurfaceHash: publicApi.apiSurfaceHash,
      apiSurface: publicApi.apiSurface,
      declarationGraphHash: publicApi.declarationGraphHash,
      declarationGraph: publicApi.declarationGraph,
    }, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `core API lock updated: ${publicApi.stableExports.length} exports, signature=${publicApi.apiSurfaceHash.slice(0, 12)}\n`,
  );
} else if (strictLock) {
  const lock = JSON.parse(await readFile(lockFile, "utf8"));
  if (
    lock.schemaVersion !== 3 ||
    !Array.isArray(lock.stableExports) ||
    !Array.isArray(lock.apiSurface) ||
    typeof lock.apiSurfaceHash !== "string" ||
    !Array.isArray(lock.declarationGraph) ||
    typeof lock.declarationGraphHash !== "string"
  ) {
    throw new Error(
      "unsupported or malformed app/core/public-api.lock.json; run npm run core-api:update-lock after reviewing the API migration",
    );
  }
  if (
    JSON.stringify(lock.stableExports) !== JSON.stringify(publicApi.stableExports) ||
    lock.apiSurfaceHash !== publicApi.apiSurfaceHash ||
    JSON.stringify(lock.apiSurface) !== JSON.stringify(publicApi.apiSurface) ||
    lock.declarationGraphHash !== publicApi.declarationGraphHash ||
    JSON.stringify(lock.declarationGraph) !== JSON.stringify(publicApi.declarationGraph)
  ) {
    const changed = changedSurfaceNames(lock.apiSurface, publicApi.apiSurface);
    const graphFiles = changedGraphFiles(lock.declarationGraph, publicApi.declarationGraph);
    const details = [...changed, ...graphFiles.map((file) => `graph:${file}`)].slice(0, 12);
    throw new Error(
      `stable Core API signature changed${details.length > 0 ? ` (${details.join(", ")})` : ""}; review compatibility, then run npm run core-api:update-lock`,
    );
  }
} else {
  process.stdout.write(
    "core API snapshot lock skipped in development; use npm run verify:release before publishing\n",
  );
}

const boundaryErrors = [];
await scanDirectory(path.join(root, "app", "core"), checkCoreImport);
await scanDirectory(path.join(root, "app", "model"), checkModelImport);
if (boundaryErrors.length > 0) {
  throw new Error(`Core API boundary violations:\n- ${boundaryErrors.join("\n- ")}`);
}

process.stdout.write(
  `core API ${strictLock ? "verified" : "inspected"}: ${publicApi.stableExports.length} stable exports, signature=${publicApi.apiSurfaceHash.slice(0, 12)}, no boundary violations${strictLock ? " (release lock enabled)" : " (development lock skipped)"}\n`,
);

/**
 * 锁定顶层业务签名与完整可达声明图，不读取任何函数体。
 * Locks top-level business signatures plus the full reachable declaration graph
 * without reading implementation bodies.
 */
function collectPublicApi() {
  const configFile = ts.readConfigFile(
    path.join(root, "tsconfig.json"),
    ts.sys.readFile,
  );
  if (configFile.error) throw new Error(formatDiagnostic(configFile.error));
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
  const options = {
    ...parsed.options,
    declaration: true,
    declarationMap: false,
    emitDeclarationOnly: true,
    noEmit: false,
    outDir: path.join(root, ".core-api-declarations"),
    rootDir: appRoot,
    sourceMap: false,
    stripInternal: true,
  };
  const program = ts.createProgram([publicFile], options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    throw new Error(diagnostics.map(formatDiagnostic).join("\n"));
  }

  const declarations = new Map();
  const emit = program.emit(undefined, (fileName, content) => {
    if (fileName.endsWith(".d.ts")) {
      declarations.set(normalizePath(fileName), content);
    }
  });
  if (emit.emitSkipped || emit.diagnostics.length > 0) {
    throw new Error(emit.diagnostics.map(formatDiagnostic).join("\n"));
  }

  const source = program.getSourceFile(publicFile);
  const checker = program.getTypeChecker();
  const symbol = source && checker.getSymbolAtLocation(source);
  if (!symbol) throw new Error("cannot resolve app/core/public.ts exports");

  const exports = checker
    .getExportsOfModule(symbol)
    .sort((left, right) => compareText(left.getName(), right.getName()));
  const apiSurface = exports.map((exported) => ({
    name: exported.getName(),
    declarations: declarationSurface(exported, checker, declarations),
  }));
  const declarationGraph = declarationGraphSurface(declarations, options.outDir);
  const serialized = JSON.stringify(apiSurface);
  return {
    stableExports: apiSurface.map((item) => item.name),
    apiSurface,
    apiSurfaceHash: createHash("sha256").update(serialized).digest("hex"),
    declarationGraph,
    declarationGraphHash: createHash("sha256")
      .update(JSON.stringify(declarationGraph))
      .digest("hex"),
  };
}

/**
 * 锁定public.ts可达的完整声明图，覆盖继承成员和未直接导出的传递类型。
 * Locks the full declaration graph reachable from public.ts so inherited
 * members and non-exported transitive types remain part of compatibility.
 */
function declarationGraphSurface(declarationFiles, declarationRoot) {
  return [...declarationFiles.entries()]
    .map(([file, content]) => ({
      path: normalizePath(path.relative(declarationRoot, file)),
      declaration: normalizeDeclarationFile(file, content),
    }))
    .sort((left, right) => compareText(left.path, right.path));
}

function normalizeDeclarationFile(file, content) {
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: true,
  });
  return normalizeDeclaration(printer.printFile(source));
}

function declarationSurface(exported, checker, declarationFiles) {
  const target = (exported.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(exported)
    : exported;
  const targetName = target.getName();
  const sourceDeclarations = target.getDeclarations() ?? [];
  const signatures = [];

  for (const sourceDeclaration of sourceDeclarations) {
    const sourceFile = sourceDeclaration.getSourceFile();
    const emittedFile = emittedDeclarationFile(sourceFile.fileName);
    if (!emittedFile) continue;
    const content = declarationFiles.get(emittedFile);
    if (!content) continue;
    const declarationFile = ts.createSourceFile(
      emittedFile,
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const statement of declarationFile.statements) {
      const selected = selectDeclaration(statement, targetName, declarationFile);
      if (selected) signatures.push(selected);
    }
  }

  const unique = [...new Set(signatures)].sort(compareText);
  if (unique.length === 0) {
    throw new Error(
      `cannot capture declaration signature for public Core export ${exported.getName()} (${targetName})`,
    );
  }
  return unique;
}

function emittedDeclarationFile(sourceFile) {
  const relativePath = path.relative(appRoot, sourceFile);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return undefined;
  const declarationRelative = relativePath.replace(/\.(?:mts|cts|tsx|ts)$/u, ".d.ts");
  return normalizePath(path.join(root, ".core-api-declarations", declarationRelative));
}

function selectDeclaration(statement, targetName, sourceFile) {
  let selected = statement;
  if (ts.isVariableStatement(statement)) {
    const declarations = statement.declarationList.declarations.filter(
      (item) => ts.isIdentifier(item.name) && item.name.text === targetName,
    );
    if (declarations.length === 0) return undefined;
    selected = ts.factory.updateVariableStatement(
      statement,
      statement.modifiers,
      ts.factory.updateVariableDeclarationList(statement.declarationList, declarations),
    );
  } else if (
    !(
      (ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) &&
      statement.name?.text === targetName
    )
  ) {
    return undefined;
  }

  if (ts.isClassDeclaration(selected)) {
    selected = ts.factory.updateClassDeclaration(
      selected,
      selected.modifiers,
      selected.name,
      selected.typeParameters,
      selected.heritageClauses,
      selected.members.filter(
        (member) => !isPrivateMember(member) && !isInternalMember(member),
      ),
    );
  }

  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: true,
  });
  return normalizeDeclaration(
    printer.printNode(ts.EmitHint.Unspecified, selected, sourceFile),
  );
}

function isPrivateMember(member) {
  if (member.name && ts.isPrivateIdentifier(member.name)) return true;
  return member.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword,
  ) ?? false;
}

function isInternalMember(member) {
  return member.name && ts.isIdentifier(member.name)
    ? member.name.text.startsWith("__")
    : false;
}

function normalizeDeclaration(value) {
  return value
    .replace(/\r\n/gu, "\n")
    .replace(/[ \t]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .trim();
}

function changedSurfaceNames(previous, current) {
  const previousByName = new Map(
    Array.isArray(previous) ? previous.map((item) => [item.name, item.declarations]) : [],
  );
  const currentByName = new Map(current.map((item) => [item.name, item.declarations]));
  return [...new Set([...previousByName.keys(), ...currentByName.keys()])]
    .filter(
      (name) => JSON.stringify(previousByName.get(name)) !== JSON.stringify(currentByName.get(name)),
    )
    .sort(compareText)
    .slice(0, 12);
}

function changedGraphFiles(previous, current) {
  const previousByPath = new Map(
    Array.isArray(previous) ? previous.map((item) => [item.path, item.declaration]) : [],
  );
  const currentByPath = new Map(current.map((item) => [item.path, item.declaration]));
  return [...new Set([...previousByPath.keys(), ...currentByPath.keys()])]
    .filter((file) => previousByPath.get(file) !== currentByPath.get(file))
    .sort(compareText)
    .slice(0, 12);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
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

function normalizePath(file) {
  return path.normalize(file).replaceAll("\\", "/");
}

function formatDiagnostic(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}
