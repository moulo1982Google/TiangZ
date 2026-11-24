import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

// 回归 Luban/Scriban 单模板 1,048,576 字符输出上限：超过旧上限的服务端表集合必须完整生成并通过类型检查，
// 真正超限时生成器必须失败且不覆盖已发布产物，而不是以 0 退出留下截断的 schema.ts。
// Regression for the 1,048,576-character Luban/Scriban single-template output limit: a server table set
// beyond the old limit must generate completely and type-check, and a set beyond the limit must fail
// without overwriting published outputs instead of exiting 0 with a truncated schema.ts.

const root = path.resolve(import.meta.dirname, "..");
const lubanRoot = path.join(root, "tools", "third_party", "luban", "4.10.2");
const temporary = await mkdtemp(path.join(os.tmpdir(), "tiangz-module-config-limit-"));
const moduleRoot = path.join(temporary, "modules", "large");
const fieldsPerBean = 40;

try {
  await writeModule(moduleRoot);
  await writeTables(moduleRoot, 140);

  // 夹具本身必须超过旧上限：官方带注释模板会把它截断。 / The fixture must exceed the old limit.
  const official = runLubanOfficial(moduleRoot);
  assert.ok(official.trimEnd().endsWith("..."), "official template no longer truncates this fixture");

  const generated = runCodegen();
  assert.equal(generated.status, 0, generated.output);
  assert.match(generated.output, /warning: server schema\.ts has \d+ characters, \d+ left before/);
  const schemaFile = path.join(moduleRoot, "src", "model", "generated", "config", "schema.ts");
  const schema = await readFile(schemaFile, "utf8");
  assert.ok(schema.includes("this._TbBean139.resolve(this)"), "Tables.resolve is incomplete");
  assert.ok(!schema.includes("/**"), "server schema still carries comment blocks");
  assert.ok(!schema.trimEnd().endsWith("..."), "server schema is truncated");
  assertTypeChecks(schemaFile);

  const checked = runCodegen("--check");
  assert.equal(checked.status, 0, checked.output);

  await writeTables(moduleRoot, 170);
  const overflow = runCodegen();
  assert.notEqual(overflow.status, 0, "truncated schema was accepted");
  assert.match(overflow.output, /generated server schema\.ts was truncated at \d+ characters/);
  assert.equal(await readFile(schemaFile, "utf8"), schema, "failed generation replaced the published schema");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

process.stdout.write("module game config limit self-test passed\n");

async function writeModule(target) {
  await Promise.all([
    mkdir(path.join(target, "src", "model"), { recursive: true }),
    mkdir(path.join(target, "src", "hotfix"), { recursive: true }),
    mkdir(path.join(target, "game_config", "Defines"), { recursive: true }),
    mkdir(path.join(target, "game_config", "Data"), { recursive: true }),
  ]);
  const id = "org.example.large";
  await writeFile(path.join(target, "src", "model", "index.ts"),
    `import { defineGameModule } from "#tiangz/core"; defineGameModule({id: ${JSON.stringify(id)}, version: "1.0.0"});\n`);
  await writeFile(path.join(target, "src", "hotfix", "index.ts"), "export {};\n");
  await writeFile(path.join(target, "tiangz.module.json"), `${JSON.stringify({
    formatVersion: 1,
    id,
    version: "1.0.0",
    engine: { minVersion: "0.7.0", maxVersionExclusive: "0.8.0" },
    dependencies: [],
    capabilities: ["example.large"],
    entries: { model: "src/model/index.ts", hotfix: "src/hotfix/index.ts" },
    gameConfig: {
      project: "game_config/luban.conf",
      target: "server",
      generatedCode: "src/model/generated/config",
      generatedData: "game_config/generated",
    },
  }, null, 2)}\n`);
  await writeFile(path.join(target, "game_config", "luban.conf"), `${JSON.stringify({
    groups: [{ names: ["s"], default: true }],
    schemaFiles: [{ fileName: "Defines", type: "" }],
    dataDir: "Data",
    targets: [{ name: "server", manager: "Tables", groups: ["s"], topModule: "cfg" }],
    xargs: [],
  }, null, 2)}\n`);
}

// 写入 count 张带中文注释的表，每张一行数据。 / Write count commented tables with one row each.
async function writeTables(target, count) {
  let xml = "<module name=\"large\">\n";
  const data = path.join(target, "game_config", "Data");
  await rm(data, { recursive: true, force: true });
  await mkdir(data, { recursive: true });
  for (let bean = 0; bean < count; bean += 1) {
    xml += `  <bean name="Bean${bean}" comment="第${bean}个大配置结构">\n    <var name="id" type="int"/>\n`;
    const row = { id: 1 };
    for (let field = 0; field < fieldsPerBean; field += 1) {
      xml += `    <var name="field_${field}" type="string" comment="字段${field}的中文说明，用于撑大注释块"/>\n`;
      row[`field_${field}`] = "x";
    }
    xml += `  </bean>\n  <table name="TbBean${bean}" value="Bean${bean}" input="*rows@bean${bean}.json" comment="表${bean}"/>\n`;
    await writeFile(path.join(data, `bean${bean}.json`), JSON.stringify({ rows: [row] }));
  }
  await writeFile(path.join(target, "game_config", "Defines", "large.xml"), `${xml}</module>\n`);
}

function runLubanOfficial(target) {
  const code = path.join(temporary, "official-code");
  const result = spawnSync("dotnet", [path.join(lubanRoot, "Luban.dll"), "-t", "server", "-c", "typescript-json",
    "--conf", path.join(target, "game_config", "luban.conf"), "-x", `outputCodeDir=${code}`],
  { cwd: target, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return ts.sys.readFile(path.join(code, "schema.ts")).replaceAll("\r\n", "\n");
}

function runCodegen(mode) {
  const result = spawnSync(process.execPath, [
    "tools/codegen_module_game_config.mjs", "--module-root", moduleRoot, ...(mode ? [mode] : []),
  ], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

// 用严格模式完整类型检查生成的 schema.ts。 / Fully type-check the generated schema.ts in strict mode.
function assertTypeChecks(file) {
  const program = ts.createProgram([file], {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    skipLibCheck: true,
    types: [],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  }));
}
