import ts from "typescript";
import { coreSymbolName } from "./core_type_symbols.mjs";

const systemDecorators = new Set(["hotfixFor", "systemFor"]);
const handlerDecorators = new Set(["messageHandler", "rpcHandler", "sessionMessageHandler", "sessionRpcHandler", "unitMessageHandler", "unitRpcHandler", "syncEventHandler", "vetoEventHandler", "entityExtensionHandler"]);

/** 同一行为类规则供宿主边界校验和模块构建前置检查复用。 / Share behavior-class rules between host validation and module build preflight. */
export function hotfixClassDiagnostics(tree, typeChecker) {
  const diagnostics = [];
  visit(tree);
  return diagnostics;
  function visit(node) {
    if (ts.isClassDeclaration(node)) {
      const kind = restrictedDecoratorKind(node, typeChecker);
      if (kind) for (const member of node.members) {
        if (ts.isConstructorDeclaration(member) || ts.isPropertyDeclaration(member) || ts.isClassStaticBlockDeclaration(member)
          || member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)) {
          const position = tree.getLineAndCharacterOfPosition(member.getStart(tree));
          diagnostics.push({ code: "tiangz.hotfix.instance-state", file: tree.fileName, line: position.line + 1, column: position.character + 1,
            message: `${kind}类只能声明实例方法/accessor，不能声明字段、构造函数或static成员；将状态放回对应 Model 的 Scene/Entity/Component。` });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
}

export function restrictedDecoratorKind(node, typeChecker) {
  for (const decorator of ts.getDecorators(node) ?? []) {
    if (!ts.isCallExpression(decorator.expression)) continue;
    const name = coreSymbolName(decorator.expression.expression, typeChecker);
    if (systemDecorators.has(name)) return "System";
    if (handlerDecorators.has(name)) return "Handler";
  }
  return undefined;
}
