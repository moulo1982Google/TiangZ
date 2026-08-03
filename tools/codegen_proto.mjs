import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectGeneratedFiles, recordGenerator } from "./codegen_manifest.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptFile), "..");
const protoDir = path.join(root, "proto");
const opcodeLockFile = path.join(protoDir, "opcode.lock.json");
const schemaLockFile = path.join(protoDir, "schema.lock.json");
const generatedModelDir = path.join(root, "app", "generated", "model");
const generatedServerProtocolDir = path.join(generatedModelDir, "server");
const obsoleteAppClientProtocolDir = path.join(generatedModelDir, "client");
const appDir = path.join(root, "app");
const configFile = path.join(root, "codegen.config.json");
const codegenConfig = JSON.parse(
  await readFile(configFile, "utf8"),
);
const typescriptClientSdk = resolveTypescriptClientSdk(
  codegenConfig.typescriptClientSdk,
);
const cppClientSdk = resolveCppClientSdk(codegenConfig.cppClientSdk);
const appRuntimeFiles = {
  binary: path.join(appDir, "core", "protocol", "binary.ts"),
  broadcast: path.join(appDir, "core", "broadcast", "index.ts"),
  message: path.join(appDir, "core", "protocol", "message.ts"),
  rpc: path.join(appDir, "core", "protocol", "rpc.ts"),
};
const protocolTargets = new Set(["C", "S", "CS"]);
const supportedTypes = new Set([
  "string",
  "bytes",
  "bool",
  "uint32",
  "int32",
  "sint32",
  "uint64",
  "int64",
  "float",
  "double",
]);
const knownBaseTypes = new Set([
  "IMessage",
  "IRequest",
  "IResponse",
  "IActorMessage",
  "IActorRequest",
  "IActorResponse",
  "IActorLocationMessage",
  "IActorLocationRequest",
  "IActorLocationResponse",
]);
const messageOptionKeys = new Set([
  "base",
  "response",
  "protocol",
  "service",
  "method",
  "duringTransfer",
]);

await main();

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test-locks")) {
    runProtocolLockSelfTests();
    return;
  }
  const updateProtocolLocks = args.includes("--update-opcode-lock");
  const replaceSchemaLock = args.includes("--replace-schema-lock");
  if (replaceSchemaLock && !updateProtocolLocks) {
    throw new Error("--replace-schema-lock requires --update-opcode-lock");
  }
  const opcodeLock = await readOpcodeLock(updateProtocolLocks);
  const protoFiles = await discoverProtoFiles(protoDir);
  const groups = new Map();
  const sourceProtocols = [];
  for (const protoFile of protoFiles) {
    const fileInfo = parseProtoFileInfo(protoFile);
    const source = await readFile(protoFile, "utf8");
    const protocol = parseProto(source, fileInfo, opcodeLock);
    validateProtocol(protocol, fileInfo.fileName, true);
    sourceProtocols.push(protocol);

    for (const target of targetsForFlag(fileInfo.targetFlag)) {
      const key = `${target}\0${protocol.packageDir}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          target,
          packageDir: protocol.packageDir,
          messages: [],
          msgCodes: [],
          rpcs: [],
          messageDescriptors: [],
          broadcastDescriptors: [],
        };
        groups.set(key, group);
      }
      mergeProtocol(group, protocol);
    }
  }

  await enforceOpcodeLock(sourceProtocols, updateProtocolLocks, opcodeLock);
  await enforceSchemaLock(sourceProtocols, updateProtocolLocks, replaceSchemaLock);

  await rm(generatedServerProtocolDir, { recursive: true, force: true });
  await rm(obsoleteAppClientProtocolDir, { recursive: true, force: true });
  if (typescriptClientSdk) {
    await removeGeneratedTypeScript(typescriptClientSdk.protocolOutputRoot);
  }
  if (cppClientSdk) {
    await rm(cppClientSdk.protocolOutputRoot, { recursive: true, force: true });
  }

  for (const group of [...groups.values()].sort(compareProtocolGroup)) {
    validateProtocol(group, `${group.target}/${group.packageDir}`);
    if (group.target === "server") {
      const outputDir = path.join(
        generatedServerProtocolDir,
        group.packageDir,
        "protocol",
      );
      await writeProtocol(group, outputDir, appRuntimeFiles);
    }
    if (typescriptClientSdk && group.target === "client") {
      const sdkOutputDir = path.join(
        typescriptClientSdk.protocolOutputRoot,
        group.packageDir,
        "protocol",
      );
      await writeProtocol(group, sdkOutputDir, typescriptClientSdk.runtimeFiles);
    }
    if (cppClientSdk && group.target === "client") {
      const outputDir = path.join(cppClientSdk.protocolOutputRoot, group.packageDir);
      await mkdir(outputDir, { recursive: true });
      await writeFile(path.join(outputDir, "Protocol.h"), emitCppProtocol(group), "utf8");
    }
  }

  const outputRoots = [
    { path: generatedServerProtocolDir, extensions: [".ts"] },
    ...(typescriptClientSdk ? [{ path: typescriptClientSdk.protocolOutputRoot, extensions: [".ts"] }] : []),
    ...(cppClientSdk ? [{ path: cppClientSdk.protocolOutputRoot, extensions: [".h"] }] : []),
  ];
  await recordGenerator(root, {
    id: "proto",
    command: "npm run codegen:proto",
    contentInputs: [scriptFile, configFile, opcodeLockFile, schemaLockFile, ...protoFiles],
    outputs: await collectGeneratedFiles(outputRoots),
    outputRoots,
  });
}

function resolveCppClientSdk(config) {
  if (!config?.enabled) return undefined;
  if (typeof config.protocolOutputRoot !== "string" || config.protocolOutputRoot.length === 0) {
    throw new Error("cppClientSdk.protocolOutputRoot must be a non-empty path");
  }
  return { protocolOutputRoot: path.resolve(root, config.protocolOutputRoot) };
}

async function removeGeneratedTypeScript(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await removeGeneratedTypeScript(fullPath);
    else if (entry.isFile() && entry.name.endsWith(".ts")) await rm(fullPath, { force: true });
  }
}

function resolveTypescriptClientSdk(config) {
  if (!config?.enabled) return undefined;
  if (typeof config.sourceRoot !== "string" || config.sourceRoot.length === 0) {
    throw new Error("typescriptClientSdk.sourceRoot must be a non-empty path");
  }
  const sourceRoot = path.resolve(root, config.sourceRoot);
  return {
    protocolOutputRoot: path.join(sourceRoot, "Generated", "Model"),
    runtimeFiles: {
      binary: path.join(sourceRoot, "Core", "Protocol", "Binary.ts"),
      message: path.join(sourceRoot, "Core", "Protocol", "Message.ts"),
      rpc: path.join(sourceRoot, "Core", "Protocol", "Rpc.ts"),
      socket: path.join(sourceRoot, "Core", "Net", "RpcSocket.ts"),
    },
  };
}

async function discoverProtoFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await discoverProtoFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".proto")) {
      files.push(fullPath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function parseProtoFileInfo(protoFile) {
  const fileName = path.basename(protoFile, ".proto");
  const parts = fileName.split("_");
  if (parts.length < 3) {
    throw new Error(
      `${fileName}.proto must use ET-style name <ProtoName>_<C|S|CS>_<StartOpcode>.proto`,
    );
  }

  const startOpcodeText = parts.pop();
  const targetFlag = parts.pop();
  const protoName = parts.join("_");
  if (!protoName) {
    throw new Error(`${fileName}.proto has an empty proto name`);
  }
  if (!protocolTargets.has(targetFlag)) {
    throw new Error(
      `${fileName}.proto has unsupported target ${targetFlag}; expected C, S or CS`,
    );
  }
  if (!/^\d+$/.test(startOpcodeText)) {
    throw new Error(`${fileName}.proto has invalid start opcode ${startOpcodeText}`);
  }

  return {
    filePath: protoFile,
    fileName,
    protoName,
    targetFlag,
    startOpcode: Number(startOpcodeText),
    relativePath: path.relative(root, protoFile).replaceAll(path.sep, "/"),
  };
}

function targetsForFlag(targetFlag) {
  const targets = new Set();
  if (targetFlag.includes("C")) {
    targets.add("client");
    targets.add("server");
  }
  if (targetFlag.includes("S")) {
    targets.add("server");
  }
  return [...targets];
}

function compareProtocolGroup(left, right) {
  return `${left.target}/${left.packageDir}`.localeCompare(
    `${right.target}/${right.packageDir}`,
  );
}

function mergeProtocol(group, protocol) {
  group.messages.push(...protocol.messages);
  group.msgCodes.push(...protocol.msgCodes);
  group.rpcs.push(...protocol.rpcs);
  group.messageDescriptors.push(...protocol.messageDescriptors);
  group.broadcastDescriptors.push(...protocol.broadcastDescriptors);
}

function toCamel(name) {
  return name.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
}

function parseProto(source, fileInfo, opcodeLock) {
  const messages = [];
  const startOpcode = parseOpcodeStart(source, fileInfo);
  const messagePattern =
    /((?:[ \t]*\/\/[^\n]*\n)*)[ \t]*message\s+(\w+)(?:[ \t]*\/\/[ \t]*(I\w+))?[ \t\r\n]*\{([\s\S]*?)\}/g;
  const fieldPattern =
    /^\s*(?:(repeated)\s+)?([A-Za-z_]\w*)\s+(\w+)\s*=\s*(\d+)(?:\s*\[[^\]]*\])?\s*;/gm;

  for (const messageMatch of source.matchAll(messagePattern)) {
    const [, comments, name, trailingBase, body] = messageMatch;
    const meta = parseMessageMeta(comments, trailingBase);
    const fields = [];

    for (const fieldMatch of body.matchAll(fieldPattern)) {
      const [, repeated, type, protoName, fieldNo] = fieldMatch;
      fields.push({
        type,
        repeated: Boolean(repeated),
        protoName,
        tsName: toCamel(protoName),
        fieldNo: Number(fieldNo),
        optional: protoName === "rpc_id",
      });
    }

    const message = {
      name,
      fields,
      opcodeScope: fileInfo.protoName,
      opcodeKey: `${fileInfo.relativePath}#${name}`,
      ...meta,
    };
    addFrameworkFields(message);
    messages.push(message);
  }

  assignMessageCodes(messages, startOpcode, opcodeLock);
  const protocol = {
    packageDir: parsePackageDir(source),
    messages,
  };
  protocol.msgCodes = parseMsgCodes(messages);
  protocol.rpcs = parseRpcs(messages);
  protocol.messageDescriptors = parseMessageDescriptors(messages);
  protocol.broadcastDescriptors = parseBroadcastDescriptors(messages);
  validateBaseTypes(messages);
  return protocol;
}

function parsePackageDir(source) {
  const packageMatch = source.match(/^\s*package\s+([A-Za-z0-9_.]+)\s*;/m);
  if (!packageMatch) return "default";

  const parts = packageMatch[1].split(".").filter(Boolean);
  if (parts[0] === "ets") parts.shift();
  return parts.length > 0 ? path.join(...parts) : "default";
}

function parseOpcodeStart(source, fileInfo) {
  const commentMatch = source.match(/\/\/\s*@ets\.opcode\s+start\s*=\s*(\d+)/);
  if (commentMatch) {
    return Number(commentMatch[1]);
  }

  return fileInfo.startOpcode;
}

function parseMessageMeta(comments, trailingBase) {
  const meta = {
    base: trailingBase,
    codeName: undefined,
    code: undefined,
    explicitCode: undefined,
    responseType: undefined,
    protocol: undefined,
    method: undefined,
    broadcast: undefined,
    duringTransfer: undefined,
  };

  const responseTypeMatch = comments.match(/\/\/\s*ResponseType\s+(\w+)/);
  if (responseTypeMatch) {
    meta.responseType = responseTypeMatch[1];
  }

  const msgMatch = comments.match(/\/\/\s*@ets\.msg\b([^\n]*)/);
  const broadcastMatch = comments.match(/\/\/\s*@ets\.broadcast\b([^\n]*)/);
  if (broadcastMatch) {
    meta.broadcast = Object.fromEntries(
      [...broadcastMatch[1].matchAll(/(\w+)=([A-Za-z0-9_,]+)/g)].map(
        ([, key, value]) => [key, value],
      ),
    );
  }
  if (!msgMatch) return meta;

  let rest = msgMatch[1].trim();
  const first = rest.match(/^(\w+)(.*)$/);
  if (first) {
    const [, token, afterToken] = first;
    const after = afterToken.trimStart();
    const isOption = messageOptionKeys.has(token) && after.startsWith("=");
    if (!isOption) {
      meta.codeName = token;
      rest = afterToken.trimStart();
      const explicit = rest.match(/^=\s*(\d+)(.*)$/);
      if (explicit) {
        meta.explicitCode = Number(explicit[1]);
        rest = explicit[2].trimStart();
      }
    }
  }

  for (const optionMatch of rest.matchAll(/(\w+)=([A-Za-z0-9_]+)/g)) {
    const [, key, value] = optionMatch;
    if (key === "base") meta.base = value;
    if (key === "response") meta.responseType = value;
    if (key === "protocol" || key === "service") meta.protocol = value;
    if (key === "method") meta.method = value;
    if (key === "duringTransfer") meta.duringTransfer = value;
  }

  return meta;
}

function addFrameworkFields(message) {
  if (baseCarriesRpcId(message.base)) {
    addSyntheticField(message, {
      type: "uint32",
      protoName: "rpc_id",
      tsName: "rpcId",
      fieldNo: 90,
    });
  }

  if (baseCarriesError(message.base)) {
    addSyntheticField(message, {
      type: "uint32",
      protoName: "error",
      tsName: "error",
      fieldNo: 91,
    });
    addSyntheticField(message, {
      type: "string",
      protoName: "message",
      tsName: "message",
      fieldNo: 92,
    });
  }
}

function addSyntheticField(message, field) {
  if (message.fields.some((item) => item.protoName === field.protoName)) return;
  if (message.fields.some((item) => item.fieldNo === field.fieldNo)) {
    throw new Error(
      `${message.name} field number ${field.fieldNo} is reserved for ${field.protoName}`,
    );
  }

  message.fields.unshift({
    ...field,
    repeated: false,
    optional: true,
    synthetic: true,
  });
}

function assignMessageCodes(messages, startOpcode, opcodeLock) {
  let opcode = startOpcode;
  const lockedByKey = new Map(
    (opcodeLock?.entries ?? []).map((entry) => [entry.key, entry]),
  );
  const reservedCodes = new Set(
    (opcodeLock?.entries ?? []).map((entry) => entry.code),
  );

  for (const message of messages) {
    if (!isProtocolMessage(message)) continue;

    message.codeName ??= message.name;
    if (message.explicitCode !== undefined) {
      message.code = message.explicitCode;
      continue;
    }

    const locked = lockedByKey.get(message.opcodeKey);
    if (locked) {
      message.code = locked.code;
      opcode = Math.max(opcode, locked.code);
      continue;
    }

    do opcode += 1;
    while (reservedCodes.has(opcode));
    message.code = opcode;
    reservedCodes.add(opcode);
  }
}

async function enforceOpcodeLock(protocols, update, lock) {
  const current = protocols
    .flatMap((protocol) => protocol.messages)
    .filter(isProtocolMessage)
    .map((message) => ({
      key: message.opcodeKey,
      name: message.codeName,
      code: message.code,
    }))
    .sort((left, right) => left.key.localeCompare(right.key, "en"));
  const entries = new Map(lock.entries.map((entry) => [entry.key, entry]));
  const owners = new Map(lock.entries.map((entry) => [entry.code, entry.key]));
  const missing = [];

  for (const message of current) {
    const locked = entries.get(message.key);
    if (locked) {
      if (locked.code !== message.code || locked.name !== message.name) {
        throw new Error(
          `opcode lock mismatch for ${message.key}: locked ${locked.name}=${locked.code}, generated ${message.name}=${message.code}. ` +
            "Published opcodes cannot be renumbered or renamed; append the message or assign an explicit unused code.",
        );
      }
      continue;
    }

    const owner = owners.get(message.code);
    if (owner) {
      throw new Error(
        `opcode ${message.code} for ${message.key} is reserved by ${owner}; deleted messages keep their opcode reserved`,
      );
    }
    missing.push(message);
  }

  if (missing.length > 0 && !update) {
    throw new Error(
      `opcode lock is missing ${missing.length} message(s): ${missing.map((item) => item.key).join(", ")}. ` +
        "Review the generated numbers, then run npm run codegen:proto:update-lock.",
    );
  }

  if (!update || missing.length === 0) return;
  for (const message of missing) {
    entries.set(message.key, message);
    owners.set(message.code, message.key);
  }
  const next = {
    version: 1,
    entries: [...entries.values()].sort((left, right) => left.key.localeCompare(right.key, "en")),
  };
  await writeFile(opcodeLockFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  console.log(`updated opcode lock: ${missing.length} message(s) added`);
}

async function readOpcodeLock(allowMissing) {
  try {
    const lock = JSON.parse(await readFile(opcodeLockFile, "utf8"));
    if (lock?.version !== 1 || !Array.isArray(lock.entries)) {
      throw new Error("opcode lock must contain version=1 and an entries array");
    }
    return lock;
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return { version: 1, entries: [] };
    if (error?.code === "ENOENT") {
      throw new Error(
        "proto/opcode.lock.json is missing; initialize it with npm run codegen:proto:update-lock",
      );
    }
    throw error;
  }
}

async function enforceSchemaLock(protocols, update, replace = false) {
  const current = protocols
    .flatMap((protocol) => protocol.messages)
    .map(toSchemaEntry)
    .sort((left, right) => left.key.localeCompare(right.key, "en"));
  const lock = await readSchemaLock(update);
  if (replace) {
    const next = { version: 1, entries: current };
    await writeFile(schemaLockFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    console.log(`replaced schema lock for an explicitly reviewed breaking release: ${current.length} message(s)`);
    return;
  }
  const entries = new Map(lock.entries.map((entry) => [entry.key, entry]));
  const missingMessages = [];
  let addedFields = 0;

  for (const message of current) {
    const locked = entries.get(message.key);
    if (!locked) {
      missingMessages.push(message);
      continue;
    }
    const additions = compareSchemaEntry(message, locked);
    if (additions.length === 0) continue;
    if (!update) {
      throw new Error(
        `schema lock is missing ${message.key} field(s): ${additions.map((field) => `${field.name}=${field.number}`).join(", ")}. ` +
          "Review the additions, then run npm run codegen:proto:update-lock.",
      );
    }
    entries.set(message.key, {
      ...locked,
      fields: [...locked.fields, ...additions].sort((left, right) => left.number - right.number),
    });
    addedFields += additions.length;
  }

  if (missingMessages.length > 0 && !update) {
    throw new Error(
      `schema lock is missing ${missingMessages.length} message(s): ${missingMessages.map((item) => item.key).join(", ")}. ` +
        "Review the schemas, then run npm run codegen:proto:update-lock.",
    );
  }
  if (!update || (missingMessages.length === 0 && addedFields === 0)) return;

  for (const message of missingMessages) entries.set(message.key, message);
  const next = {
    version: 1,
    entries: [...entries.values()].sort((left, right) => left.key.localeCompare(right.key, "en")),
  };
  await writeFile(schemaLockFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  console.log(
    `updated schema lock: ${missingMessages.length} message(s), ${addedFields} field(s) added`,
  );
}

function toSchemaEntry(message) {
  return {
    key: message.opcodeKey,
    name: message.name,
    base: message.base ?? null,
    response: message.responseType ?? null,
    fields: message.fields
      .map((field) => ({
        number: field.fieldNo,
        name: field.protoName,
        type: field.type,
        repeated: field.repeated,
        synthetic: Boolean(field.synthetic),
      }))
      .sort((left, right) => left.number - right.number),
  };
}

function compareSchemaEntry(current, locked) {
  if (locked.name !== current.name) {
    throw new Error(
      `schema lock mismatch for ${current.key}: message name changed from ${locked.name} to ${current.name}`,
    );
  }
  for (const property of ["base", "response"]) {
    if ((locked[property] ?? null) !== (current[property] ?? null)) {
      throw new Error(
        `schema lock mismatch for ${current.key}: ${property} changed from ${locked[property] ?? "<none>"} to ${current[property] ?? "<none>"}`,
      );
    }
  }

  const byNumber = new Map(locked.fields.map((field) => [field.number, field]));
  const byName = new Map(locked.fields.map((field) => [field.name, field]));
  const additions = [];
  for (const field of current.fields) {
    const previous = byNumber.get(field.number);
    if (previous) {
      for (const property of ["name", "type", "repeated", "synthetic"]) {
        if (previous[property] !== field[property]) {
          throw new Error(
            `schema lock mismatch for ${current.key} field ${field.number}: ${property} changed from ${previous[property]} to ${field[property]}`,
          );
        }
      }
      continue;
    }
    const previousName = byName.get(field.name);
    if (previousName) {
      throw new Error(
        `schema lock mismatch for ${current.key}: field ${field.name} moved from ${previousName.number} to ${field.number}`,
      );
    }
    additions.push(field);
  }
  return additions;
}

async function readSchemaLock(allowMissing) {
  try {
    const lock = JSON.parse(await readFile(schemaLockFile, "utf8"));
    if (lock?.version !== 1 || !Array.isArray(lock.entries)) {
      throw new Error("schema lock must contain version=1 and an entries array");
    }
    for (const entry of lock.entries) {
      if (typeof entry.key !== "string" || !Array.isArray(entry.fields)) {
        throw new Error("schema lock entries require key and fields");
      }
    }
    return lock;
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return { version: 1, entries: [] };
    if (error?.code === "ENOENT") {
      throw new Error(
        "proto/schema.lock.json is missing; initialize it with npm run codegen:proto:update-lock",
      );
    }
    throw error;
  }
}

function runProtocolLockSelfTests() {
  const field = (overrides = {}) => ({
    number: 1,
    name: "value",
    type: "uint32",
    repeated: false,
    synthetic: false,
    ...overrides,
  });
  const locked = {
    key: "proto/Test_C_100.proto#C2S_Test",
    name: "C2S_Test",
    base: "IRequest",
    response: "S2C_Test",
    fields: [field()],
  };
  const current = (overrides = {}) => ({
    ...locked,
    fields: [field()],
    ...overrides,
  });

  assert.deepEqual(compareSchemaEntry(current(), locked), []);
  assert.deepEqual(compareSchemaEntry(current({ fields: [] }), locked), []);
  assert.deepEqual(
    compareSchemaEntry(current({ fields: [field(), field({ number: 2, name: "added" })] }), locked),
    [field({ number: 2, name: "added" })],
  );
  assert.throws(
    () => compareSchemaEntry(current({ fields: [field({ number: 2 })] }), locked),
    /moved from 1 to 2/,
  );
  assert.throws(
    () => compareSchemaEntry(current({ fields: [field({ type: "string" })] }), locked),
    /type changed/,
  );
  assert.throws(
    () => compareSchemaEntry(current({ fields: [field({ repeated: true })] }), locked),
    /repeated changed/,
  );
  assert.throws(
    () => compareSchemaEntry(current({ base: "IMessage" }), locked),
    /base changed/,
  );
  assert.throws(
    () => compareSchemaEntry(current({ response: "S2C_Other" }), locked),
    /response changed/,
  );
  assert.throws(
    () => compareSchemaEntry(current({ fields: [field({ name: "replacement" })] }), locked),
    /name changed/,
  );
  console.log("protocol lock self-test passed");
}

function isProtocolMessage(message) {
  return (
    message.codeName !== undefined ||
    message.explicitCode !== undefined ||
    isMessageBase(message.base)
  );
}

function isMessageBase(base) {
  return base !== undefined && knownBaseTypes.has(base);
}

function baseCarriesRpcId(base) {
  return base !== undefined && /(?:Request|Response)$/.test(base);
}

function baseCarriesError(base) {
  return base !== undefined && /(?:Response)$/.test(base);
}

function parseMsgCodes(messages) {
  return messages
    .filter((message) => message.codeName !== undefined)
    .map((message) => ({
      scope: message.opcodeScope,
      name: message.codeName,
      value: message.code,
    }));
}

function parseRpcs(messages) {
  const byName = new Map(messages.map((message) => [message.name, message]));
  const rpcs = [];

  for (const message of messages) {
    if (!message.responseType) continue;

    if (!message.codeName) {
      throw new Error(`${message.name} declares response but has no @ets.msg code`);
    }

    const response = byName.get(message.responseType);
    if (!response) {
      throw new Error(`${message.name} response type not found: ${message.responseType}`);
    }
    if (!response.codeName) {
      throw new Error(`${response.name} must declare @ets.msg because it is a response`);
    }
    if (!message.protocol) {
      throw new Error(`${message.name} RPC annotation must declare protocol=...`);
    }
    if (!/(?:Request)$/.test(message.base ?? "")) {
      throw new Error(`${message.name} declares response but is not a Request type`);
    }
    if (!/(?:Response)$/.test(response.base ?? "")) {
      throw new Error(`${response.name} is used as response but is not a Response type`);
    }
    validateTransferPolicy(message, true);

    rpcs.push({
      serviceName: message.protocol,
      requestCodeName: message.codeName,
      requestCode: message.code,
      responseCodeName: response.codeName,
      responseCode: response.code,
      methodName: message.method ?? defaultRpcMethodName(message.name),
      requestType: message.name,
      responseType: response.name,
      routing: (message.base ?? "").startsWith("IActorLocation")
        ? "actor-location"
        : undefined,
      duringTransfer: message.duringTransfer,
    });
  }

  return rpcs;
}

function parseMessageDescriptors(messages) {
  const descriptors = messages
    .filter(
      (message) =>
        message.protocol &&
        message.codeName &&
        /(?:Message)$/.test(message.base ?? ""),
    )
    .map((message) => {
      validateTransferPolicy(message, false);
      return {
        serviceName: message.protocol,
        codeName: message.codeName,
        code: message.code,
        methodName: message.method ?? defaultMessageMethodName(message.name),
        messageType: message.name,
        routing: (message.base ?? "").startsWith("IActorLocation")
          ? "actor-location"
          : undefined,
        duringTransfer: message.duringTransfer,
      };
    });
  return descriptors;
}

function validateTransferPolicy(message, rpc) {
  const policy = message.duringTransfer;
  if (policy === undefined) return;
  if (!(message.base ?? "").startsWith("IActorLocation")) {
    throw new Error(`${message.name} duringTransfer requires an IActorLocation base`);
  }
  const allowed = rpc ? new Set(["queue", "reject"]) : new Set(["queue", "reject", "drop", "latest"]);
  if (!allowed.has(policy)) {
    throw new Error(`${message.name} has invalid duringTransfer=${policy}`);
  }
}

function parseBroadcastDescriptors(messages) {
  const descriptors = [];
  for (const message of messages) {
    if (!message.broadcast) continue;
    if (!message.protocol || !message.codeName) {
      throw new Error(`${message.name} broadcast requires @ets.msg protocol=...`);
    }

    const mode = message.broadcast.mode;
    if (mode !== "event" && mode !== "latest") {
      throw new Error(`${message.name} broadcast mode must be event or latest`);
    }
    const methodName = message.method ?? defaultMessageMethodName(message.name);
    if (mode === "event" && !message.broadcast.items) {
      descriptors.push({
        serviceName: message.protocol,
        methodName,
        messageType: message.name,
        itemType: message.name,
        mode,
      });
      continue;
    }

    const itemsField = findBroadcastField(message, message.broadcast.items, true);
    const itemType = message.broadcast.item ?? itemsField.type;
    if (itemsField.type !== itemType) {
      throw new Error(
        `${message.name} broadcast item ${itemType} does not match ${itemsField.protoName}:${itemsField.type}`,
      );
    }
    const tickField = message.broadcast.tick
      ? findBroadcastField(message, message.broadcast.tick, false)
      : undefined;
    if (mode === "latest" && !message.broadcast.key) {
      throw new Error(`${message.name} latest broadcast requires key=...`);
    }
    const keyFields = message.broadcast.key
      ? message.broadcast.key.split(",").map((field) => field.trim()).filter(Boolean)
      : undefined;
    descriptors.push({
      serviceName: message.protocol,
      methodName,
      messageType: message.name,
      itemType,
      itemsField: itemsField.tsName,
      tickField: tickField?.tsName,
      keyFields: keyFields?.map(toCamel),
      mode,
    });
  }
  return descriptors;
}

function findBroadcastField(message, fieldName, repeated) {
  if (!fieldName) {
    throw new Error(`${message.name} broadcast requires items=...`);
  }
  const field = message.fields.find(
    (candidate) => candidate.protoName === fieldName || candidate.tsName === fieldName,
  );
  if (!field) throw new Error(`${message.name} broadcast field not found: ${fieldName}`);
  if (field.repeated !== repeated) {
    throw new Error(
      `${message.name}.${field.protoName} must ${repeated ? "be repeated" : "not be repeated"}`,
    );
  }
  return field;
}

function stripSuffix(value, suffix) {
  return value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;
}

function defaultRpcMethodName(messageName) {
  const withoutRequest = stripSuffix(messageName, "Request");
  return withoutRequest.replace(/^[A-Za-z0-9]+2[A-Za-z0-9]+_/, "");
}

function defaultMessageMethodName(messageName) {
  return messageName.replace(/^[A-Za-z0-9]+2[A-Za-z0-9]+_/, "");
}

function validateBaseTypes(messages) {
  for (const message of messages) {
    if (message.base && !knownBaseTypes.has(message.base)) {
      throw new Error(`unknown message base ${message.base} on ${message.name}`);
    }
  }
}

function scalarTsType(type) {
  if (type === "string") return "string";
  if (type === "bytes") return "Uint8Array";
  if (type === "bool") return "boolean";
  if (["uint64", "int64"].includes(type)) return "bigint";
  if (["uint32", "int32", "sint32", "float", "double"].includes(type)) {
    return "number";
  }
  return type;
}

function tsType(field) {
  const valueType = scalarTsType(field.type);
  return field.repeated ? `readonly ${valueType}[]` : valueType;
}

function defaultValue(field) {
  if (field.repeated) return "[]";
  const { type } = field;
  if (type === "string") return '""';
  if (type === "bytes") return "new Uint8Array(0)";
  if (type === "bool") return "false";
  if (["uint64", "int64"].includes(type)) return "0n";
  if (["uint32", "int32", "sint32", "float", "double"].includes(type)) {
    return "0";
  }
  return `${type}Codec.decode(new Uint8Array(0))`;
}

function wireType(type) {
  if (type === "string" || type === "bytes") return 2;
  if (["uint32", "int32", "sint32", "uint64", "int64", "bool"].includes(type)) return 0;
  if (type === "double") return 1;
  if (type === "float") return 5;
  return 2;
}

function readerCall(type) {
  if (type === "string") return "reader.string()";
  if (type === "bytes") return "reader.bytesField()";
  if (["uint32", "int32", "sint32", "uint64", "int64", "bool", "float", "double"].includes(type)) {
    return `reader.${type}()`;
  }
  return `${type}Codec.decode(reader.bytesField())`;
}

function writerCall(field) {
  const access = `value.${field.tsName}`;
  const writeValue = supportedTypes.has(field.type)
    ? `writer.${field.type}(${field.fieldNo}, item, true);`
    : `writer.bytes(${field.fieldNo}, ${field.type}Codec.encode(item), true);`;
  if (field.repeated) {
    return `    for (const item of (${access} ?? [])) ${writeValue}`;
  }
  if (field.optional) {
    return `    if (${access} !== undefined) writer.${field.type}(${field.fieldNo}, ${access});`;
  }

  if (supportedTypes.has(field.type)) {
    return `    if (${access} !== undefined) writer.${field.type}(${field.fieldNo}, ${access});`;
  }
  return `    if (${access} !== undefined) writer.bytes(${field.fieldNo}, ${field.type}Codec.encode(${access}));`;
}

function emitInterface(message) {
  const extendsClause = message.base ? ` extends ${message.base}` : "";

  if (message.fields.length === 0) {
    return `export interface ${message.name}${extendsClause} {}`;
  }

  const fields = message.fields
    .map(
      (field) =>
        `  ${field.tsName}${field.optional ? "?" : ""}: ${tsType(field)};`,
    )
    .join("\n");
  return `export interface ${message.name}${extendsClause} {\n${fields}\n}`;
}

function emitCodec(message) {
  const decodeBody =
    message.fields.length === 0
      ? `    return {};`
      : [
          `    const reader = new BinaryReader(payload);`,
          `    const value: ${message.name} = {`,
          ...message.fields
            .filter((field) => !field.optional)
            .map(
              (field) => `      ${field.tsName}: ${defaultValue(field)},`,
            ),
          `    };`,
          `    while (!reader.eof()) {`,
          `      const tag = reader.tag();`,
          ...message.fields.flatMap((field, index) => [
            `      ${index === 0 ? "if" : "else if"} (tag.fieldNo === ${field.fieldNo} && tag.wireType === ${wireType(field.type)}) {`,
            field.repeated
              ? `        (value.${field.tsName} as ${scalarTsType(field.type)}[]).push(${readerCall(field.type)});`
              : `        value.${field.tsName} = ${readerCall(field.type)};`,
            `      }`,
          ]),
          `      else {`,
          `        reader.skip(tag.wireType);`,
          `      }`,
          `    }`,
          `    return value;`,
        ].join("\n");

  const encodeBody =
    message.fields.length === 0
      ? `    return new Uint8Array(0);`
      : [
          `    const writer = new BinaryWriter();`,
          ...message.fields.map((field) => writerCall(field)),
          `    return writer.finish();`,
        ].join("\n");

  const valueName = message.fields.length === 0 ? "_value" : "value";

  return `export const ${message.name}Codec = {
  decode(payload: Uint8Array): ${message.name} {
${decodeBody}
  },

  encode(${valueName}: ${message.name}): Uint8Array {
${encodeBody}
  },
};`;
}

function emitCppProtocol(protocol) {
  const namespaceName = protocol.packageDir
    .split(/[\\/]/)
    .map((part) => part.replace(/[^A-Za-z0-9_]/g, "_"))
    .filter(Boolean)
    .join("::");
  const namespaceOpen = namespaceName ? `namespace tiangz::protocol::${namespaceName} {` : "namespace tiangz::protocol {";
  const namespaceClose = namespaceName ? `} // namespace tiangz::protocol::${namespaceName}` : "} // namespace tiangz::protocol";
  const messages = sortCppMessages(protocol.messages);
  return [
    "// Generated by tools/codegen_proto.mjs. Do not edit by hand.",
    "#pragma once",
    "",
    "#include <cstdint>",
    "#include <optional>",
    "#include <string>",
    "#include <vector>",
    "",
    '#include "tiangz/client/Binary.h"',
    '#include "tiangz/client/Protocol.h"',
    "",
    namespaceOpen,
    "",
    ...messages.flatMap((message) => [emitCppMessage(message), ""]),
    emitCppMsgCodes(protocol),
    "",
    ...protocol.rpcs.flatMap((rpc) => [emitCppRpc(rpc), ""]),
    ...protocol.messageDescriptors.flatMap((descriptor) => [emitCppMessageDescriptor(descriptor), ""]),
    namespaceClose,
    "",
  ].join("\n");
}

function sortCppMessages(messages) {
  const byName = new Map(messages.map((message) => [message.name, message]));
  const emitted = new Set();
  const visiting = new Set();
  const result = [];

  const visit = (message) => {
    if (emitted.has(message.name)) return;
    if (visiting.has(message.name)) {
      throw new Error(`C++ client SDK does not support recursive message dependency: ${message.name}`);
    }
    visiting.add(message.name);
    for (const field of message.fields) {
      const dependency = byName.get(field.type);
      if (dependency) visit(dependency);
    }
    visiting.delete(message.name);
    emitted.add(message.name);
    result.push(message);
  };

  for (const message of messages) visit(message);
  return result;
}

function emitCppMessage(message) {
  const fields = message.fields.map((field) => `  ${cppFieldType(field)} ${field.tsName}${cppDefault(field)};`);
  const decodeCases = message.fields.map((field) => [
    `        case ${field.fieldNo}:`,
    `          if (tag.wireType == ${wireType(field.type)}) {`,
    `            ${cppReaderAssignment(field)}`,
    "          } else {",
    "            reader.Skip(tag.wireType);",
    "          }",
    "          break;",
  ].join("\n"));
  const encodeLines = message.fields.map(cppWriterCall);
  return [
    `struct ${message.name} {`,
    ...fields,
    "};",
    "",
    `struct ${message.name}Codec {`,
    `  static ${message.name} Decode(const tiangz::client::Bytes& payload) {`,
    "    tiangz::client::BinaryReader reader(payload);",
    `    ${message.name} value;`,
    "    while (!reader.Eof()) {",
    "      const auto tag = reader.Tag();",
    "      switch (tag.fieldNo) {",
    ...decodeCases,
    "        default:",
    "          reader.Skip(tag.wireType);",
    "          break;",
    "      }",
    "    }",
    "    return value;",
    "  }",
    "",
    `  static tiangz::client::Bytes Encode(const ${message.name}& value) {`,
    "    tiangz::client::BinaryWriter writer;",
    ...encodeLines,
    "    return writer.Finish();",
    "  }",
    "};",
  ].join("\n");
}

function cppScalarType(type) {
  if (type === "string") return "std::string";
  if (type === "bytes") return "tiangz::client::Bytes";
  if (type === "bool") return "bool";
  if (type === "uint32") return "std::uint32_t";
  if (["int32", "sint32"].includes(type)) return "std::int32_t";
  if (type === "uint64") return "std::uint64_t";
  if (type === "int64") return "std::int64_t";
  if (type === "float") return "float";
  if (type === "double") return "double";
  return type;
}

function cppFieldType(field) {
  const scalar = cppScalarType(field.type);
  if (field.repeated) return `std::vector<${scalar}>`;
  if (field.optional) return `std::optional<${scalar}>`;
  return scalar;
}

function cppDefault(field) {
  if (field.repeated || field.optional || !supportedTypes.has(field.type)) return "";
  if (field.type === "bool") return " = false";
  if (["float", "double"].includes(field.type)) return " = 0.0";
  if (["uint32", "int32", "sint32", "uint64", "int64"].includes(field.type)) return " = 0";
  return "";
}

function cppReaderExpression(type) {
  if (type === "string") return "reader.String()";
  if (type === "bytes") return "reader.BytesField()";
  if (type === "uint32") return "reader.UInt32()";
  if (type === "int32") return "reader.Int32()";
  if (type === "sint32") return "reader.SInt32()";
  if (type === "uint64") return "reader.UInt64()";
  if (type === "int64") return "reader.Int64()";
  if (type === "bool") return "reader.Bool()";
  if (type === "float") return "reader.Float()";
  if (type === "double") return "reader.Double()";
  return `${type}Codec::Decode(reader.BytesField())`;
}

function cppReaderAssignment(field) {
  const expression = cppReaderExpression(field.type);
  return field.repeated
    ? `value.${field.tsName}.push_back(${expression});`
    : `value.${field.tsName} = ${expression};`;
}

function cppWriterMethod(type) {
  if (type === "string") return "String";
  if (type === "bytes") return "BytesField";
  if (type === "uint32") return "UInt32";
  if (type === "int32") return "Int32";
  if (type === "sint32") return "SInt32";
  if (type === "uint64") return "UInt64";
  if (type === "int64") return "Int64";
  if (type === "bool") return "Bool";
  if (type === "float") return "Float";
  if (type === "double") return "Double";
  return undefined;
}

function cppWriterCall(field) {
  const method = cppWriterMethod(field.type);
  const write = (access, writeDefault = false) => method
    ? `writer.${method}(${field.fieldNo}, ${access}${writeDefault ? ", true" : ""});`
    : `writer.BytesField(${field.fieldNo}, ${field.type}Codec::Encode(${access})${writeDefault ? ", true" : ""});`;
  if (field.repeated) return `    for (const auto& item : value.${field.tsName}) ${write("item", true)}`;
  if (field.optional) return `    if (value.${field.tsName}.has_value()) ${write(`*value.${field.tsName}`)}`;
  return `    ${write(`value.${field.tsName}`)}`;
}

function emitCppMsgCodes(protocol) {
  return [
    "namespace MsgCode {",
    ...protocol.msgCodes.map((entry) => `inline constexpr std::uint16_t ${entry.name} = ${entry.value};`),
    "} // namespace MsgCode",
  ].join("\n");
}

function emitCppRpc(rpc) {
  return `inline constexpr tiangz::client::RpcDescriptor<${rpc.requestType}, ${rpc.responseType}, ${rpc.requestType}Codec, ${rpc.responseType}Codec> ${rpc.serviceName}_${rpc.methodName}{\n  \"${rpc.serviceName}.${rpc.methodName}\", MsgCode::${rpc.requestCodeName}, MsgCode::${rpc.responseCodeName}\n};`;
}

function emitCppMessageDescriptor(descriptor) {
  return `inline constexpr tiangz::client::MessageDescriptor<${descriptor.messageType}, ${descriptor.messageType}Codec> ${descriptor.serviceName}_${descriptor.methodName}{\n  \"${descriptor.serviceName}.${descriptor.methodName}\", MsgCode::${descriptor.codeName}\n};`;
}

async function writeProtocol(protocol, outputDir, runtimeFiles) {
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, "messages.ts"),
    emitMessages(protocol, outputDir, runtimeFiles),
    "utf8",
  );
  await writeFile(path.join(outputDir, "msgcodes.ts"), emitMsgCodes(protocol), "utf8");
  await writeFile(
    path.join(outputDir, "rpcs.ts"),
    emitRpcs(protocol, outputDir, runtimeFiles),
    "utf8",
  );
  await writeFile(
    path.join(outputDir, "messageDescriptors.ts"),
    emitMessageDescriptors(protocol, outputDir, runtimeFiles),
    "utf8",
  );
  if (runtimeFiles.socket) {
    await writeFile(
      path.join(outputDir, "clients.ts"),
      emitClients(protocol, outputDir, runtimeFiles),
      "utf8",
    );
  }
  if (protocol.target === "server" && runtimeFiles.broadcast) {
    await writeFile(
      path.join(outputDir, "broadcastDescriptors.ts"),
      emitBroadcastDescriptors(protocol, outputDir, runtimeFiles),
      "utf8",
    );
  }
}

function emitMessages(protocol, outputDir, runtimeFiles) {
  const usedBaseTypes = [
    ...new Set(protocol.messages.map((message) => message.base).filter(Boolean)),
  ].sort();
  const binaryImport = toTsImport(
    outputDir,
    runtimeFiles.binary,
  );
  const messageImport = toTsImport(
    outputDir,
    runtimeFiles.message,
  );

  return [
    "// Generated by tools/codegen_proto.mjs. Do not edit by hand.",
    `import { BinaryReader, BinaryWriter } from "${binaryImport}";`,
    usedBaseTypes.length > 0
      ? `import type { ${usedBaseTypes.join(", ")} } from "${messageImport}";`
      : "",
    "",
    ...protocol.messages.flatMap((message) => [
      emitInterface(message),
      "",
      emitCodec(message),
      "",
    ]),
  ].join("\n");
}

function emitMsgCodes(protocol) {
  const byScope = new Map();
  for (const entry of protocol.msgCodes) {
    const list = byScope.get(entry.scope) ?? [];
    list.push(entry);
    byScope.set(entry.scope, list);
  }

  const scopeBlocks = [...byScope.entries()].map(([scope, entries]) => {
    assertIdentifier(scope, "opcode scope");
    return [
      `export const ${scope} = {`,
      ...entries.map((entry) => `  ${entry.name}: ${entry.value},`),
      "} as const;",
      "",
    ].join("\n");
  });

  return [
    "// Generated by tools/codegen_proto.mjs. Do not edit by hand.",
    ...scopeBlocks,
    "export const MsgCode = {",
    ...[...byScope.keys()].map((scope) => `  ...${scope},`),
    "} as const;",
    "",
  ].join("\n");
}

function assertIdentifier(value, label) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) {
    throw new Error(`${label} must be a valid TypeScript identifier: ${value}`);
  }
}

function validateProtocol(protocol, label, allowUnknownFieldTypes = false) {
  const seenCodes = new Map();
  const seenCodeNames = new Map();
  const seenMessages = new Set();
  const seenRpcNames = new Set();
  const seenMessageDescriptorNames = new Set();
  const seenBroadcastDescriptorNames = new Set();

  for (const message of protocol.messages) {
    if (seenMessages.has(message.name)) {
      throw new Error(`${label}: duplicate message type ${message.name}`);
    }
    seenMessages.add(message.name);
  }

  for (const message of protocol.messages) {
    for (const field of message.fields) {
      if (supportedTypes.has(field.type)) continue;
      if (!seenMessages.has(field.type) && !allowUnknownFieldTypes) {
        throw new Error(
          `${label}: unknown proto field type ${field.type} on ${message.name}.${field.protoName}`,
        );
      }
    }
  }

  for (const entry of protocol.msgCodes) {
    const previousName = seenCodeNames.get(entry.name);
    if (previousName !== undefined) {
      throw new Error(`${label}: duplicate msgcode name ${entry.name}`);
    }
    seenCodeNames.set(entry.name, entry.value);

    const previous = seenCodes.get(entry.value);
    if (previous) {
      throw new Error(
        `${label}: duplicate msgcode ${entry.value}: ${previous} and ${entry.name}`,
      );
    }
    seenCodes.set(entry.value, entry.name);
    if (entry.value === 29_999) {
      throw new Error(`${label}: msgcode 29999 is reserved for ActorLocation routing`);
    }
  }

  for (const rpc of protocol.rpcs) {
    const name = `${rpc.serviceName}.${rpc.methodName}`;
    if (seenRpcNames.has(name)) {
      throw new Error(`${label}: duplicate rpc descriptor ${name}`);
    }
    seenRpcNames.add(name);
  }

  for (const descriptor of protocol.messageDescriptors) {
    const name = `${descriptor.serviceName}.${descriptor.methodName}`;
    if (seenMessageDescriptorNames.has(name)) {
      throw new Error(`${label}: duplicate message descriptor ${name}`);
    }
    seenMessageDescriptorNames.add(name);
  }

  for (const descriptor of protocol.broadcastDescriptors ?? []) {
    const name = `${descriptor.serviceName}.${descriptor.methodName}`;
    if (seenBroadcastDescriptorNames.has(name)) {
      throw new Error(`${label}: duplicate broadcast descriptor ${name}`);
    }
    seenBroadcastDescriptorNames.add(name);
  }
}

function emitMessageDescriptors(protocol, outputDir, runtimeFiles) {
  if (protocol.messageDescriptors.length === 0) {
    return [
      "// Generated by tools/codegen_proto.mjs. Do not edit by hand.",
      "export const AllMessageDescriptors = [] as const;",
      "",
    ].join("\n");
  }

  const messageImports = [
    ...new Set(
      protocol.messageDescriptors.flatMap((descriptor) => [
        descriptor.messageType,
        `${descriptor.messageType}Codec`,
      ]),
    ),
  ].sort();
  const messageImport = toTsImport(outputDir, runtimeFiles.message);
  const byService = new Map();
  for (const descriptor of protocol.messageDescriptors) {
    const list = byService.get(descriptor.serviceName) ?? [];
    list.push(descriptor);
    byService.set(descriptor.serviceName, list);
  }

  const blocks = [...byService.entries()].map(([serviceName, descriptors]) => {
    const entries = descriptors.map(
      (descriptor) => `  ${descriptor.methodName}: defineMessage<${descriptor.messageType}>({
    name: "${serviceName}.${descriptor.methodName}",
    msgcode: MsgCode.${descriptor.codeName},
    codec: ${descriptor.messageType}Codec,
${descriptor.routing ? `    routing: "${descriptor.routing}",\n` : ""}${protocol.target === "server" && descriptor.duringTransfer ? `    duringTransfer: "${descriptor.duringTransfer}",\n` : ""}  }),`,
    );
    return `export const ${serviceName}Messages = {\n${entries.join("\n")}\n};`;
  });
  const allDescriptors = protocol.messageDescriptors.map(
    (descriptor) => `  ${descriptor.serviceName}Messages.${descriptor.methodName},`,
  );

  return [
    "// Generated by tools/codegen_proto.mjs. Do not edit by hand.",
    `import { defineMessage } from "${messageImport}";`,
    "import {",
    ...messageImports.map((name) => `  ${name},`),
    '} from "./messages";',
    'import { MsgCode } from "./msgcodes";',
    "",
    ...blocks.flatMap((block) => [block, ""]),
    "export const AllMessageDescriptors = [",
    ...allDescriptors,
    "] as const;",
    "",
  ].join("\n");
}

function emitBroadcastDescriptors(protocol, outputDir, runtimeFiles) {
  if ((protocol.broadcastDescriptors?.length ?? 0) === 0) {
    return [
      "// Generated by tools/codegen_proto.mjs. Do not edit by hand.",
      "export const AllBroadcastDescriptors = [] as const;",
      "",
    ].join("\n");
  }

  const descriptors = protocol.broadcastDescriptors;
  const messageTypes = [
    ...new Set(
      descriptors.flatMap((descriptor) => [
        descriptor.itemType,
        descriptor.messageType,
      ]),
    ),
  ].sort();
  const services = [...new Set(descriptors.map((item) => item.serviceName))].sort();
  const byService = new Map();
  for (const descriptor of descriptors) {
    const list = byService.get(descriptor.serviceName) ?? [];
    list.push(descriptor);
    byService.set(descriptor.serviceName, list);
  }

  const blocks = [...byService.entries()].map(([serviceName, items]) => {
    const entries = items.map((descriptor) => {
      const define = descriptor.mode === "latest"
        ? "defineLatestBroadcast"
        : "defineEventBroadcast";
      const makeMessage = descriptor.itemsField
        ? `(${descriptor.itemsField}, tick) => ({\n      ${descriptor.tickField ? `${descriptor.tickField}: tick,\n      ` : ""}${descriptor.itemsField}: [...${descriptor.itemsField}],\n    })`
        : `(items) => items[0]`;
      const keyExpression = descriptor.keyFields?.length === 1
        ? `item.${descriptor.keyFields[0]}`
        : `\`${descriptor.keyFields?.map((field) => `\${item.${field}}`).join(":")}\``;
      const key = descriptor.mode === "latest"
        ? `\n    keyOf: (item) => ${keyExpression},`
        : "";
      return `  ${descriptor.methodName}: ${define}<${descriptor.itemType}, ${descriptor.messageType}>({
    name: "${serviceName}.${descriptor.methodName}",
    message: ${serviceName}Messages.${descriptor.methodName},${key}
    batchItems: ${descriptor.itemsField ? "true" : "false"},
    makeMessage: ${makeMessage},
  }),`;
    });
    return `export const ${serviceName}Broadcasts = {\n${entries.join("\n")}\n};`;
  });
  const allDescriptors = descriptors.map(
    (descriptor) => `  ${descriptor.serviceName}Broadcasts.${descriptor.methodName},`,
  );
  const broadcastImport = toTsImport(outputDir, runtimeFiles.broadcast);

  return [
    "// Generated by tools/codegen_proto.mjs. Do not edit by hand.",
    `import { defineEventBroadcast, defineLatestBroadcast } from "${broadcastImport}";`,
    `import type { ${messageTypes.join(", ")} } from "./messages";`,
    `import { ${services.map((name) => `${name}Messages`).join(", ")} } from "./messageDescriptors";`,
    "",
    ...blocks.flatMap((block) => [block, ""]),
    "export const AllBroadcastDescriptors = [",
    ...allDescriptors,
    "] as const;",
    "",
  ].join("\n");
}

function emitRpcs(protocol, outputDir, runtimeFiles) {
  if (protocol.rpcs.length === 0) {
    return [
      "// Generated by tools/codegen_proto.mjs. Do not edit by hand.",
      "export const AllRpcDescriptors = [] as const;",
      "",
    ].join("\n");
  }

  const messageImports = [
    ...new Set(
      protocol.rpcs.flatMap((rpc) => [
        rpc.requestType,
        `${rpc.requestType}Codec`,
        rpc.responseType,
        `${rpc.responseType}Codec`,
      ]),
    ),
  ].sort();
  const rpcImport = toTsImport(
    outputDir,
    runtimeFiles.rpc,
  );

  const byService = new Map();
  for (const rpc of protocol.rpcs) {
    const list = byService.get(rpc.serviceName) ?? [];
    list.push(rpc);
    byService.set(rpc.serviceName, list);
  }

  const blocks = [...byService.entries()].map(([serviceName, rpcs]) => {
    const entries = rpcs.map(
      (rpc) => `  ${rpc.methodName}: defineRpc<${rpc.requestType}, ${rpc.responseType}>({
    name: "${serviceName}.${rpc.methodName}",
    requestCode: MsgCode.${rpc.requestCodeName},
    responseCode: MsgCode.${rpc.responseCodeName},
    requestCodec: ${rpc.requestType}Codec,
    responseCodec: ${rpc.responseType}Codec,
${rpc.routing ? `    routing: "${rpc.routing}",\n` : ""}${protocol.target === "server" && rpc.duringTransfer ? `    duringTransfer: "${rpc.duringTransfer}",\n` : ""}  }),`,
    );
    return `export const ${serviceName}Protocol = {\n${entries.join("\n")}\n};`;
  });
  const allDescriptors = protocol.rpcs.map(
    (rpc) => `  ${rpc.serviceName}Protocol.${rpc.methodName},`,
  );

  return [
    "// Generated by tools/codegen_proto.mjs. Do not edit by hand.",
    `import { defineRpc } from "${rpcImport}";`,
    "import {",
    ...messageImports.map((name) => `  ${name},`),
    '} from "./messages";',
    'import { MsgCode } from "./msgcodes";',
    "",
    ...blocks.flatMap((block) => [block, ""]),
    "export const AllRpcDescriptors = [",
    ...allDescriptors,
    "] as const;",
    "",
  ].join("\n");
}

function emitClients(protocol, outputDir, runtimeFiles) {
  const outboundMessages = protocol.messageDescriptors.filter(
    (descriptor) => descriptor.codeName.startsWith("C2"),
  );
  const services = new Map();
  for (const rpc of protocol.rpcs) {
    const service = services.get(rpc.serviceName) ?? { rpcs: [], messages: [] };
    service.rpcs.push(rpc);
    services.set(rpc.serviceName, service);
  }
  for (const descriptor of outboundMessages) {
    const service = services.get(descriptor.serviceName) ?? { rpcs: [], messages: [] };
    service.messages.push(descriptor);
    services.set(descriptor.serviceName, service);
  }
  if (services.size === 0) {
    return "// Generated by tools/codegen_proto.mjs. Do not edit by hand.\nexport {};\n";
  }

  const types = [...new Set([
    ...protocol.rpcs.flatMap((rpc) => [rpc.requestType, rpc.responseType]),
    ...outboundMessages.map((descriptor) => descriptor.messageType),
  ])].sort();
  const rpcServices = [...new Set(protocol.rpcs.map((rpc) => rpc.serviceName))].sort();
  const messageServices = [...new Set(outboundMessages.map((item) => item.serviceName))].sort();
  const socketImport = toTsImport(outputDir, runtimeFiles.socket);
  const blocks = [...services.entries()].map(([serviceName, service]) => {
    const methods = [
      ...service.rpcs.map((rpc) => `  ${lowerFirst(rpc.methodName)}(
    request: Omit<${rpc.requestType}, "rpcId">,
    options?: RpcCallOptions,
  ): Promise<${rpc.responseType}> {
    return this.socket.call(${rpc.serviceName}Protocol.${rpc.methodName}, request as ${rpc.requestType}, options);
  }`),
      ...service.messages.map((message) => `  ${lowerFirst(message.methodName)}(
    message: ${message.messageType},
  ): Promise<void> {
    return this.socket.send(${message.serviceName}Messages.${message.methodName}, message);
  }`),
    ];
    return `export class ${serviceName}Client {
  constructor(private readonly socket: RpcSocket) {}

${methods.join("\n\n")}
}`;
  });
  return [
    "// Generated by tools/codegen_proto.mjs. Do not edit by hand.",
    `import { type RpcCallOptions, RpcSocket } from "${socketImport}";`,
    `import type { ${types.join(", ")} } from "./messages";`,
    rpcServices.length > 0 ? `import { ${rpcServices.map((name) => `${name}Protocol`).join(", ")} } from "./rpcs";` : "",
    messageServices.length > 0 ? `import { ${messageServices.map((name) => `${name}Messages`).join(", ")} } from "./messageDescriptors";` : "",
    "",
    ...blocks.flatMap((block) => [block, ""]),
  ].join("\n");
}

function lowerFirst(value) {
  return `${value[0].toLowerCase()}${value.slice(1)}`;
}

function toTsImport(fromDir, targetFile) {
  let relativePath = path.relative(fromDir, targetFile).replace(/\\/g, "/");
  relativePath = relativePath.replace(/\.ts$/, "");
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}
