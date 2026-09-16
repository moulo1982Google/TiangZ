import { readFile, lstat, realpath, mkdir, writeFile, unlink, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { createHash } from "node:crypto";

/** 只修改可静态证明的模块入口；不猜测动态装配或组件所有者。 / Only edit statically proven module entries; never guess dynamic composition or component ownership. */
export async function planModuleComponent(module, { name, feature }) {
  const base = name?.trim().replace(/Component$/, "");
  if (!base || !/^[A-Z][A-Za-z0-9]*$/.test(base)) throw new Error("组件名必须为 PascalCase，例如 Inventory 或 InventoryComponent");
  if (!feature || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(feature) || ["generated", "node_modules", "core"].includes(feature)) throw new Error("功能目录必须是小写名称，例如 inventory；不能使用生成目录或 Core 目录");
  const component = `${base}Component`;
  const modelEntry = module.entries.model;
  const hotfixEntry = module.entries.hotfix;
  const modelFile = path.join(path.dirname(modelEntry), feature, `${component}.ts`);
  const systemFile = path.join(path.dirname(hotfixEntry), feature, `${component}System.ts`);
  const generatedRoots = [module.protocol?.serverOutput, module.gameConfig?.generatedCode, module.native?.generatedTypeScript].filter(Boolean);
  for (const file of [modelEntry, hotfixEntry, modelFile, systemFile]) if (generatedRoots.some(root => {
    const relative = path.relative(root, file);
    return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
  })) throw new Error(`不修改声明的生成目录：${file}`);
  for (const file of [modelEntry, hotfixEntry, modelFile, systemFile]) await safePath(module.root, file);
  for (const file of [modelFile, systemFile]) if (await exists(file)) throw new Error(`目标已存在，不覆盖：${file}`);
  const model = await readFile(modelEntry, "utf8");
  const hotfix = await readFile(hotfixEntry, "utf8");
  const tree = ts.createSourceFile(modelEntry, model, ts.ScriptTarget.Latest, true);
  const hotfixTree = ts.createSourceFile(hotfixEntry, hotfix, ts.ScriptTarget.Latest, true);
  if (tree.parseDiagnostics.length || hotfixTree.parseDiagnostics.length) throw new Error("入口存在语法错误；先修复后再生成组件");
  const forbidden = new Set([component, `${component}System`]);
  function rejectCollision(node) {
    if (ts.isIdentifier(node) && forbidden.has(node.text)) throw new Error(`入口已经引用 ${node.text}；请检查现有组件，不自动重复登记`);
    ts.forEachChild(node, rejectCollision);
  }
  rejectCollision(tree); rejectCollision(hotfixTree);
  const imports = new Set();
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== "#tiangz/core" || statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
      if (!item.isTypeOnly && (item.propertyName?.text ?? item.name.text) === "defineGameModule") imports.add(item.name.text);
    }
  }
  const definitions = tree.statements.filter(statement => ts.isExpressionStatement(statement)
    && ts.isCallExpression(statement.expression) && ts.isIdentifier(statement.expression.expression)
    && imports.has(statement.expression.expression.text)).map(statement => statement.expression);
  if (definitions.length !== 1 || definitions[0].arguments.length !== 1 || !ts.isObjectLiteralExpression(definitions[0].arguments[0])) throw new Error("只支持顶层 defineGameModule({...}) 字面量入口；动态定义请手工登记组件");
  const definition = definitions[0].arguments[0];
  if (definition.properties.some(item => item.name && ts.isComputedPropertyName(item.name))) throw new Error("模块定义存在计算属性，无法安全自动修改");
  const property = name => {
    const matches = definition.properties.filter(item => item.name && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === name);
    if (matches.length > 1 || matches[0] && !ts.isPropertyAssignment(matches[0])) throw new Error(`${name} 必须是唯一字面量属性`);
    return matches[0]?.initializer;
  };
  const exports = property("modelExports");
  const systems = property("requiredSystems");
  if (!exports || !ts.isObjectLiteralExpression(exports) || exports.properties.some(ts.isSpreadAssignment)) throw new Error("modelExports 必须是无展开的对象字面量；无法安全自动修改");
  if (systems && (!ts.isArrayLiteralExpression(systems) || systems.elements.some(ts.isSpreadElement))) throw new Error("requiredSystems 必须是无展开的数组字面量；无法安全自动修改");
  // ModuleIdentity spread is safe only before explicit properties; later spreads can override edited registrations.
  const exportsIndex = definition.properties.findIndex(item => item.initializer === exports);
  const systemsIndex = systems ? definition.properties.findIndex(item => item.initializer === systems) : definition.properties.length;
  if (definition.properties.some((item, index) => ts.isSpreadAssignment(item) && (index > exportsIndex || index > systemsIndex))) throw new Error("登记属性后存在展开项，可能覆盖 modelExports/requiredSystems；请先改为明确属性");
  const newline = model.includes("\r\n") ? "\r\n" : "\n";
  const edits = [];
  function append(node, items, text) {
    edits.push({ at: node.end - 1, text: `${newline}    ${text},${newline}  ` });
    if (items.length && !items.hasTrailingComma) edits.push({ at: items.at(-1).end, text: "," });
  }
  append(exports, exports.properties, component);
  if (systems) append(systems, systems.elements, component);
  else append(definition, definition.properties, `requiredSystems: [${component}]`);
  let nextModel = model;
  for (const edit of edits.sort((left, right) => right.at - left.at)) nextModel = nextModel.slice(0, edit.at) + edit.text + nextModel.slice(edit.at);
  nextModel = `import { ${component} } from "./${feature}/${component}";${newline}export { ${component} };${newline}${nextModel}`;
  const hotfixNewline = hotfix.includes("\r\n") ? "\r\n" : "\n";
  const nextHotfix = `${hotfix}${hotfix.endsWith("\n") ? "" : hotfixNewline}import "./${feature}/${component}System";${hotfixNewline}`;
  const changes = [
    { file: modelFile, before: null, after: `import { Component, component } from "#tiangz/core";\n\n/** 本模块拥有的状态；由业务显式选择 Scene/Entity 所有者。 / Module-owned state; business explicitly chooses its Scene/Entity owner. */\n@component()\nexport class ${component} extends Component {}\n` },
    { file: systemFile, before: null, after: `import { systemFor } from "#tiangz/model";\nimport { ${component} } from "#tiangz/module";\n\n/** 可热更行为；实例字段和构造函数必须放回 Model。 / Hot-reloadable behavior; fields and constructors belong in Model. */\n@systemFor(${component})\nexport class ${component}System extends ${component} {}\n` },
    { file: modelEntry, before: model, after: nextModel },
    { file: hotfixEntry, before: hotfix, after: nextHotfix },
  ];
  for (const change of changes) if (ts.createSourceFile(change.file, change.after, ts.ScriptTarget.Latest, true).parseDiagnostics.length) throw new Error("生成预览未通过语法检查；没有修改文件");
  const planHash = createHash("sha256").update(JSON.stringify(changes)).digest("hex");
  return { formatVersion: 1, planHash, moduleId: module.id, moduleRoot: module.root, component, feature, changes,
    nextSteps: ["在 Model 声明状态和稳定方法，在 System 实现方法", "在明确的 Scene/Entity 生命周期中 AddComponent；工具未自动装配", "运行 npm run check 和 npm run build；新增 Model 需要重启"] };
}

/** 保留恢复副本，普通失败按内容校验回滚；检测到并发编辑则停止，不保证跨进程原子性。 / Keep recovery copies and stop rollback on detected edits; cross-process atomicity is not guaranteed. */
export async function applyModuleComponent(plan) {
  for (const change of plan.changes) {
    await safePath(plan.moduleRoot, change.file);
    const current = await readFile(change.file, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (current !== change.before) throw new Error(`预览后文件已变化，取消生成：${change.file}`);
  }
  const backup = await mkdtemp(path.join(plan.moduleRoot, ".tiangz-scaffold-"));
  await writeFile(path.join(backup, "recovery.json"), JSON.stringify(plan, null, 2));
  const written = [];
  let cleanup = true;
  try {
    for (const change of plan.changes) {
      await safePath(plan.moduleRoot, change.file);
      await mkdir(path.dirname(change.file), { recursive: true });
      const current = await readFile(change.file, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (current !== change.before) throw new Error(`文件已被其他操作修改：${change.file}`);
      written.push(change);
      await writeFile(change.file, change.after, { encoding: "utf8", flag: change.before === null ? "wx" : "w" });
    }
  } catch (error) {
    try {
      for (const change of written.reverse()) {
        const current = await readFile(change.file, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
        if (current === change.before) continue;
        if (current !== change.after) throw new Error(`回滚时发现并发编辑或写入未完成：${change.file}`);
        if (change.before === null) await unlink(change.file);
        else await writeFile(change.file, change.before, "utf8");
      }
    } catch (rollbackError) {
      cleanup = false;
      throw new AggregateError([error, rollbackError], `未覆盖并发编辑；恢复副本保留在 ${backup}：${rollbackError.message}`);
    }
    throw error;
  } finally { if (cleanup) await rm(backup, { recursive: true, force: true }); }
}

async function exists(file) { return lstat(file).catch(error => { if (error.code === "ENOENT") return undefined; throw error; }); }
async function safePath(root, file) {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("组件文件必须位于模块内部");
  let current = root;
  const realRoot = await realpath(root);
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const info = await exists(current);
    if (!info) continue;
    if (info.isSymbolicLink()) throw new Error(`不修改链接路径：${current}`);
    const resolved = path.relative(realRoot, await realpath(current));
    if (resolved.startsWith("..") || path.isAbsolute(resolved)) throw new Error("组件路径逃逸模块目录");
  }
}
