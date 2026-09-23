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
// 开发期按当前 proto 重写 schema 锁，允许改已有字段的类型、名称或删除字段；opcode 锁照常只追加。
// Development-only: rewrite the schema lock from the current proto, allowing field type/name changes
// and removals; the opcode lock stays append-only.
const devRegenSchemaLock = process.argv.includes("--dev-regen-schema-lock");
const updateLocks = process.argv.includes("--update-locks") || process.argv.includes("--update-opcode-lock") || devRegenSchemaLock;
const checkOnly = process.argv.includes("--check");
const hostProfile = resolveHostProfile();
if (checkOnly && updateLocks) {
  throw new Error("--check cannot be combined with --update-locks or --dev-regen-schema-lock");
}
if (devRegenSchemaLock && process.env.TIANGZ_LOCK_VERSIONS === "1") {
  throw new Error("--dev-regen-schema-lock is development-only and is refused while TIANGZ_LOCK_VERSIONS=1 (release gate)");
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
const regenerationReports = [];
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
  const previousSchemaLock = devRegenSchemaLock ? await readOptionalLock(protocol.schemaLock) : undefined;
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
  if (devRegenSchemaLock) protoArguments.push("--replace-schema-lock");
  await runNode(protoArguments, root);
  // 重写后恢复已删除字段与消息的墓碑，防止旧编号被复用；在 Godot SDK 生成前完成，与默认模式的锁形状一致。
  // Restore tombstones for removed fields/messages so old numbers are never reused; done before the
  // Godot SDK reads the lock so the lock shape matches default mode.
  const regeneratedSchemaLock = devRegenSchemaLock
    ? await restoreSchemaTombstones(protocol.schemaLock, previousSchemaLock)
    : undefined;

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
  if (devRegenSchemaLock) regenerationReports.push(() => reportSchemaRegeneration(module.id, previousSchemaLock, regeneratedSchemaLock));
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
// 只有发布成功才报告"已重写"；失败时原锁未变。 / Report only after publication succeeds; on failure the original lock is untouched.
for (const report of regenerationReports) report();
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

async function readOptionalLock(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * 以当前 proto 重写后的锁为准，补回旧锁中已删除的字段与消息作为墓碑，保证旧编号不被复用；
 * 返回补回之前的重写结果，供差异报告使用。
 *
 * Adds fields and messages removed since the previous lock back as tombstones so their numbers are
 * never reused, and returns the regenerated lock as it was before the tombstones were restored,
 * for the difference report.
 */
async function restoreSchemaTombstones(schemaLockFile, previous) {
  const regenerated = JSON.parse(await readFile(schemaLockFile, "utf8"));
  if (!previous?.entries?.length) return regenerated;
  const entries = new Map(regenerated.entries.map((entry) => [entry.key, { ...entry, fields: [...entry.fields] }]));
  for (const entry of previous.entries) {
    const current = entries.get(entry.key);
    if (!current) {
      entries.set(entry.key, entry);
      continue;
    }
    const numbers = new Set(current.fields.map((field) => field.number));
    for (const field of entry.fields) if (!numbers.has(field.number)) current.fields.push(field);
    current.fields.sort((left, right) => left.number - right.number);
  }
  const next = { ...regenerated, entries: [...entries.values()].sort((left, right) => left.key.localeCompare(right.key, "en")) };
  await writeFile(schemaLockFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return regenerated;
}

/** 把重写前后的破坏性差异逐条打印，破坏性变更必须可见。 / Prints every breaking difference so a regeneration is never silent. */
function reportSchemaRegeneration(moduleId, previous, regenerated) {
  const nextEntries = new Map((regenerated?.entries ?? []).map((entry) => [entry.key, entry]));
  const changes = [];
  for (const entry of previous?.entries ?? []) {
    const current = nextEntries.get(entry.key);
    if (!current) {
      changes.push(`removed message ${entry.key} (numbers kept as tombstones)`);
      continue;
    }
    for (const property of ["name", "base", "response"]) {
      if ((entry[property] ?? null) !== (current[property] ?? null)) {
        changes.push(`${entry.key}: ${property} ${entry[property] ?? "<none>"} -> ${current[property] ?? "<none>"}`);
      }
    }
    const currentFields = new Map(current.fields.map((field) => [field.number, field]));
    for (const field of entry.fields) {
      const now = currentFields.get(field.number);
      if (!now) changes.push(`${entry.name}: removed field ${field.name}=${field.number} (number kept as tombstone)`);
      else if (["name", "type", "repeated", "synthetic"].some((property) => now[property] !== field[property])) {
        changes.push(`${entry.name}: field ${field.number} ${describeField(field)} -> ${describeField(now)}`);
      }
    }
  }
  process.stdout.write(
    `[codegen:module-protocol] dev-regen ${moduleId}: schema lock rebuilt from current proto; ` +
      `${changes.length} breaking change(s)${changes.length ? ":" : ""}\n`,
  );
  for (const change of changes) process.stdout.write(`  - ${change}\n`);
}

function describeField(field) {
  return `${field.synthetic ? "synthetic " : ""}${field.repeated ? "repeated " : ""}${field.type} ${field.name}`;
}

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
