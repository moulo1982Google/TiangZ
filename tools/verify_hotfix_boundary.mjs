import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const hotfixRoot = path.join(root, "app", "hotfix");
const modelRoots = [
  path.join(root, "app", "core"),
  path.join(root, "app", "model"),
  path.join(root, "app", "generated", "model"),
  path.join(root, "app", "generated", "bootstrap"),
];
const errors = [];

for (const file of await collect(hotfixRoot)) {
  const source = await readFile(file, "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  inspectImports(file, tree, true);
  inspectHotfixClasses(file, tree);
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

function inspectHotfixClasses(file, tree) {
  const visit = (node) => {
    if (ts.isClassDeclaration(node) && hasHotfixDecorator(node)) {
      for (const member of node.members) {
        if (
          ts.isConstructorDeclaration(member) ||
          ts.isPropertyDeclaration(member) ||
          ts.isClassStaticBlockDeclaration(member) ||
          member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
        ) {
          errors.push(`${relative(file)}: System类只能声明实例方法/accessor，不能声明字段、构造函数或static成员`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
}

function hasHotfixDecorator(node) {
  return ts.getDecorators(node)?.some((decorator) =>
    ts.isCallExpression(decorator.expression) &&
    ts.isIdentifier(decorator.expression.expression) &&
    ["hotfixFor", "systemFor"].includes(decorator.expression.expression.text)
  ) ?? false;
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
