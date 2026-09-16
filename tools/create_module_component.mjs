import path from "node:path";
import { realpath } from "node:fs/promises";
import { loadGameProject } from "./game_project_config.mjs";
import { loadGameModuleCatalog } from "./game_module_catalog.mjs";
import { acquireGameProjectLock } from "./game_project_build.mjs";
import { planModuleComponent, applyModuleComponent } from "./module_component_scaffold.mjs";

const engine = path.resolve(import.meta.dirname, "..");
let json = false;
try {
  const args = process.argv.slice(2);
  const values = new Map();
  let dryRun = false;
  while (args.length) {
    const key = args.shift();
    if (key === "--json") { json = true; continue; }
    if (key === "--dry-run") { dryRun = true; continue; }
    if (!["--project", "--module", "--name", "--feature", "--expect-plan"].includes(key) || values.has(key) || !args[0] || args[0].startsWith("--")) throw new Error(`未知、重复或不完整参数：${key}`);
    values.set(key, args.shift());
  }
  for (const key of ["--project", "--module", "--name", "--feature"]) if (!values.has(key)) throw new Error(`缺少 ${key}；例如 --project ../MyGame --module org.example.game --name Inventory --feature inventory --dry-run`);
  const project = await loadGameProject(values.get("--project"));
  if (await realpath(project.engineRoot) !== await realpath(engine)) throw new Error("请使用 tiangz.project.json 声明的 TiangZ 宿主生成组件");
  const release = dryRun ? async () => {} : await acquireGameProjectLock(project, "new-component");
  try {
    const catalog = await loadGameModuleCatalog({ projectRoot: engine, modulesDirectory: project.modulesDirectory });
    const module = catalog.modules.find(item => item.id === values.get("--module"));
    if (!module) throw new Error(`模块未安装：${values.get("--module")}；先运行 inspect 查看模块 ID`);
    const plan = await planModuleComponent(module, { name: values.get("--name"), feature: values.get("--feature") });
    if (values.has("--expect-plan") && values.get("--expect-plan") !== plan.planHash) throw new Error("预览后入口内容已变化；请重新预览，不执行过期计划");
    if (!dryRun) await applyModuleComponent(plan);
    const report = { ...plan, dryRun, changes: plan.changes.map(change => ({ file: path.relative(project.root, change.file).replaceAll("\\", "/"), operation: change.before === null ? "create" : "update", content: change.after })) };
    if (json) process.stdout.write(`${JSON.stringify(report)}\n`);
    else process.stdout.write(`[${dryRun ? "预览，未写入" : "已创建"}] ${plan.component}\n${report.changes.map(change => `${change.operation}: ${change.file}`).join("\n")}\n${plan.nextSteps.join("\n")}\n`);
  } finally { await release(); }
} catch (error) {
  if (json) process.stdout.write(`${JSON.stringify({ formatVersion: 1, error: { code: "module.scaffold.failed", message: error.message } })}\n`);
  else process.stderr.write(`[new-component] ${error.message}\n`);
  process.exitCode = 1;
}
