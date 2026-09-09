import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  const clientSource = await readFile(
    path.join(moduleRoot, "generated", "typescript", "cards", "protocol", "clients.ts"),
    "utf8",
  );
  if (clientSource.includes("TiangZ-Modular") || !clientSource.includes("../../Core/Net/RpcSocket")) {
    throw new Error("module TypeScript SDK is not self-contained");
  }

  await runGenerator(["--check"]);
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

function runGenerator(extraArguments, allowFailure = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(root, "tools", "codegen_module_protocol.mjs"),
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
