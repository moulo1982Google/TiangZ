import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import ts from "typescript";
import { loadGameModuleCatalog } from "./game_module_catalog.mjs";
import { dependencyDiagnostics } from "./dependency_rules.mjs";
import { hotfixClassDiagnostics, restrictedDecoratorKind } from "./hotfix_class_rules.mjs";

const root = path.resolve(import.meta.dirname, "..");
const moduleDirectoryArgument = argumentValue("--modules-dir") ?? process.env.TIANGZ_MODULES_DIR;
const moduleCatalog = await loadGameModuleCatalog({
  projectRoot: root,
  modulesDirectory: moduleDirectoryArgument
    ? path.resolve(root, moduleDirectoryArgument)
    : path.join(root, "modules"),
});
const hotfixRoot = path.join(root, "app", "hotfix");
const decoratorFixture = path.join(root, "tools", "fixtures", "hotfix-decorator-alias.fixture.ts");
const modelRoots = [
  path.join(root, "app", "core"),
  path.join(root, "app", "model"),
  path.join(root, "app", "generated", "model"),
  path.join(root, "app", "generated", "bootstrap"),
  path.join(root, "app", "generated", "hotfix"),
];
const errors = [];
const configFile = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
if (configFile.error) throw new Error(formatDiagnostic(configFile.error));
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
const moduleFiles = [];
for (const module of moduleCatalog.modules) {
  for (const directory of [...module.entries.modelRoots, ...module.entries.hotfixRoots]) {
    moduleFiles.push(...await collect(directory));
  }
}
const hotfixFiles = await collect(hotfixRoot);
const program = ts.createProgram(
  [...new Set([...parsed.fileNames, decoratorFixture, ...moduleFiles, ...hotfixFiles])],
  parsed.options,
);
const checker = program.getTypeChecker();

verifyDecoratorAliasFixture(program, checker);

for (const file of hotfixFiles) {
  const tree = program.getSourceFile(file);
  if (!tree) throw new Error(`Hotfix source is missing from the selected Program: ${file}`);
  inspectImports(tree);
  inspectHotfixClasses(file, tree, checker);
}
for (const modelRoot of modelRoots) {
  for (const file of await collect(modelRoot)) {
    const tree = program.getSourceFile(file) ?? ts.createSourceFile(
      file,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    inspectImports(tree);
  }
}
for (const module of moduleCatalog.modules) {
  for (const directory of module.entries.hotfixRoots) {
    for (const file of await collect(directory)) {
      const tree = program.getSourceFile(file);
      if (!tree) throw new Error(`Hotfix source is missing from the selected Program: ${file}`);
      inspectModuleImports(module, tree);
      inspectHotfixClasses(file, tree, checker);
    }
  }
  for (const directory of module.entries.modelRoots) {
    for (const file of await collect(directory)) {
      const tree = program.getSourceFile(file) ?? ts.createSourceFile(
        file,
        await readFile(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      inspectModuleImports(module, tree);
    }
  }
}

if (errors.length > 0) {
  process.stderr.write(`Model/Hotfix boundary failed:\n- ${errors.join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Model/Hotfix boundary verified\n");
}

function inspectImports(tree) {
  reportDependencies(dependencyDiagnostics(program, [tree], { root }));
}

function inspectModuleImports(module, tree) {
  reportDependencies(dependencyDiagnostics(program, [tree], { root, catalog: moduleCatalog, module }));
}

function reportDependencies(diagnostics) {
  for (const item of diagnostics) {
    const text = `${relative(item.file)}:${item.line}:${item.column}: [${item.code}] ${item.message}`;
    if (item.severity === "error") errors.push(text);
    else console.warn(`warning ${text}`);
  }
}

function inspectHotfixClasses(file, tree, typeChecker) {
  for (const item of hotfixClassDiagnostics(tree, typeChecker)) {
    const text = `${relative(file)}:${item.line}:${item.column}: [${item.code}] ${item.message}`;
    if (item.severity === "error") errors.push(text);
    else console.warn(`warning ${text}`);
  }
}

function verifyDecoratorAliasFixture(typeProgram, typeChecker) {
  const source = typeProgram.getSourceFile(decoratorFixture);
  if (!source) throw new Error("cannot load Hotfix decorator alias fixture");
  const recognized = new Map();
  const visit = (node) => {
    if (ts.isClassDeclaration(node) && node.name) {
      recognized.set(node.name.text, restrictedDecoratorKind(node, typeChecker));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const className of ["AliasHandler", "NamespaceHandler", "ExtensionHandler"]) {
    if (recognized.get(className) !== "Handler") {
      throw new Error(`Hotfix decorator alias self-test failed: ${className}`);
    }
  }
  if (recognized.get("UnrelatedDecoratorClass") !== undefined) throw new Error("Hotfix decorator self-test failed: unrelated same-name decorator must not be treated as Core");
  const diagnostics = hotfixClassDiagnostics(source, typeChecker);
  if (diagnostics.length !== 7 || diagnostics.some(item => item.code !== "tiangz.hotfix.instance-state" || item.severity !== "error")) {
    throw new Error(`Hotfix member fixture failed: ${JSON.stringify(diagnostics)}`);
  }
}

async function collect(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(fullPath);
  }
  return files;
}

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, "/");
}

function formatDiagnostic(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}

function argumentValue(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
