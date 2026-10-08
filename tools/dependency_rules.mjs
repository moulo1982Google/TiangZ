import path from "node:path";
import ts from "typescript";
import * as developerTools from "@tiangz/developer-tools-core";
import { resolveModuleApi } from "./game_module_imports.mjs";

if (typeof developerTools.programDependencyDiagnostics !== "function" || developerTools.DEPENDENCY_RULESET_VERSION !== 1) {
  throw new Error("Developer Tools 缺少共享依赖规则；请安装当前联合验证的 @tiangz/developer-tools-core（dependency ruleset 1）。");
}

/** 构造宿主边界检查 Program；调用者已有 Program 时直接复用。 / Construct a host boundary Program; callers with a Program reuse it instead. */
export function createDependencyProgram(root) {
  const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  if (parsed.errors.length) throw new Error(parsed.errors.map(item => ts.flattenDiagnosticMessageText(item.messageText, "\n")).join("\n"));
  return ts.createProgram(parsed.fileNames, parsed.options);
}

/** 只适配宿主清单与位置；依赖方向的唯一规则在 Developer Tools。 / Adapt host manifests and locations; Developer Tools owns all dependency policy. */
export function dependencyDiagnostics(program, sourceFiles, { root, catalog, module }) {
  const projectRoot = module?.root ?? root;
  return developerTools.programDependencyDiagnostics(program, {
    typescript: ts, projectRoot, sourceFiles,
    ...(module ? { module: {
      modelRoots: module.entries.modelRoots, hotfixRoots: module.entries.hotfixRoots,
      modelEntry: module.entries.model, coreRoot: path.join(root, "app/core"),
      ...(module.protocol ? { protocolRoot: module.protocol.serverOutput } : {}),
      resolvePublicApi: name => resolveModuleApi(catalog, module, name)?.publicApi.file,
    } } : {}),
  }).map(item => ({ code: item.code, severity: item.severity, file: path.resolve(projectRoot, item.location.relativePath),
    line: item.location.line + 1, column: item.location.character + 1, message: item.message }));
}
