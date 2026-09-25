import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as developerTools from "@tiangz/developer-tools-core";
import { findMissingSelfTestWrappers } from "./verify_self_test_wrappers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArguments(process.argv.slice(2));
const configPath = path.resolve(root, options.project ?? "tsconfig.json");
const scanRoot = path.resolve(root, options.scanRoot ?? "app");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(formatDiagnostic(config.error));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath), undefined, configPath);
if (parsed.errors.length) throw new Error(parsed.errors.map(formatDiagnostic).join("\n"));
if (typeof developerTools.runtimeContractDiagnostics !== "function") {
  throw new Error("Developer Tools 缺少共享 Program 契约检查；请安装当前联合验证的 @tiangz/developer-tools-core。");
}
const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = developerTools.runtimeContractDiagnostics(program, {
  typescript: ts,
  projectRoot: root,
  coreRoot: path.join(root, "app/core"),
  sourceFiles: program.getSourceFiles().filter(source => isWithin(scanRoot, source.fileName)),
});
const failures = await findMissingSelfTestWrappers(root);
for (const diagnostic of diagnostics) {
  const { relativePath, line, character } = diagnostic.location;
  const text = `${relativePath}:${line + 1}:${character + 1}: [${diagnostic.code}] ${diagnostic.message}`;
  if (diagnostic.severity === "error") failures.push(text);
  else console.warn(`warning ${text}`);
}
if (failures.length) {
  for (const failure of failures) console.error(failure);
  console.error(`runtime contract verification failed with ${failures.length} violation(s)`);
  process.exitCode = 1;
} else {
  console.log(`runtime contract verification passed (ruleSet=${developerTools.RUNTIME_CONTRACT_RULESET_VERSION}, warnings=${diagnostics.filter(item => item.severity === "warning").length})`);
}

/** 仅选择本次指定范围，类型声明仍来自完整 Program。 / Scan the requested scope while retaining the complete type graph. */
function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** 保留编译配置错误的位置。 / Preserve compiler configuration diagnostic locations. */
function formatDiagnostic(diagnostic) {
  return ts.formatDiagnostic(diagnostic, { getCanonicalFileName: file => file, getCurrentDirectory: () => root, getNewLine: () => "\n" });
}

/** CLI 只负责工程选择与退出码，不重新实现业务规则。 / The CLI selects projects and exit codes, not rule semantics. */
function parseArguments(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--project" || argument === "--scan-root") {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a path`);
      result[argument === "--project" ? "project" : "scanRoot"] = value;
      index += 1;
    } else throw new Error(`unknown runtime contract verifier argument: ${argument}`);
  }
  return result;
}
