import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { loadGameModuleCatalog } from "./game_module_catalog.mjs";

const declarationKinds = new Set(["entryScene", "scene", "actor", "component"]);
const descriptorBindings = new Set(["rpcHandler", "messageHandler", "sessionRpcHandler", "sessionMessageHandler", "unitRpcHandler", "unitMessageHandler", "syncEventHandler", "vetoEventHandler"]);
const bindingKinds = new Set(["systemFor", "hotfixFor", "entityExtensionHandler", ...descriptorBindings]);

/** 从合法模块目录生成只读导航；不执行模块、不代替类型与兼容检查。 / Build read-only navigation without executing modules or replacing validation. */
export async function inspectGameModules(options) {
  const catalog = await loadGameModuleCatalog(options);
  const modules = [];
  for (const module of catalog.modules) modules.push(await inspectModule(module));
  return {
    formatVersion: 1,
    engineVersion: catalog.engineVersion,
    modulesDirectory: catalog.directory,
    graphHash: catalog.graphHash,
    limitations: [
      "这是静态导航，不是类型检查、完整调用图或热更许可。",
      "只跟踪静态相对 import/export；动态加载和间接装饰器不推断。",
      "文件可达不等于声明必定执行；条件注册仍须运行时验证。",
    ],
    modules,
  };
}

async function inspectModule(module) {
  const files = new Map();
  for (const [layer, roots] of [["model", module.entries.modelRoots], ["hotfix", module.entries.hotfixRoots]]) {
    for (const root of roots) await collect(root, layer);
  }
  const declarations = [];
  const bindings = [];
  const diagnostics = [];
  const edges = new Map();
  const symbols = new Map();
  const pendingTargets = new Map();
  for (const [file, details] of files) {
    const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
    const aliases = new Map();
    const namespaces = new Set();
    const references = [];
    const fileSymbols = { definitions: new Map(), imports: new Map(), exports: new Map(), stars: [] };
    symbols.set(file, fileSymbols);
    edges.set(file, references);
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const name = statement.moduleSpecifier.text;
        const imported = statement.importClause?.namedBindings;
        if (!statement.importClause?.isTypeOnly && imported) {
          if (ts.isNamedImports(imported)) for (const item of imported.elements) {
            if (!item.isTypeOnly) fileSymbols.imports.set(item.name.text, { source: name, name: (item.propertyName ?? item.name).text });
          }
          else if (ts.isNamespaceImport(imported)) fileSymbols.imports.set(imported.name.text, { source: name, name: "*" });
        }
        if (!statement.importClause?.isTypeOnly && hasRuntimeImport(statement.importClause)) addReference(name);
        if (name === "#tiangz/core" || name === "#tiangz/model") {
          const imported = statement.importClause?.namedBindings;
          if (imported && ts.isNamedImports(imported)) {
            for (const item of imported.elements) if (!item.isTypeOnly) aliases.set(item.name.text, (item.propertyName ?? item.name).text);
          } else if (imported && ts.isNamespaceImport(imported)) namespaces.add(imported.name.text);
        }
      }
      if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        if (!statement.exportClause || !ts.isNamedExports(statement.exportClause) || statement.exportClause.elements.some(item => !item.isTypeOnly)) addReference(statement.moduleSpecifier.text);
      }
      if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
        const from = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const item of statement.exportClause.elements) if (!item.isTypeOnly) fileSymbols.exports.set(item.name.text, { source: from, name: (item.propertyName ?? item.name).text });
        } else if (!statement.exportClause && from) fileSymbols.stars.push(from);
      }
      if (ts.isClassDeclaration(statement) && statement.name) {
        fileSymbols.definitions.set(statement.name.text, locate(source, statement.name.getStart(source)));
        if (statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) fileSymbols.exports.set(statement.name.text, { name: statement.name.text });
      }
    }
    for (const diagnostic of source.parseDiagnostics) diagnostics.push({
      code: "module.syntax", severity: "warning",
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      location: locate(source, diagnostic.start ?? 0),
    });
    visit(source);

    function addReference(name) {
      if (!name.startsWith(".")) return;
      const resolved = resolveSource(path.resolve(path.dirname(file), name), files);
      if (resolved) references.push(resolved);
    }
    function visit(node) {
      if (ts.isClassDeclaration(node) && node.name) {
        for (const decorator of ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : []) {
          const expression = decorator.expression;
          const callee = ts.isCallExpression(expression) ? expression.expression : expression;
          const name = ts.isIdentifier(callee) ? aliases.get(callee.text)
            : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && namespaces.has(callee.expression.text) ? callee.name.text : undefined;
          const args = ts.isCallExpression(expression) ? expression.arguments : [];
          const record = {
            name: node.name.text, kind: name, layer: details.layer,
            generated: details.generated, location: locate(source, node.name.getStart(source)),
          };
          if (declarationKinds.has(name)) declarations.push(record);
          if (bindingKinds.has(name)) {
            const binding = { ...record,
              target: args[0]?.getText(source) ?? "",
              ...(descriptorBindings.has(name) ? { descriptor: args[1]?.getText(source) ?? "" } : {}),
            };
            bindings.push(binding);
            const target = args[0];
            if (node.parent === source && target && ts.isIdentifier(target)) pendingTargets.set(binding, { file, name: target.text });
            else if (node.parent === source && target && ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)) {
              const imported = fileSymbols.imports.get(target.expression.text);
              if (imported?.name === "*") pendingTargets.set(binding, { file: sourceFile(file, imported.source), name: target.name.text, exported: true });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }
  }
  const reached = new Set();
  for (const binding of bindings) {
    const reference = pendingTargets.get(binding);
    const location = reference?.file && resolveSymbol(reference.file, reference.name, reference.exported ?? false, new Set());
    binding.targetResolution = location ? "local" : "unresolved";
    if (location) binding.targetLocation = location;
  }
  for (const entry of [module.entries.model, module.entries.hotfix]) walk(entry);
  for (const item of [...declarations, ...bindings]) {
    item.reachable = reached.has(path.resolve(module.root, item.location.file));
    if (!item.reachable && !item.generated) diagnostics.push({
      code: "module.navigation.unreachable", severity: "warning",
      message: `${item.name} 未通过静态值导入/导出连接到模块入口；检查对应 index.ts。动态装配需人工核对。`,
      location: item.location,
    });
  }
  return {
    id: module.id, version: module.version, description: module.description, root: module.root,
    manifest: "tiangz.module.json", dependencies: module.dependencies,
    entries: { model: module.entries.modelRelative, hotfix: module.entries.hotfixRelative },
    publicApi: module.publicApi?.relative ?? null,
    protocol: module.protocol?.relative ?? null,
    gameConfig: module.gameConfig?.relative ?? null,
    declarations, bindings, diagnostics,
    files: [...files].map(([file, details]) => ({ file: relative(file), ...details, reachable: reached.has(file) })),
  };

  function walk(file) {
    if (reached.has(file)) return;
    reached.add(file);
    for (const reference of edges.get(file) ?? []) walk(reference);
  }
  function sourceFile(file, specifier) {
    if (specifier === "#tiangz/module") return module.entries.model;
    return specifier?.startsWith(".") ? resolveSource(path.resolve(path.dirname(file), specifier), files) : undefined;
  }
  function resolveSymbol(file, name, exported, visited) {
    const key = `${file}:${name}:${exported}`;
    if (visited.has(key)) return undefined;
    visited = new Set([...visited, key]);
    const info = symbols.get(file);
    if (!info) return undefined;
    if (!exported) {
      if (info.definitions.has(name)) return info.definitions.get(name);
      const imported = info.imports.get(name);
      const target = imported && sourceFile(file, imported.source);
      return target ? resolveSymbol(target, imported.name, true, visited) : undefined;
    }
    const entry = info.exports.get(name);
    if (entry) {
      if (!entry.source) return resolveSymbol(file, entry.name, false, visited);
      const target = sourceFile(file, entry.source);
      return target ? resolveSymbol(target, entry.name, true, visited) : undefined;
    }
    if (info.stars.some(source => !sourceFile(file, source))) return undefined;
    const candidates = info.stars.flatMap(source => {
      const target = sourceFile(file, source);
      const location = target && resolveSymbol(target, name, true, visited);
      return location ? [location] : [];
    });
    const unique = new Map(candidates.map(location => [`${location.file}:${location.line}:${location.column}`, location]));
    return unique.size === 1 ? unique.values().next().value : undefined;
  }
  function relative(file) { return path.relative(module.root, file).replaceAll("\\", "/"); }
  function locate(source, position) {
    const { line, character } = source.getLineAndCharacterOfPosition(position);
    return { file: relative(source.fileName), line: line + 1, column: character + 1 };
  }
  async function collect(directory, layer) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`module navigation refuses source symlink: ${file}`);
      if (entry.isDirectory()) await collect(file, layer);
      else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        const generatedRoots = [module.protocol?.serverOutput, module.gameConfig?.generatedCode, module.native?.generatedTypeScript].filter(Boolean);
        files.set(file, { layer, generated: generatedRoots.some(root => isWithin(root, file)) });
      }
    }
  }
}

function hasRuntimeImport(clause) {
  if (!clause || clause.name) return true;
  const bindings = clause.namedBindings;
  return !bindings || ts.isNamespaceImport(bindings) || bindings.elements.some(item => !item.isTypeOnly);
}

function resolveSource(base, files) {
  const stripped = /\.[cm]?js$/.test(base) ? base.replace(/\.[cm]?js$/, "") : base;
  return [base, `${stripped}.ts`, `${stripped}.tsx`, path.join(base, "index.ts")].find(file => files.has(file));
}

function isWithin(root, file) {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
