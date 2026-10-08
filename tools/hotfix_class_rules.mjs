import path from "node:path";
import ts from "typescript";
import * as developerTools from "@tiangz/developer-tools-core";

const root = path.resolve(import.meta.dirname, "..");
const options = { typescript: ts, projectRoot: root, coreRoot: path.join(root, "app/core") };
if (typeof developerTools.hotfixClassDiagnostics !== "function" || typeof developerTools.restrictedHotfixDecoratorKind !== "function") {
  throw new Error("Developer Tools 缺少共享 Hotfix 契约检查；请安装当前联合验证的 @tiangz/developer-tools-core（ruleset >= 2）。");
}

/** 仅适配宿主既有的 1-based 位置，成员禁令由共享库维护。 / Adapt existing host locations; the shared library owns the restrictions. */
export function hotfixClassDiagnostics(tree, typeChecker) {
  return developerTools.hotfixClassDiagnostics(tree, typeChecker, options).map(item => ({
    code: item.code, severity: item.severity, file: tree.fileName,
    line: item.location.line + 1, column: item.location.character + 1, message: item.message,
  }));
}

export function restrictedDecoratorKind(node, typeChecker) {
  return developerTools.restrictedHotfixDecoratorKind(node, typeChecker, options);
}
