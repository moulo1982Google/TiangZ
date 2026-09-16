import path from "node:path";
import { inspectGameModules } from "./module_inspector.mjs";

const args = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, "..");
let json = false;
try {
  let directory = process.env.TIANGZ_MODULES_DIR ?? path.join(root, "modules");
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") json = true;
    else if (arg === "--modules-dir" && args[index + 1] && !args[index + 1].startsWith("--")) directory = args[++index];
    else if (arg.startsWith("--modules-dir=") && arg.slice(14)) directory = arg.slice(14);
    else throw new Error(`unknown or incomplete argument: ${arg}`);
  }
  const report = await inspectGameModules({ projectRoot: root, modulesDirectory: path.resolve(root, directory) });
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    process.stdout.write(`TiangZ 模块导航 (${report.modules.length})\n`);
    for (const module of report.modules) {
      process.stdout.write(`\n${module.id}@${module.version}\n  ${module.description}\n  Model: ${module.entries.model}\n  Hotfix: ${module.entries.hotfix}\n  Public API: ${module.publicApi ?? "未公开"}\n`);
      for (const item of [...module.declarations, ...module.bindings]) process.stdout.write(`  ${item.kind} ${item.name}${item.target ? ` -> ${item.target}` : ""}  ${item.location.file}:${item.location.line}${item.reachable ? "" : " [未静态连接入口]"}\n`);
      for (const item of module.diagnostics) process.stdout.write(`  ${item.code}: ${item.message}\n`);
    }
    process.stdout.write(`\n${report.limitations.join("\n")}\n`);
  }
} catch (error) {
  if (json || args.includes("--json")) process.stdout.write(`${JSON.stringify({ formatVersion: 1, error: { code: "module.inspect.failed", message: error.message } })}\n`);
  else process.stderr.write(`模块导航失败：${error.message}\n`);
  process.exitCode = 1;
}
