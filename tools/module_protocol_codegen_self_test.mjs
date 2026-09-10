import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  await verifyStandaloneGodot();
  const clientSource = await readFile(
    path.join(moduleRoot, "generated", "typescript", "cards", "protocol", "clients.ts"),
    "utf8",
  );
  if (clientSource.includes("TiangZ-Modular") || !clientSource.includes("../../Core/Net/RpcSocket")) {
    throw new Error("module TypeScript SDK is not self-contained");
  }

  await runGenerator(["--check"]);
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
} finally {
  await rm(temporary, { recursive: true, force: true });
}

process.stdout.write("module protocol codegen self-test passed\n");

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
  await cp(path.join(root, "client_demo/godot-3d-4.7.1/scripts/generated/tiangz_proto.gd"), path.join(project, "scripts/generated/tiangz_proto.gd"));
  await cp(path.join(root, "client_demo/godot-3d-4.7.1/scripts/proto_reader.gd"), path.join(project, "scripts/proto_reader.gd"));
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
  await writeFile(path.join(moduleRoot, "tiangz.module.json"), `${JSON.stringify({
    formatVersion: 1,
    id: "org.example.cards",
    version: "1.0.0",
    engine: { minVersion: "0.4.0", maxVersionExclusive: "0.5.0" },
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
