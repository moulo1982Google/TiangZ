import ts from "typescript";
import { isCoreDeclaration } from "./core_type_symbols.mjs";

// 提前检查命名值导入是否登记到运行时桥。 / Check named value imports against the registered runtime bridge.
export function verifyModuleBridge(program, module) {
  const checker = program.getTypeChecker();
  const entry = program.getSourceFile(module.entries.model);
  if (!entry) return;
  // 仅接受唯一、直接的顶层登记，不把未调用函数或条件分支当作执行结果。 / Do not infer execution from unused functions or conditional registrations.
  const registrations = entry.statements.flatMap(statement => {
    if (!ts.isExpressionStatement(statement)) return [];
    let node = statement.expression;
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
    if (!ts.isCallExpression(node) || !node.arguments.length) return [];
    const declaration = checker.getResolvedSignature(node)?.declaration;
    return declaration?.name?.getText() === "defineGameModule" && isCoreDeclaration(declaration) ? [node] : [];
  });
  if (registrations.length !== 1) return;
  const registration = registrations[0];
  const definition = checker.getTypeAtLocation(registration.arguments[0]);
  const exports = definition.getProperty("modelExports");
  const exportsType = exports && checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(exports, registration.arguments[0]));
  // 宽泛字典或多个候选导出形状无法确定，保留运行时校验。 / Leave opaque dictionaries and alternative export shapes to runtime validation.
  if (exportsType?.getStringIndexType() || exportsType?.isUnion()) return;
  const registered = new Set(exportsType?.getProperties().map(p => p.name) ?? []);
  for (const source of program.getSourceFiles()) {
    if (!module.entries.hotfixRoots.some(root => source.fileName.replaceAll("\\", "/").startsWith(root.replaceAll("\\", "/") + "/"))) continue;
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) || node.moduleSpecifier.text !== "#tiangz/module" || node.importClause?.isTypeOnly) continue;
      const bindings = node.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const item of bindings.elements) {
        if (item.isTypeOnly) continue;
        const symbol = checker.getSymbolAtLocation(item.name);
        const target = symbol && checker.getAliasedSymbol(symbol);
        if (!target || !(target.flags & ts.SymbolFlags.Value)) continue;
        const name = (item.propertyName ?? item.name).text;
        if (!registered.has(name)) {
          const { line, character } = source.getLineAndCharacterOfPosition(item.getStart());
          const message = `${module.id} runtime bridge is missing ${name}; add it to defineGameModule.modelExports, or use import type for type-only usage`;
          const diagnostic = { code: "tiangz.module.bridge-missing", file: source.fileName, line: line + 1, column: character + 1, message };
          throw Object.assign(new Error(`${diagnostic.file}:${diagnostic.line}:${diagnostic.column} [${diagnostic.code}] ${message}`), { diagnostics: [diagnostic] });
        }
      }
    }
  }
}
