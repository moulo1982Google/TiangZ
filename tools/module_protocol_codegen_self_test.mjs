import ts from "typescript";
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile, rename } from "node:fs/promises";
import assert from "node:assert/strict";
import { publishProtocolOutputs } from "./module_protocol_publish.mjs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "tiangz-module-protocol-"));
const modulesDirectory = path.join(temporary, "modules");
const moduleRoot = path.join(modulesDirectory, "cards");
const protoFile = path.join(moduleRoot, "proto", "Cards_C_31000.proto");

try {
  await writeFixture();
  await runGenerator(["--update-locks"]);

  const opcodeLock = JSON.parse(await readFile(path.join(moduleRoot, "proto", "opcode.lock.json"), "utf8"));
  if (opcodeLock.entries.length !== 2 || opcodeLock.entries[0].code !== 31001) {
    throw new Error(`module opcode lock was not generated as expected: ${JSON.stringify(opcodeLock)}`);
  }
  await stat(path.join(moduleRoot, "src", "model", "generated", "protocol", "index.ts"));
  await stat(path.join(moduleRoot, "generated", "godot", "CardsProto.gd"));
  const godotSource = await readFile(path.join(moduleRoot, "generated", "godot", "CardsProto.gd"), "utf8");
  if (!godotSource.includes("class ProtoReader:") || godotSource.includes("TzProtoReader")) {
    throw new Error("module Godot SDK still depends on a demo/global reader");
  }
  const schema = JSON.parse(await readFile(path.join(moduleRoot, "proto", "schema.lock.json"), "utf8"));
  const compact = schema.entries.find(e => e.name === "CompactShop");
  if (JSON.stringify(compact?.fields.map(f=>f.name)) !== JSON.stringify(["npc_id","name","prices","note"])) throw new Error("compact message fields were silently omitted or comments parsed as fields");
  await verifyStandaloneGodot();
  await verifySharedTypeScriptTransport();
  const clientSource = await readFile(
    path.join(moduleRoot, "generated", "typescript", "cards", "protocol", "clients.ts"),
    "utf8",
  );
  if (clientSource.includes("TiangZ-Modular") || !clientSource.includes("../../Core/Net/RpcSocket")) {
    throw new Error("module TypeScript SDK is not self-contained");
  }

  await runGenerator(["--check"]);
  const generatedClient = path.join(moduleRoot, "generated/typescript/cards/protocol/clients.ts");
  const originalClient = await readFile(generatedClient, "utf8");
  const originalMtime = (await stat(generatedClient)).mtimeMs;
  await runGenerator(["--check"]);
  assert.equal((await stat(generatedClient)).mtimeMs, originalMtime, "check rewrote unchanged output");
  await writeFile(generatedClient, "// deliberately stale output\n");
  const staleOutput = await runGenerator(["--check"], true);
  assert.notEqual(staleOutput.code, 0, "check accepted stale output");
  assert.equal(await readFile(generatedClient, "utf8"), "// deliberately stale output\n", "check repaired output");
  await runGenerator([]);
  assert.equal(await readFile(generatedClient, "utf8"), originalClient);
  const manifestPath = path.join(moduleRoot, "tiangz.module.json");
  const manifestText = await readFile(manifestPath, "utf8");
  const typescriptOnly = JSON.parse(manifestText);
  typescriptOnly.protocol.generateGodot = false;
  const godotDirectory = path.join(moduleRoot, "generated/godot");
  await rename(godotDirectory, path.join(temporary, "old-godot"));
  await writeFile(manifestPath, JSON.stringify(typescriptOnly));
  await runGenerator([]);
  await runGenerator(["--check"]);
  await assert.rejects(stat(godotDirectory), { code: "ENOENT" });
  const selectedOutputs = JSON.parse(await readFile(path.join(moduleRoot, "protocol.manifest.json"), "utf8")).outputs;
  assert.equal(selectedOutputs.godot, undefined);
  assert.ok(selectedOutputs.typescript);
  typescriptOnly.protocol.generateGodot = "false";
  await writeFile(manifestPath, JSON.stringify(typescriptOnly));
  assert.notEqual((await runGenerator([], true)).code, 0, "invalid SDK selection accepted");
  await writeFile(manifestPath, manifestText);
  await runGenerator([]);
  await stat(godotDirectory);
  const unsafe = JSON.parse(manifestText);
  unsafe.protocol.serverOutput = "src/model";
  await writeFile(manifestPath, JSON.stringify(unsafe));
  assert.notEqual((await runGenerator([], true)).code, 0, "generator accepted Model root output");
  assert.equal(await readFile(path.join(moduleRoot, "src/model/index.ts"), "utf8"), "export {};\n");
  await writeFile(manifestPath, manifestText);
  const handwritten = path.join(moduleRoot, "src/model/generated/protocol/handwritten.ts");
  await writeFile(handwritten, "export const business = 1;\n");
  assert.notEqual((await runGenerator([], true)).code, 0, "generator accepted handwritten source");
  await rm(handwritten);
  await verifyRollback();
  await runGenerator([], false, "verify_hotfix_boundary.mjs");
  const modelEntry = path.join(moduleRoot, "src", "model", "index.ts");
  const internalBinary = path.join(root, "app", "core", "protocol", "binary").replaceAll(path.sep, "/");
  await writeFile(modelEntry, `import { BinaryReader } from ${JSON.stringify(internalBinary)};\nexport { BinaryReader };\n`);
  const boundary = await runGenerator([], true, "verify_hotfix_boundary.mjs");
  if (boundary.code === 0) throw new Error("handwritten module escaped Stable boundary via protocol codec exception");
  await writeFile(modelEntry, "export {};\n");
  const changedProto = (await readFile(protoFile, "utf8")).replace(
    "  string greeting = 1;",
    "  string greeting = 1;\n  uint32 score = 2;",
  );
  await writeFile(protoFile, changedProto, "utf8");
  const stale = await runGenerator(["--check"], true);
  if (stale.code === 0 || !`${stale.stdout}\n${stale.stderr}`.includes("schema lock is missing")) {
    throw new Error("module protocol --check did not reject a schema change without a lock update");
  }
  // 自定义源目录与锁名必须贯穿整个生成链。 / Custom source and lock paths must reach every generator.
  await rename(path.join(moduleRoot, "proto"), path.join(moduleRoot, "wire"));
  await rename(path.join(moduleRoot, "wire/opcode.lock.json"), path.join(moduleRoot, "wire/codes.json"));
  await rename(path.join(moduleRoot, "wire/schema.lock.json"), path.join(moduleRoot, "wire/shapes.json"));
  const custom = JSON.parse(manifestText);
  Object.assign(custom.protocol, { source: "wire", opcodeLock: "wire/codes.json", schemaLock: "wire/shapes.json" });
  await writeFile(manifestPath, JSON.stringify(custom));
  await runGenerator(["--update-locks"]);
  await runGenerator(["--check"]);
  assert.match(await readFile(generatedClient, "utf8"), /CardsClient/);
  const otherRoot = path.join(modulesDirectory, "other");
  await cp(moduleRoot, otherRoot, { recursive: true });
  await writeFile(path.join(otherRoot, "tiangz.module.json"), JSON.stringify({ ...custom, id: "org.example.other" }));
  const lockFile = path.join(moduleRoot, "wire/shapes.json");
  const previousLock = await readFile(lockFile, "utf8");
  const previousManifest = await readFile(path.join(moduleRoot, "protocol.manifest.json"), "utf8");
  const customProto = path.join(moduleRoot, "wire/Cards_C_31000.proto");
  await writeFile(customProto, (await readFile(customProto, "utf8")).replace("uint32 score = 2;", "uint32 score = 2;\n  uint32 gold = 3;"));
  const collision = await runGenerator(["--update-locks"], true);
  assert.notEqual(collision.code, 0);
  assert.match(collision.stdout + collision.stderr, /msgcode collision/);
  assert.equal(await readFile(lockFile, "utf8"), previousLock, "failed generation changed protocol lock");
  assert.equal(await readFile(path.join(moduleRoot, "protocol.manifest.json"), "utf8"), previousManifest);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

process.stdout.write("module protocol codegen self-test passed\n");

async function verifyRollback() {
  const directory = path.join(temporary, "publish-rollback");
  await mkdir(directory);
  const entries = [0, 1].map(i => ({ staged: path.join(directory, `new-${i}`), target: path.join(directory, `old-${i}`) }));
  for (const entry of entries) { await writeFile(entry.staged, "new"); await writeFile(entry.target, "old"); }
  let calls = 0;
  await assert.rejects(publishProtocolOutputs(entries, false, async (...args) => {
    if (++calls === 4) throw new Error("injected publication failure");
    await rename(...args);
  }), /injected publication failure/);
  for (const entry of entries) assert.equal(await readFile(entry.target, "utf8"), "old");
}

async function verifySharedTypeScriptTransport() {
  const first = path.join(moduleRoot, "generated", "typescript");
  const second = path.join(temporary, "second-sdk");
  await cp(first, second, { recursive: true });
  const entry = path.join(temporary, "shared-transport.ts");
  await writeFile(entry, `import { RpcSocket } from "./modules/cards/generated/typescript/Core/Net/RpcSocket";
import { CardsClient as First } from "./modules/cards/generated/typescript/cards/protocol/clients";
import { CardsClient as Second } from "./second-sdk/cards/protocol/clients";
declare const shared: RpcSocket;
const first = new First(shared);
const second = new Second(shared);
void first.ping({ text: "first" });
void second.ping({ text: "second" });
`);
  const program = ts.createProgram([entry], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, skipLibCheck: true, noEmit: true, types: [] });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) throw new Error("independent SDKs cannot share a typed connection:\n" + ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: file => file, getCurrentDirectory: () => temporary, getNewLine: () => "\n",
  }));
  process.stdout.write("independent TypeScript SDKs share one typed transport\n");
}

async function verifyStandaloneGodot() {
  const godot = process.env.GODOT_BIN;
  if (!godot) {
    process.stdout.write("module Godot runtime check skipped: set GODOT_BIN to enable fresh-project validation\n");
    return;
  }
  const project = path.join(temporary, "godot-standalone");
  await mkdir(project, { recursive: true });
  await cp(path.join(moduleRoot, "generated", "godot", "CardsProto.gd"), path.join(project, "CardsProto.gd"));
  await runProcess(process.execPath, [path.join(root, "tools", "codegen_godot_client_sdk.mjs"),
    "--module-root", moduleRoot, "--schema-lock", path.join(moduleRoot, "proto", "schema.lock.json"),
    "--opcode-lock", path.join(moduleRoot, "proto", "opcode.lock.json"),
    "--output", path.join(project, "OtherCardsProto.gd"), "--class-name", "OtherCardsProto"]);
  await writeFile(path.join(project, "project.godot"), 'config_version=5\n[application]\nconfig/name="Module SDK acceptance"\n');
  await writeFile(path.join(project, "smoke.gd"), `extends SceneTree
const Cards = preload("res://CardsProto.gd")
const Other = preload("res://OtherCardsProto.gd")
func _initialize() -> void:
\tvar compact := Cards.decode_compact_shop(Cards.encode_compact_shop({"npc_id":54002,"name":"商人","prices":[15,120,90],"note":"hello"}))
\tassert(compact.npc_id == 54002 and compact.name == "商人" and compact.prices == [15,120,90] and compact.note == "hello")
\tvar text := "独立模块 · hello 🌍"
\tvar payload := Cards.encode_c2s_cards_ping({"text": text})
\tassert(Cards.decode_c2s_cards_ping(payload).text == text)
\tassert(Other.decode_c2s_cards_ping(payload).text == text)
\tvar rpc := Cards.with_rpc(719, payload)
\tassert(Cards.decode_rpc_id(rpc) == 719)
\tassert(Cards.decode_c2s_cards_ping(rpc).text == text)
\tvar response := Other.encode_s2c_cards_ping({"greeting": text})
\tassert(Cards.decode_s2c_cards_ping(response).greeting == text)
\tvar first := Cards.ProtoReader.new(payload)
\tvar second := Other.ProtoReader.new(payload)
\tfirst.tag()
\tassert(first.offset > 0 and second.offset == 0)
\tprint("MODULE_GODOT_STANDALONE_OK")
\tquit()
`);
  const result = await runProcess(godot, ["--headless", "--path", project, "--script", "res://smoke.gd", "--quit-after", "60"]);
  if (!result.includes("MODULE_GODOT_STANDALONE_OK") || /(?:SCRIPT ERROR|ERROR):/.test(result)) {
    throw new Error(`standalone Godot SDK runtime failed:\n${result}`);
  }
  // 独立 SDK 实跑之后再引入旧示例入口，避免全局类掩盖独立依赖缺失。
  // Add the legacy alias only after standalone validation, so global classes cannot mask missing dependencies.
  await mkdir(path.join(project, "scripts", "generated"), { recursive: true });
  await cp(path.join(root, "client_sdk/godot/generated/tiangz_proto.gd"), path.join(project, "scripts/generated/tiangz_proto.gd"));
  await cp(path.join(root, "client_sdk/godot/proto_reader.gd"), path.join(project, "scripts/proto_reader.gd"));
  await writeFile(path.join(project, "legacy.gd"), `extends SceneTree
const Cards = preload("res://CardsProto.gd")
const Legacy = preload("res://scripts/proto_reader.gd")
func _initialize() -> void:
\tvar payload := Cards.encode_c2s_cards_ping({"text": "旧入口"})
\tvar reader := Legacy.new(payload)
\tassert(reader.tag().field == 1)
\tassert(reader.string_value() == "旧入口")
\tprint("MODULE_GODOT_LEGACY_OK")
\tquit()
`);
  const legacy = await runProcess(godot, ["--headless", "--path", project, "--script", "res://legacy.gd", "--quit-after", "60"]);
  if (!legacy.includes("MODULE_GODOT_LEGACY_OK") || /(?:SCRIPT ERROR|ERROR):/.test(legacy)) {
    throw new Error(`legacy Godot reader compatibility failed:\n${legacy}`);
  }
  process.stdout.write("module Godot fresh-project runtime passed: two codecs, Unicode, RPC and reader isolation\n");
}

function runProcess(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Godot SDK validation timed out")); }, 30000);
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`SDK subprocess failed (${code}): ${output}`));
      else resolve(output);
    });
  });
}

async function writeFixture() {
  await Promise.all([
    mkdir(path.join(moduleRoot, "src", "model"), { recursive: true }),
    mkdir(path.join(moduleRoot, "src", "hotfix"), { recursive: true }),
    mkdir(path.join(moduleRoot, "proto"), { recursive: true }),
  ]);
  await writeFile(path.join(moduleRoot, "src", "model", "index.ts"), "export {};\n", "utf8");
  await writeFile(path.join(moduleRoot, "src", "hotfix", "index.ts"), "export {};\n", "utf8");
  await writeFile(protoFile, `syntax = "proto3";\n\npackage cards;\n\n//ResponseType S2C_CardsPing\n// @ets.msg protocol=Cards method=Ping\nmessage C2S_CardsPing // IRequest\n{\n  string text = 1;\n}\n\nmessage S2C_CardsPing // IResponse\n{\n  string greeting = 1;\n}\n`, "utf8");
  await writeFile(protoFile, (await readFile(protoFile,"utf8")) + '\nmessage CompactShop { uint32 npc_id = 1; string name = 2; /* uint32 ghost = 99; */ repeated uint32 prices = 3;\n // string fake = 98;\n string note = 4 [deprecated = true]; }\n');
  await writeFile(path.join(moduleRoot, "tiangz.module.json"), `${JSON.stringify({
    formatVersion: 1,
    id: "org.example.cards",
    version: "1.0.0",
    engine: { minVersion: "0.6.0-alpha.0", maxVersionExclusive: "0.7.0" },
    dependencies: [],
    capabilities: ["example.cards"],
    entries: { model: "src/model/index.ts", hotfix: "src/hotfix/index.ts" },
    protocol: {
      source: "proto",
      opcodeLock: "proto/opcode.lock.json",
      schemaLock: "proto/schema.lock.json",
      serverOutput: "src/model/generated/protocol",
      typescriptOutput: "generated/typescript",
      godotOutput: "generated/godot",
      godotClassName: "CardsProto",
    },
  }, null, 2)}\n`, "utf8");
}

function runGenerator(extraArguments, allowFailure = false, tool = "codegen_module_protocol.mjs") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(root, "tools", tool),
      "--modules-dir",
      modulesDirectory,
      ...extraArguments,
    ], {
      cwd: root,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      const result = { code: code ?? 1, stdout, stderr };
      if (result.code !== 0 && !allowFailure) {
        reject(new Error(`module protocol generator failed: ${stdout}\n${stderr}`));
      } else {
        resolve(result);
      }
    });
  });
}
