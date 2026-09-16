import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, mkdtemp, cp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

import { loadGameModuleCatalog } from "./game_module_catalog.mjs";
import { publishProtocolOutputs } from "./module_protocol_publish.mjs";
import { resolveHostProfile } from "./host_profile.mjs";

const root = path.resolve(import.meta.dirname, "..");
const requestedModulesDirectory = argumentValue("--modules-dir") ?? process.env.TIANGZ_MODULES_DIR;
const modulesDirectory = requestedModulesDirectory
  ? path.resolve(root, requestedModulesDirectory)
  : path.join(root, "modules");
const updateLocks = process.argv.includes("--update-locks") || process.argv.includes("--update-opcode-lock");
const checkOnly = process.argv.includes("--check");
const hostProfile = resolveHostProfile();
if (checkOnly && updateLocks) {
  throw new Error("--check cannot be combined with --update-locks");
}

const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const catalog = await loadGameModuleCatalog({
  projectRoot: root,
  modulesDirectory,
  engineVersion: packageJson.version,
});
const protocolModules = catalog.modules.filter((module) => module.protocol);

if (protocolModules.length === 0) {
  process.stdout.write("[codegen:module-protocol] no module-owned protocols\n");
  process.exit(0);
}

const generated = [];
const stagingDirectories = [];
const publications = [];
let preserveStaging = false;
try {
for (const module of protocolModules) {
  const originalProtocol = module.protocol;
  const staging = await mkdtemp(path.join(module.root, ".tiangz-protocol-"));
  stagingDirectories.push(staging);
  const protocol = { ...originalProtocol,
    serverOutput: path.join(staging, "server"),
    typescriptOutput: path.join(staging, "typescript"),
    godotOutput: path.join(staging, "godot"),
    opcodeLock: path.join(staging, "opcode.lock.json"),
    schemaLock: path.join(staging, "schema.lock.json"),
  };
  for (const key of ["opcodeLock", "schemaLock"]) {
    await cp(originalProtocol[key], protocol[key]).catch(e => { if (e.code !== "ENOENT" || !updateLocks) throw e; });
  }
  const protoFiles = await collectProtoFiles(protocol.source);
  if (protoFiles.length === 0) {
    throw new Error(`game module ${module.id} protocol source contains no .proto files: ${protocol.source}`);
  }

  const protoArguments = [
    path.join(root, "tools", "codegen_proto.mjs"),
    "--module-root",
    module.root,
    "--proto-source", protocol.source,
    "--opcode-lock", protocol.opcodeLock,
    "--schema-lock", protocol.schemaLock,
    "--server-import-root", originalProtocol.serverOutput,
    "--server-output",
    protocol.serverOutput,
    "--typescript-output",
    protocol.typescriptOutput,
    "--strict-locks",
  ];
  if (updateLocks) protoArguments.push("--update-opcode-lock");
  await runNode(protoArguments, root);

  const godotArguments = [
    path.join(root, "tools", "codegen_godot_client_sdk.mjs"),
    "--module-root",
    module.root,
    "--schema-lock",
    protocol.schemaLock,
    "--opcode-lock",
    protocol.opcodeLock,
    "--output",
    path.join(protocol.godotOutput, `${protocol.godotClassName}.gd`),
    "--class-name",
    protocol.godotClassName,
  ];
  const generateGodot = protocol.relative.generateGodot !== false;
  if (generateGodot) await runNode(godotArguments, root);

  const opcodeLock = await readLock(protocol.opcodeLock, "opcode");
  const schemaLock = await readLock(protocol.schemaLock, "schema");
  const serverProtocolIndex = await writeServerProtocolIndex(protocol.serverOutput);
  generated.push({ module, protocol, protoFiles, opcodeLock, schemaLock, serverProtocolIndex });
  await writeProtocolManifest({
    module,
    protocol,
    protoFiles,
    opcodeLock,
    schemaLock,
    serverProtocolIndex: path.join(originalProtocol.serverOutput, "index.ts"),
    manifestFile: path.join(staging, "protocol.manifest.json"),
  });
  for (const key of ["serverOutput", "typescriptOutput", ...(generateGodot ? ["godotOutput"] : []), ...(updateLocks ? ["opcodeLock", "schemaLock"] : [])]) {
    publications.push({ staged: protocol[key], target: originalProtocol[key] });
  }
  publications.push({ staged: path.join(staging, "protocol.manifest.json"), target: path.join(module.root, "protocol.manifest.json") });
  process.stdout.write(
    `[codegen:module-protocol] ${checkOnly ? "checked" : "generated"} ${module.id} messages=${schemaLock.entries.length} ` +
      `typescript=${relative(originalProtocol.typescriptOutput)} godot=${generateGodot ? relative(path.join(originalProtocol.godotOutput, `${protocol.godotClassName}.gd`)) : "disabled"}\n`,
  );
}

await validateGlobalOpcodeOwnership(generated);
await publishProtocolOutputs(publications, checkOnly);
} catch (error) {
  preserveStaging = error.preserveStaging === true;
  if (preserveStaging) process.stderr.write(`Protocol backups: ${stagingDirectories.join(", ")}\n`);
  throw error;
} finally {
  if (!preserveStaging) for (const directory of stagingDirectories) await rm(directory, { recursive: true, force: true });
}
process.stdout.write(
  `[codegen:module-protocol] complete modules=${generated.length} graph=${catalog.graphHash}\n`,
);

async function validateGlobalOpcodeOwnership(records) {
  const owners = new Map();
  const hostLockFile = path.join(root, "proto", "opcode.lock.json");
  const hostLock = hostProfile === "modules" ? { entries: [] } : await readLock(hostLockFile, "host opcode");
  for (const entry of hostLock.entries) {
    addOwner(entry.code, `engine:${entry.key}`, owners);
  }
  for (const record of records) {
    for (const entry of record.opcodeLock.entries) {
      addOwner(entry.code, `${record.module.id}:${entry.key}`, owners);
    }
  }
}

function addOwner(code, owner, owners) {
  if (!Number.isInteger(code) || code < 1 || code > 0xffff) {
    throw new Error(`protocol opcode must be an integer from 1 to 65535: ${owner}=${String(code)}`);
  }
  const previous = owners.get(code);
  if (previous && previous !== owner) {
    throw new Error(`protocol msgcode collision ${code}: ${previous} and ${owner}`);
  }
  owners.set(code, owner);
}

async function writeProtocolManifest({
  module,
  protocol,
  protoFiles,
  opcodeLock,
  schemaLock,
  serverProtocolIndex,
  manifestFile,
}) {
  const value = {
    formatVersion: 1,
    module: {
      id: module.id,
      version: module.version,
    },
    source: protocol.relative.source,
    protoFiles: protoFiles
      .map((file) => path.relative(module.root, file).replaceAll(path.sep, "/"))
      .sort((left, right) => left.localeCompare(right, "en")),
    locks: {
      opcode: {
        path: protocol.relative.opcodeLock,
        sha256: sha256(await readFile(protocol.opcodeLock)),
        entries: opcodeLock.entries.length,
      },
      schema: {
        path: protocol.relative.schemaLock,
        sha256: sha256(await readFile(protocol.schemaLock)),
        entries: schemaLock.entries.length,
      },
    },
    outputs: {
      server: protocol.relative.serverOutput,
      serverIndex: path.relative(module.root, serverProtocolIndex).replaceAll(path.sep, "/"),
      typescript: protocol.relative.typescriptOutput,
      ...(protocol.relative.generateGodot !== false ? {
        godot: protocol.relative.godotOutput,
        godotClassName: protocol.godotClassName,
      } : {}),
    },
  };
  await writeFile(
    manifestFile,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

async function writeServerProtocolIndex(outputDirectory) {
  const files = await collectGeneratedProtocolFiles(outputDirectory);
  const rpcFiles = files.filter((file) => path.basename(file) === "rpcs.ts");
  const messageFiles = files.filter((file) => path.basename(file) === "messageDescriptors.ts");
  const imports = [
    ...rpcFiles.map((file, index) => ({
      alias: `RpcDescriptors${index}`,
      file,
      exportName: "AllRpcDescriptors",
    })),
    ...messageFiles.map((file, index) => ({
      alias: `MessageDescriptors${index}`,
      file,
      exportName: "AllMessageDescriptors",
    })),
  ];
  const lines = [
    "// Generated by tools/codegen_module_protocol.mjs. Do not edit by hand.",
    ...imports.map((item) => (
      `import { ${item.exportName} as ${item.alias} } from "./${path.relative(outputDirectory, item.file).replaceAll(path.sep, "/").replace(/\.ts$/, "")}";`
    )),
    "",
    "export const AllRpcDescriptors = [",
    ...imports.filter((item) => item.exportName === "AllRpcDescriptors").map((item) => `  ...${item.alias},`),
    "] as const;",
    "",
    "export const AllMessageDescriptors = [",
    ...imports.filter((item) => item.exportName === "AllMessageDescriptors").map((item) => `  ...${item.alias},`),
    "] as const;",
    "",
  ];
  const output = path.join(outputDirectory, "index.ts");
  await writeFile(output, lines.join("\n"), "utf8");
  return output;
}

async function collectGeneratedProtocolFiles(directory) {
  const result = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await collectGeneratedProtocolFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".ts") && entry.name !== "index.ts") result.push(fullPath);
  }
  return result.sort((left, right) => left.localeCompare(right, "en"));
}

async function readLock(file, kind) {
  let value;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`failed to read ${kind} protocol lock ${file}: ${error.message}`, { cause: error });
  }
  if (value?.version !== 1 || !Array.isArray(value.entries)) {
    throw new Error(`${file}: ${kind} lock must contain version=1 and an entries array`);
  }
  const keys = new Set();
  for (const entry of value.entries) {
    if (typeof entry?.key !== "string" || keys.has(entry.key)) {
      throw new Error(`${file}: ${kind} lock contains a duplicate or invalid key`);
    }
    keys.add(entry.key);
  }
  return value;
}

async function collectProtoFiles(directory) {
  const result = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await collectProtoFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".proto")) {
      result.push(fullPath);
    }
  }
  return result.sort((left, right) => left.localeCompare(right, "en"));
}

function runNode(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(args[0])} exited with ${signal ?? `code ${code ?? 1}`}`));
    });
  });
}

function argumentValue(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, "/");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
