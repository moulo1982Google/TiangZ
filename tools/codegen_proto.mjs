import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectGeneratedFiles, recordGenerator } from "./codegen_manifest.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptFile), "..");
const protoDir = path.join(root, "proto");
const generatedModelDir = path.join(root, "app", "generated", "model");
const generatedProtocolDirs = [
  path.join(generatedModelDir, "client"),
  path.join(generatedModelDir, "server"),
];
const appDir = path.join(root, "app");
const configFile = path.join(root, "codegen.config.json");
const codegenConfig = JSON.parse(
  await readFile(configFile, "utf8"),
);
const cocosClientConfig = resolveCocosClientConfig(
  codegenConfig.cocosClientProtocol,
);
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
  "ISocialMessage",
  "ISocialRequest",
  "ISocialResponse",
  "IRankMessage",
  "IRankRequest",
  "IRankResponse",
]);
const messageOptionKeys = new Set([
  "base",
  "response",
  "protocol",
  "service",
  "method",
]);

await main();

async function main() {
  const protoFiles = await discoverProtoFiles(protoDir);
  for (const generatedProtocolDir of generatedProtocolDirs) {
    await rm(generatedProtocolDir, { recursive: true, force: true });
  }
  if (cocosClientConfig) {
    await removeGeneratedTypeScript(cocosClientConfig.outputRoot);
  }

  const groups = new Map();
  for (const protoFile of protoFiles) {
    const fileInfo = parseProtoFileInfo(protoFile);
    const source = await readFile(protoFile, "utf8");
    const protocol = parseProto(source, fileInfo);
    validateProtocol(protocol, fileInfo.fileName, true);

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

  for (const group of [...groups.values()].sort(compareProtocolGroup)) {
    validateProtocol(group, `${group.target}/${group.packageDir}`);
    const outputDir = path.join(
      generatedModelDir,
      group.target,
      group.packageDir,
      "protocol",
    );
    await writeProtocol(group, outputDir, appRuntimeFiles);
    if (cocosClientConfig && group.target === "client") {
      const cocosOutputDir = path.join(
        cocosClientConfig.outputRoot,
        group.packageDir,
        "protocol",
      );
      await writeProtocol(group, cocosOutputDir, cocosClientConfig.runtimeFiles);
    }
  }

  const outputRoots = [
    ...generatedProtocolDirs.map((outputPath) => ({ path: outputPath, extensions: [".ts"] })),
    ...(cocosClientConfig ? [{ path: cocosClientConfig.outputRoot, extensions: [".ts"] }] : []),
  ];
  await recordGenerator(root, {
    id: "proto",
    command: "npm run codegen:proto",
    contentInputs: [scriptFile, configFile, ...protoFiles],
    outputs: await collectGeneratedFiles(outputRoots),
    outputRoots,
  });
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

function resolveCocosClientConfig(config) {
  if (!config?.enabled) return undefined;
  for (const key of ["outputRoot", "binaryRuntime", "messageRuntime", "rpcRuntime"]) {
    if (typeof config[key] !== "string" || config[key].length === 0) {
      throw new Error(`cocosClientProtocol.${key} must be a non-empty path`);
    }
  }
  return {
    outputRoot: path.resolve(root, config.outputRoot),
    runtimeFiles: {
      binary: path.resolve(root, config.binaryRuntime),
      message: path.resolve(root, config.messageRuntime),
      rpc: path.resolve(root, config.rpcRuntime),
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

function parseProto(source, fileInfo) {
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
      ...meta,
    };
    addFrameworkFields(message);
    messages.push(message);
  }

  assignMessageCodes(messages, startOpcode);
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
  };

  const responseTypeMatch = comments.match(/\/\/\s*ResponseType\s+(\w+)/);
  if (responseTypeMatch) {
    meta.responseType = responseTypeMatch[1];
  }

  const msgMatch = comments.match(/\/\/\s*@ets\.msg\b([^\n]*)/);
  const broadcastMatch = comments.match(/\/\/\s*@ets\.broadcast\b([^\n]*)/);
  if (broadcastMatch) {
    meta.broadcast = Object.fromEntries(
      [...broadcastMatch[1].matchAll(/(\w+)=([A-Za-z0-9_]+)/g)].map(
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

function assignMessageCodes(messages, startOpcode) {
  let opcode = startOpcode;

  for (const message of messages) {
    if (!isProtocolMessage(message)) continue;

    message.codeName ??= message.name;
    if (message.explicitCode !== undefined) {
      message.code = message.explicitCode;
      continue;
    }

    opcode += 1;
    message.code = opcode;
  }
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
    });
  }

  return rpcs;
}

function parseMessageDescriptors(messages) {
  return messages
    .filter(
      (message) =>
        message.protocol &&
        message.codeName &&
        /(?:Message)$/.test(message.base ?? ""),
    )
    .map((message) => ({
      serviceName: message.protocol,
      codeName: message.codeName,
      code: message.code,
      methodName: message.method ?? defaultMessageMethodName(message.name),
      messageType: message.name,
      routing: (message.base ?? "").startsWith("IActorLocation")
        ? "actor-location"
        : undefined,
    }));
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
    descriptors.push({
      serviceName: message.protocol,
      methodName,
      messageType: message.name,
      itemType,
      itemsField: itemsField.tsName,
      tickField: tickField?.tsName,
      keyField: message.broadcast.key
        ? toCamel(message.broadcast.key)
        : undefined,
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
  if (["uint32", "int32", "sint32", "float", "double"].includes(type)) {
    return "0";
  }
  return `${type}Codec.decode(new Uint8Array(0))`;
}

function wireType(type) {
  if (type === "string" || type === "bytes") return 2;
  if (["uint32", "int32", "sint32", "bool"].includes(type)) return 0;
  if (type === "double") return 1;
  if (type === "float") return 5;
  return 2;
}

function readerCall(type) {
  if (type === "string") return "reader.string()";
  if (type === "bytes") return "reader.bytesField()";
  if (["uint32", "int32", "sint32", "bool", "float", "double"].includes(type)) {
    return `reader.${type}()`;
  }
  return `${type}Codec.decode(reader.bytesField())`;
}

function writerCall(field) {
  const access = `value.${field.tsName}`;
  const writeValue = supportedTypes.has(field.type)
    ? `writer.${field.type}(${field.fieldNo}, item);`
    : `writer.bytes(${field.fieldNo}, ${field.type}Codec.encode(item));`;
  if (field.repeated) {
    return `    for (const item of ${access}) ${writeValue}`;
  }
  if (field.optional) {
    return `    if (${access} !== undefined) writer.${field.type}(${field.fieldNo}, ${access});`;
  }

  if (supportedTypes.has(field.type)) {
    return `    writer.${field.type}(${field.fieldNo}, ${access});`;
  }
  return `    writer.bytes(${field.fieldNo}, ${field.type}Codec.encode(${access}));`;
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
${descriptor.routing ? `    routing: "${descriptor.routing}",\n` : ""}  }),`,
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
      const key = descriptor.mode === "latest"
        ? `\n    keyOf: (item) => item.${descriptor.keyField},`
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
${rpc.routing ? `    routing: "${rpc.routing}",\n` : ""}  }),`,
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

function toTsImport(fromDir, targetFile) {
  let relativePath = path.relative(fromDir, targetFile).replace(/\\/g, "/");
  relativePath = relativePath.replace(/\.ts$/, "");
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}
