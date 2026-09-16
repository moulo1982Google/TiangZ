import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { loadGameModuleCatalog } from "./game_module_catalog.mjs";
import { resolveModuleApi } from "./game_module_imports.mjs";
import ts from "typescript";
import { verifyModuleBridge } from "./module_bridge_check.mjs";
import { resolveHostProfile } from "./host_profile.mjs";
import { hotfixClassDiagnostics } from "./hotfix_class_rules.mjs";
const root = path.resolve(import.meta.dirname, "..");
let modulesOnly;
let catalog;
const json = process.argv.includes("--json");
try {
  modulesOnly = resolveHostProfile() === "modules";
  const modulesArgument = argumentValue("--modules-dir") ?? process.env.TIANGZ_MODULES_DIR;
  catalog = await loadGameModuleCatalog({
    projectRoot: root,
    modulesDirectory: modulesArgument
      ? path.resolve(root, modulesArgument)
      : path.join(root, "modules"),
  });

  for (const module of catalog.modules) {
    const project = path.join(module.root, "tsconfig.json");
    const details = await lstat(project).catch((error) => {
      throw new Error(`game module ${module.id} is missing tsconfig.json: ${project}`, {
        cause: error,
      });
    });
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new Error(`game module ${module.id} tsconfig.json must be a regular file`);
    }
    const realProject = await realpath(project);
    if (!isWithin(module.realRoot, realProject)) {
      throw new Error(`game module ${module.id} tsconfig.json escapes the module root`);
    }
    await runCompiler(project, module.id);
  }

  process.stdout.write(json ? `${JSON.stringify({ formatVersion: 1, ok: true, modules: catalog.modules.map(module => module.id), diagnostics: [] })}\n` : `game module typecheck passed: modules=${catalog.modules.length}\n`);
} catch (error) {
  if (json) process.stdout.write(`${JSON.stringify({ formatVersion: 1, ok: false, diagnostics: error.diagnostics ?? [{ code: "tiangz.module.typecheck", message: error.message }] })}\n`);
  else process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

function runCompiler(project, moduleId) {
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
  const program = ts.createProgram({ rootNames: [...moduleFiles, ...declarations, ...moduleDeclarations, ...(publicFile ? [publicFile] : [])], options, host });
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
  verifyModuleBridge(program, owner);
  const behaviorDiagnostics = program.getSourceFiles().filter(source => owner.entries.hotfixRoots.some(directory => isWithin(directory, source.fileName)))
    .flatMap(source => hotfixClassDiagnostics(source, program.getTypeChecker()));
  if (behaviorDiagnostics.length) throw Object.assign(new Error(`game module ${moduleId} Hotfix boundary failed:\n${behaviorDiagnostics.map(item => `${item.file}:${item.line}:${item.column} [${item.code}] ${item.message}`).join("\n")}`), { diagnostics: behaviorDiagnostics });
}

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function argumentValue(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
