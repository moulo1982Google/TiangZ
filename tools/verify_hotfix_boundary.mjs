import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const hotfixRoot = path.join(root, "app", "hotfix");
const decoratorFixture = path.join(root, "tools", "fixtures", "hotfix-decorator-alias.fixture.ts");
const modelRoots = [
  path.join(root, "app", "core"),
  path.join(root, "app", "model"),
  path.join(root, "app", "generated", "model"),
  path.join(root, "app", "generated", "bootstrap"),
];
const errors = [];
const systemDecorators = new Set(["hotfixFor", "systemFor"]);
const handlerDecorators = new Set([
  "messageHandler",
  "rpcHandler",
  "sessionMessageHandler",
  "sessionRpcHandler",
  "unitMessageHandler",
  "unitRpcHandler",
  "syncEventHandler",
  "vetoEventHandler",
]);
const configFile = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
if (configFile.error) throw new Error(formatDiagnostic(configFile.error));
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
const program = ts.createProgram([...parsed.fileNames, decoratorFixture], parsed.options);
const checker = program.getTypeChecker();

verifyDecoratorAliasFixture(program, checker);

for (const file of await collect(hotfixRoot)) {
  const tree = program.getSourceFile(file) ?? ts.createSourceFile(
    file,
    await readFile(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  inspectImports(file, tree, true);
  inspectHotfixClasses(file, tree, checker);
}
for (const modelRoot of modelRoots) {
  for (const file of await collect(modelRoot)) {
    const tree = ts.createSourceFile(
      file,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    inspectImports(file, tree, false);
  }
}

if (errors.length > 0) {
  process.stderr.write(`Model/Hotfix boundary failed:\n- ${errors.join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Model/Hotfix boundary verified\n");
}

function inspectImports(file, tree, hotfix) {
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier)) continue;
    const value = specifier.text;
    if (hotfix) {
      if (value === "#tiangz/model") continue;
      if (!value.startsWith(".")) {
        errors.push(`${relative(file)}: Hotfix只能导入#tiangz/model或同层Hotfix模块: ${value}`);
        continue;
      }
      const target = path.resolve(path.dirname(file), value);
      if (!isWithin(target, hotfixRoot) && !isWithin(target, path.join(root, "app", "generated", "hotfix"))) {
        errors.push(`${relative(file)}: Hotfix禁止深层导入Model/Core/Generated Model: ${value}`);
      }
      continue;
    }
    if (value.includes("/hotfix") || value.startsWith("#tiangz/hotfix")) {
      errors.push(`${relative(file)}: Model/Core禁止依赖Hotfix: ${value}`);
    }
  }
}

function inspectHotfixClasses(file, tree, typeChecker) {
  const visit = (node) => {
    if (ts.isClassDeclaration(node)) {
      const decoratorKind = restrictedDecoratorKind(node, typeChecker);
      if (!decoratorKind) {
        ts.forEachChild(node, visit);
        return;
      }
      for (const member of node.members) {
        if (
          ts.isConstructorDeclaration(member) ||
          ts.isPropertyDeclaration(member) ||
          ts.isClassStaticBlockDeclaration(member) ||
          member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
        ) {
          errors.push(
            `${relative(file)}: ${decoratorKind}类只能声明实例方法/accessor，不能声明字段、构造函数或static成员`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
}

function restrictedDecoratorKind(node, typeChecker) {
  for (const decorator of ts.getDecorators(node) ?? []) {
    if (!ts.isCallExpression(decorator.expression)) continue;
    const name = resolvedSymbolName(decorator.expression.expression, typeChecker);
    if (systemDecorators.has(name)) return "System";
    if (handlerDecorators.has(name)) return "Handler";
  }
  return undefined;
}

function resolvedSymbolName(expression, typeChecker) {
  let symbol = typeChecker.getSymbolAtLocation(expression);
  const visited = new Set();
  while (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 && !visited.has(symbol)) {
    visited.add(symbol);
    symbol = typeChecker.getAliasedSymbol(symbol);
  }
  if (symbol) return symbol.getName();
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
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
  for (const className of ["AliasHandler", "NamespaceHandler"]) {
    if (recognized.get(className) !== "Handler") {
      throw new Error(`Hotfix decorator alias self-test failed: ${className}`);
    }
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

function isWithin(candidate, directory) {
  const value = path.relative(directory, candidate);
  return value === "" || (!value.startsWith("..") && !path.isAbsolute(value));
}

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, "/");
}

function formatDiagnostic(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}
