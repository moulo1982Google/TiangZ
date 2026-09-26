import path from "node:path";
import ts from "typescript";
import { resolveModuleApi } from "./game_module_imports.mjs";
import { verifyModuleBridge } from "./module_bridge_check.mjs";
import { hotfixClassDiagnostics } from "./hotfix_class_rules.mjs";
import * as developerTools from "@tiangz/developer-tools-core";

/** CLI 与编辑器共享宿主检查入口；当前提取保持原检查顺序。 / Shared host checker with the original diagnostic ordering. */
export function runModuleCompiler({ project, moduleId, root, catalog, modulesOnly, json = false, contractWarnings = [], createProgram = ts.createProgram }) {
  const config = ts.readConfigFile(project, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(project));
  const options = { ...parsed.options, noEmit: true };
  const host = ts.createCompilerHost(options);
  host.resolveModuleNames = (names, containingFile) => names.map((name) => {
    const owner = catalog.moduleForFile(containingFile);
    const api = resolveModuleApi(catalog, owner, name);
    if (api) return { resolvedFileName: api.publicApi.file, extension: ts.Extension.Ts };
    if (name === "#tiangz/module" && owner) {
      return { resolvedFileName: owner.entries.model, extension: ts.Extension.Ts };
    }
    if (name === "#tiangz/core" || name === "#tiangz/model") {
      return { resolvedFileName: name === "#tiangz/model" && modulesOnly ? path.join(root, "app/model/public.ts") : path.join(root, "app", name.slice("#tiangz/".length), "public.ts"), extension: ts.Extension.Ts };
    }
    if (name === "#tiangz/domains") return { resolvedFileName: path.join(root, "app/model/domains/public.ts"), extension: ts.Extension.Ts };
    return ts.resolveModuleName(name, containingFile, options, host).resolvedModule;
  });
  const publicFile = catalog.modules.find((module) => module.id === moduleId)?.publicApi?.file;
  // 将生成方法声明绑定到当前宿主，避免模块 tsconfig 引入旧 worktree 的类型身份。
  // Bind generated method declarations to the same host as the stable API.
  const declarations = modulesOnly ? [] : ts.sys.readDirectory(path.join(root, "app/generated/bootstrap/systems"), [".d.ts"]);
  if (!modulesOnly && !declarations.length) throw new Error("host system declarations missing; run npm run codegen:scenes first");
  const moduleFiles = parsed.fileNames.filter((file) =>
    isWithin(path.dirname(project), file) ||
    !file.replaceAll("\\", "/").includes("/app/generated/bootstrap/systems/"));
  const moduleDeclarations = catalog.modules.flatMap(module => module.entries.modelRoots.flatMap(directory =>
    ts.sys.readDirectory(path.join(directory, "generated/bootstrap/systems"), [".d.ts"])));
  const program = createProgram({ rootNames: [...moduleFiles, ...declarations, ...moduleDeclarations, ...(publicFile ? [publicFile] : [])], options, host });
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length) {
    throw Object.assign(new Error(`game module ${moduleId} typecheck failed:\n${ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    })}`), { diagnostics: diagnostics.map(item => {
      const position = item.file?.getLineAndCharacterOfPosition(item.start ?? 0);
      return { code: `TS${item.code}`, message: ts.flattenDiagnosticMessageText(item.messageText, "\n"),
        ...(item.file && position ? { file: item.file.fileName, line: position.line + 1, column: position.character + 1 } : {}) };
    }) });
  }
  const owner = catalog.modules.find(module => module.id === moduleId);
  if (typeof developerTools.runtimeContractDiagnostics !== "function") throw new Error("Developer Tools 缺少共享 Program 契约检查；请安装当前联合验证的 @tiangz/developer-tools-core。");
  // 复用已绑定当前宿主和 System 声明的 Program；不得重读旧宿主 tsconfig。
  // Reuse the Program bound to this host and generated System declarations.
  const contracts = developerTools.runtimeContractDiagnostics(program, {
    typescript: ts, projectRoot: owner.root, coreRoot: path.join(root, "app/core"),
    sourceFiles: program.getSourceFiles().filter(source => [...owner.entries.modelRoots, ...owner.entries.hotfixRoots].some(directory => isWithin(directory, source.fileName))),
  }).map(item => ({ code: item.code, severity: item.severity, file: path.resolve(owner.root, item.location.relativePath), line: item.location.line + 1, column: item.location.character + 1, message: item.message }));
  if (contracts.some(item => item.severity === "error")) throw Object.assign(new Error(`game module ${moduleId} runtime contracts failed:\n${contracts.map(item => `${item.file}:${item.line}:${item.column} [${item.code}] ${item.message}`).join("\n")}`), { diagnostics: contracts });
  contractWarnings.push(...contracts);
  if (!json) for (const item of contracts) process.stderr.write(`warning ${item.file}:${item.line}:${item.column} [${item.code}] ${item.message}\n`);
  if (typeof developerTools.businessTimeDiagnostics !== "function") throw new Error("Developer Tools 缺少业务时间等待检查；请更新 @tiangz/developer-tools-core 并构建，再检查模块。");
  const timeDiagnostics = program.getSourceFiles()
    .filter(source => [...owner.entries.modelRoots, ...owner.entries.hotfixRoots].some(directory => isWithin(directory, source.fileName)))
    .flatMap(source => developerTools.businessTimeDiagnostics(source.text, source.fileName).map(item => ({
      code: item.code, file: source.fileName, line: item.location.line + 1, column: item.location.character + 1, message: item.message,
    })));
  if (timeDiagnostics.length) throw Object.assign(new Error(`game module ${moduleId} 时间调度规则失败:\n${timeDiagnostics.map(item => `${item.file}:${item.line}:${item.column} [${item.code}] ${item.message}`).join("\n")}`), { diagnostics: timeDiagnostics });
  verifyModuleBridge(program, owner);
  const behaviorDiagnostics = program.getSourceFiles().filter(source => owner.entries.hotfixRoots.some(directory => isWithin(directory, source.fileName)))
    .flatMap(source => hotfixClassDiagnostics(source, program.getTypeChecker()));
  if (behaviorDiagnostics.length) throw Object.assign(new Error(`game module ${moduleId} Hotfix boundary failed:\n${behaviorDiagnostics.map(item => `${item.file}:${item.line}:${item.column} [${item.code}] ${item.message}`).join("\n")}`), { diagnostics: behaviorDiagnostics });
}


function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
