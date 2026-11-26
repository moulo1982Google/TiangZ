import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

// 回归 Luban/Scriban 单模板 1,048,576 字符输出上限：超过旧上限的服务端与客户端表集合必须完整生成并通过
// 类型检查；任一目标真正超限时生成器必须失败且两端已发布产物都不被覆盖，而不是以 0 退出留下截断的 schema.ts。
// Regression for the 1,048,576-character Luban/Scriban single-template output limit: server and client table
// sets beyond the old limit must generate completely and type-check, and when either target exceeds the
// limit the generator must fail without overwriting any published output instead of exiting 0 with a
// truncated schema.ts.

const root = path.resolve(import.meta.dirname, "..");
const lubanRoot = path.join(root, "tools", "third_party", "luban", "4.10.2");
const temporary = await mkdtemp(path.join(os.tmpdir(), "tiangz-module-config-limit-"));
const moduleRoot = path.join(temporary, "modules", "large");
const fieldsPerBean = 40;

try {
  await writeModule(moduleRoot);
  await writeTables(moduleRoot, 140);

  // 夹具本身必须超过旧上限：官方带注释模板会把两个目标都截断。 / The fixture must exceed the old limit on both targets.
  for (const target of ["server", "client"]) {
    const official = runLubanOfficial(moduleRoot, target);
    assert.ok(official.trimEnd().endsWith("..."), `official template no longer truncates the ${target} fixture`);
  }

  const generated = runCodegen();
  assert.equal(generated.status, 0, generated.output);
  assert.match(generated.output, /warning: server schema\.ts has \d+ characters, \d+ left before/);
  assert.match(generated.output, /warning: client schema\.ts has \d+ characters, \d+ left before/);
  const schemaFile = path.join(moduleRoot, "src", "model", "generated", "config", "schema.ts");
  const clientSchemaFile = path.join(moduleRoot, "generated", "client", "code", "schema.ts");
  const schema = await readFile(schemaFile, "utf8");
  const clientSchema = await readFile(clientSchemaFile, "utf8");
  for (const [target, text] of [["server", schema], ["client", clientSchema]]) {
    assert.ok(text.includes("this._TbBean139.resolve(this)"), `${target} Tables.resolve is incomplete`);
    assert.ok(!text.includes("/**"), `${target} schema still carries comment blocks`);
    assert.ok(!text.trimEnd().endsWith("..."), `${target} schema is truncated`);
  }
  assertTypeChecks(schemaFile);
  assertTypeChecks(clientSchemaFile);

  const checked = runCodegen("--check");
  assert.equal(checked.status, 0, checked.output);

  // 只有客户端超限：服务端 140 张仍可生成，但整次生成必须失败且两端产物都不变。
  // Only the client overflows: the 140 server tables still fit, yet the whole run must fail and keep both outputs.
  await writeTables(moduleRoot, 140, 30);
  const clientOverflow = runCodegen();
  assert.notEqual(clientOverflow.status, 0, "truncated client schema was accepted");
  assert.match(clientOverflow.output, /generated client schema\.ts was truncated at \d+ characters/);
  assert.equal(await readFile(schemaFile, "utf8"), schema, "client failure replaced the published server schema");
  assert.equal(await readFile(clientSchemaFile, "utf8"), clientSchema, "client failure replaced the published client schema");

  await writeTables(moduleRoot, 170);
  const overflow = runCodegen();
  assert.notEqual(overflow.status, 0, "truncated schema was accepted");
  assert.match(overflow.output, /generated server schema\.ts was truncated at \d+ characters/);
  assert.equal(await readFile(schemaFile, "utf8"), schema, "failed generation replaced the published schema");
  assert.equal(await readFile(clientSchemaFile, "utf8"), clientSchema, "failed generation replaced the published client schema");
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
      client: { target: "client", generatedCode: "generated/client/code", generatedData: "generated/client/data" },
    },
  }, null, 2)}\n`);
  await writeFile(path.join(target, "game_config", "luban.conf"), `${JSON.stringify({
    groups: [{ names: ["s"], default: true }, { names: ["c"], default: true }],
    schemaFiles: [{ fileName: "Defines", type: "" }],
    dataDir: "Data",
    targets: [
      { name: "server", manager: "Tables", groups: ["s"], topModule: "cfg" },
      { name: "client", manager: "Tables", groups: ["c"], topModule: "cfg" },
    ],
    xargs: [],
  }, null, 2)}\n`);
}

// 写入 count 张两端共有、clientOnly 张只属客户端分组的带中文注释的表，每张一行数据。
// Write count shared and clientOnly client-group commented tables with one row each.
async function writeTables(target, count, clientOnly = 0) {
  let xml = "<module name=\"large\">\n";
  const data = path.join(target, "game_config", "Data");
  await rm(data, { recursive: true, force: true });
  await mkdir(data, { recursive: true });
  for (let bean = 0; bean < count + clientOnly; bean += 1) {
    // 结构与表都要标客户端分组，否则未分组的结构仍会导出到服务端。 / Tag both bean and table, or the bean still reaches the server.
    const group = bean >= count ? " group=\"c\"" : "";
    xml += `  <bean name="Bean${bean}"${group} comment="第${bean}个大配置结构">\n    <var name="id" type="int"/>\n`;
    const row = { id: 1 };
    for (let field = 0; field < fieldsPerBean; field += 1) {
      xml += `    <var name="field_${field}" type="string" comment="字段${field}的中文说明，用于撑大注释块"/>\n`;
      row[`field_${field}`] = "x";
    }
    xml += `  </bean>\n  <table name="TbBean${bean}" value="Bean${bean}" input="*rows@bean${bean}.json"${group} comment="表${bean}"/>\n`;
    await writeFile(path.join(data, `bean${bean}.json`), JSON.stringify({ rows: [row] }));
  }
  await writeFile(path.join(target, "game_config", "Defines", "large.xml"), `${xml}</module>\n`);
}

function runLubanOfficial(target, lubanTarget) {
  const code = path.join(temporary, `official-${lubanTarget}-code`);
  const result = spawnSync("dotnet", [path.join(lubanRoot, "Luban.dll"), "-t", lubanTarget, "-c", "typescript-json",
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
