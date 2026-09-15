import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { loadGameModuleCatalog } from "./game_module_catalog.mjs";
import { resolveModuleApi } from "./game_module_imports.mjs";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const modulesArgument = argumentValue("--modules-dir") ?? process.env.TIANGZ_MODULES_DIR;
const catalog = await loadGameModuleCatalog({
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

process.stdout.write(`game module typecheck passed: modules=${catalog.modules.length}\n`);

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
      return { resolvedFileName: path.join(root, "app", name.slice("#tiangz/".length), "public.ts"), extension: ts.Extension.Ts };
    }
    return ts.resolveModuleName(name, containingFile, options, host).resolvedModule;
  });
  const publicFile = catalog.modules.find((module) => module.id === moduleId)?.publicApi?.file;
  // 将生成方法声明绑定到当前宿主，避免模块 tsconfig 引入旧 worktree 的类型身份。
  // Bind generated method declarations to the same host as the stable API.
  const declarations = ts.sys.readDirectory(path.join(root, "app/generated/bootstrap/systems"), [".d.ts"]);
  if (!declarations.length) throw new Error("host system declarations missing; run npm run codegen:scenes first");
  const moduleFiles = parsed.fileNames.filter((file) =>
    isWithin(path.dirname(project), file) ||
    !file.replaceAll("\\", "/").includes("/app/generated/bootstrap/systems/"));
  const program = ts.createProgram({ rootNames: [...moduleFiles, ...declarations, ...(publicFile ? [publicFile] : [])], options, host });
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length) {
    throw new Error(`game module ${moduleId} typecheck failed:\n${ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    })}`);
  }
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
