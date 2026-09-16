import path from "node:path";
import ts from "typescript";

const core = path.resolve(import.meta.dirname, "../app/core");

/** 以当前宿主 Core 的声明来源确认身份，不按同名业务函数猜测。 / Identify declarations from this host's Core instead of guessing from same-named business functions. */
export function isCoreDeclaration(declaration) {
  if (!declaration) return false;
  const relative = path.relative(core, declaration.getSourceFile().fileName);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function coreSymbolName(expression, checker) {
  let symbol = checker.getSymbolAtLocation(expression);
  const visited = new Set();
  while (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 && !visited.has(symbol)) {
    visited.add(symbol);
    symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol?.declarations?.some(isCoreDeclaration) ? symbol.getName() : undefined;
}
