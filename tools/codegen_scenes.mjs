import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { recordGenerator } from "./codegen_manifest.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptFile), "..");
const outputFile = path.join(root, "app", "generated", "bootstrap", "scenes.ts");
const handlerOutputFile = path.join(root, "app", "generated", "hotfix", "handlers.ts");
const patchOutputFile = path.join(root, "app", "generated", "hotfix", "patches.ts");
const benchHandlerOutputFile = path.join(root, "app", "generated", "hotfix", "handlers.bench.ts");
const systemDeclarationRoot = path.join(root, "app", "generated", "bootstrap", "systems");
const obsoleteSystemDeclarationRoot = path.join(root, "app", "generated", "model", "systems");
const configFile = path.join(root, "codegen.config.json");
const obsoleteSceneOutputFile = path.join(root, "app", "generated", "hotfix", "scenes.ts");
const obsoleteModelBootstrapDir = path.join(root, "app", "generated", "model", "bootstrap");

const config = await readCodegenConfig();
const sceneSearchRoots = resolveSearchRoots(
  config.serverBundles?.sceneSearchRoots ?? ["app/model"],
);
const handlerSearchRoots = resolveSearchRoots(
  config.serverBundles?.handlerSearchRoots ?? ["app/hotfix"],
);
const patchSearchRoots = resolveSearchRoots(
  config.serverBundles?.patchSearchRoots ?? config.serverBundles?.handlerSearchRoots ?? ["app/hotfix"],
);
const benchHandlerSearchRoots = resolveSearchRoots(
  config.serverBundles?.benchHandlerSearchRoots ?? ["app/hotfix/bench"],
);
const serverProtocolSearchRoots = resolveSearchRoots(
  config.serverBundles?.serverProtocolSearchRoots ?? ["app/generated/model/server"],
);

function toImportPath(file, generatedFile = outputFile) {
  const fromOutputDir = path.relative(path.dirname(generatedFile), file);
  const withoutExt = fromOutputDir.replace(/\.ts$/, "");
  return withoutExt.startsWith(".")
    ? withoutExt.replaceAll(path.sep, "/")
    : `./${withoutExt.replaceAll(path.sep, "/")}`;
}

async function readCodegenConfig() {
  try {
    const text = await readFile(configFile, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function resolveSearchRoots(items) {
  return items.map((item) => path.resolve(root, item));
}

async function collectFiles(searchRoots, predicate) {
  const files = [];

  for (const dir of searchRoots) {
    await collectFilesInDir(dir, predicate, files);
  }

  return files.sort((a, b) => a.localeCompare(b));
}

async function collectFilesInDir(dir, predicate, files) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      await collectFilesInDir(fullPath, predicate, files);
      continue;
    }
    if (entry.isFile() && predicate(fullPath)) {
      files.push(fullPath);
    }
  }
}

function shouldSkipDir(name) {
  return name === "generated" || name === "dist" || name === "node_modules";
}

function isSceneFile(file) {
  return (
    path.basename(file) !== "index.ts" &&
    file.endsWith(".ts") &&
    path.basename(path.dirname(file)) === "scenes"
  );
}

function isHandlerFile(file) {
  return (
    path.basename(file) !== "index.ts" &&
    file.endsWith(".ts") &&
    path.normalize(file).split(path.sep).includes("handlers")
  );
}

function isServerProtocolRpcsFile(file) {
  return (
    path.basename(file) === "rpcs.ts" &&
    path.basename(path.dirname(file)) === "protocol"
  );
}

function isServerProtocolMessagesFile(file) {
  return (
    path.basename(file) === "messageDescriptors.ts" &&
    path.basename(path.dirname(file)) === "protocol"
  );
}

const sceneFiles = await collectFiles(sceneSearchRoots, isSceneFile);
const handlerFiles = await collectFiles(handlerSearchRoots, isHandlerFile);
const legacyPatchFiles = await collectFiles(patchSearchRoots, isLegacyPatchFile);
const systemFiles = await collectFiles(patchSearchRoots, isSystemFile);
const patchFiles = [...legacyPatchFiles, ...systemFiles]
  .sort((left, right) => left.localeCompare(right));
const benchHandlerFiles = await collectFiles(benchHandlerSearchRoots, isHandlerFile);
const protocolFiles = await collectFiles(
  serverProtocolSearchRoots,
  isServerProtocolRpcsFile,
);
const messageProtocolFiles = await collectFiles(
  serverProtocolSearchRoots,
  isServerProtocolMessagesFile,
);
const systemGeneration = await generateSystemDeclarations(systemFiles);
const systemDeclarationFiles = systemGeneration.outputs;
const systemTargetImports = systemGeneration.targets
  .map(
    (target, index) =>
      `import { ${target.name} as SystemTarget${index} } from "${toImportPath(target.file)}";`,
  )
  .join("\n");
const requireSystemCalls = systemGeneration.targets
  .map((_, index) => `HotfixSystem.RequireType(SystemTarget${index});`)
  .join("\n");

const protocolImports = protocolFiles
  .map(
    (file, index) =>
      `import { AllRpcDescriptors as RpcDescriptors${index} } from "${toImportPath(file)}";`,
  )
  .join("\n");
const sceneImports = sceneFiles
  .map((file) => `import "${toImportPath(file)}";`)
  .join("\n");
const messageProtocolImports = messageProtocolFiles
  .map(
    (file, index) =>
      `import { AllMessageDescriptors as MessageDescriptors${index} } from "${toImportPath(file)}";`,
  )
  .join("\n");
const registerCalls = protocolFiles
  .map((_, index) => `registerKnownRpcs(RpcDescriptors${index});`)
  .join("\n");
const registerMessageCalls = messageProtocolFiles
  .map((_, index) => `registerKnownMessages(MessageDescriptors${index});`)
  .join("\n");
const content = `// Generated by tools/codegen_scenes.mjs. Do not edit by hand.
import { registerKnownRpcs } from "../../core/protocol/rpc";
import { registerKnownMessages } from "../../core/protocol/message";
import { HotfixSystem } from "../../core/hotReload/HotfixSystem";
${protocolImports}
${messageProtocolImports}
${sceneImports}
${systemTargetImports}

${registerCalls}
${registerMessageCalls}
${requireSystemCalls}
`;
const handlerContent = `// Generated by tools/codegen_scenes.mjs. Do not edit by hand.
${handlerFiles
  .map((file) => `import "${toImportPath(file, handlerOutputFile)}";`)
  .join("\n")}
`;
const patchContent = `// Generated by tools/codegen_scenes.mjs. Do not edit by hand.
${patchFiles
  .map((file) => `import "${toImportPath(file, patchOutputFile)}";`)
  .join("\n")}
`;
const benchHandlerContent = `// Generated by tools/codegen_scenes.mjs. Do not edit by hand.
${benchHandlerFiles
  .map((file) => `import "${toImportPath(file, benchHandlerOutputFile)}";`)
  .join("\n")}
`;

await mkdir(path.dirname(outputFile), { recursive: true });
await rm(obsoleteSceneOutputFile, { force: true });
await rm(obsoleteModelBootstrapDir, { recursive: true, force: true });
await writeFile(outputFile, content, "utf8");
await writeFile(handlerOutputFile, handlerContent, "utf8");
await writeFile(patchOutputFile, patchContent, "utf8");
await writeFile(benchHandlerOutputFile, benchHandlerContent, "utf8");
await recordGenerator(root, {
  id: "scenes",
  command: "npm run codegen:scenes",
  contentInputs: [scriptFile, configFile, ...systemFiles],
  selections: [
    { kind: "scene", roots: sceneSearchRoots, paths: sceneFiles },
    { kind: "handler", roots: handlerSearchRoots, paths: handlerFiles },
    { kind: "hotfix-patch", roots: patchSearchRoots, paths: legacyPatchFiles },
    { kind: "hotfix-system", roots: patchSearchRoots, paths: systemFiles },
    { kind: "bench-handler", roots: benchHandlerSearchRoots, paths: benchHandlerFiles },
    { kind: "protocol-rpc", roots: serverProtocolSearchRoots, paths: protocolFiles },
    { kind: "protocol-message", roots: serverProtocolSearchRoots, paths: messageProtocolFiles },
  ],
  outputs: [
    outputFile,
    handlerOutputFile,
    patchOutputFile,
    benchHandlerOutputFile,
    ...systemDeclarationFiles,
  ],
  outputRoots: [
    { path: path.dirname(outputFile), extensions: [".ts"] },
    { path: path.dirname(handlerOutputFile), extensions: [".ts"] },
    { path: systemDeclarationRoot, extensions: [".ts"] },
  ],
});

function isSystemFile(file) {
  return path.basename(file).endsWith("System.ts");
}

function isLegacyPatchFile(file) {
  return path.basename(file).endsWith("Hotfix.ts");
}

async function generateSystemDeclarations(files) {
  await rm(obsoleteSystemDeclarationRoot, { recursive: true, force: true });
  await rm(systemDeclarationRoot, { recursive: true, force: true });
  await mkdir(systemDeclarationRoot, { recursive: true });
  const modelTypes = await collectModelTypes();
  const outputs = [];
  const targets = new Set();
  const targetModels = [];

  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const declaration of source.statements) {
      if (!ts.isClassDeclaration(declaration)) continue;
      const targetName = systemTargetName(declaration);
      if (!targetName) continue;
      if (!declaration.name) throw new Error(`${relative(file)}: @systemFor class must have a name`);
      if (targets.has(targetName)) throw new Error(`duplicate @systemFor target: ${targetName}`);
      targets.add(targetName);

      const modelMatches = modelTypes.get(targetName) ?? [];
      if (modelMatches.length !== 1) {
        throw new Error(
          `${relative(file)}: @systemFor target ${targetName} resolved to ${modelMatches.length} Model classes`,
        );
      }
      targetModels.push({ name: targetName, file: modelMatches[0] });
      const output = path.join(systemDeclarationRoot, `${targetName}System.d.ts`);
      const targetModule = toImportPath(modelMatches[0], output);
      const modelPublic = toImportPath(path.join(root, "app", "model", "public.ts"), output);
      const members = systemPublicMembers(file, source, declaration);
      const imports = modelTypeImports(source, members.join("\n"));
      const importLine = imports.length > 0
        ? `import type { ${imports.join(", ")} } from "${modelPublic}";\n`
        : "";
      const content = `// Generated by tools/codegen_scenes.mjs. Do not edit by hand.\nimport "${targetModule}";\n${importLine}\ndeclare module "${targetModule}" {\n  interface ${targetName} {\n${members.map((member) => `    ${member}`).join("\n")}\n  }\n}\n\nexport {};\n`;
      await writeFile(output, content, "utf8");
      outputs.push(output);
    }
  }
  return {
    outputs: outputs.sort((left, right) => left.localeCompare(right)),
    targets: targetModels.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

async function collectModelTypes() {
  const files = await collectFiles(
    [path.join(root, "app", "model")],
    (file) => file.endsWith(".ts"),
  );
  const result = new Map();
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const declaration of source.statements) {
      if (!ts.isClassDeclaration(declaration) || !declaration.name) continue;
      const matches = result.get(declaration.name.text) ?? [];
      matches.push(file);
      result.set(declaration.name.text, matches);
    }
  }
  return result;
}

function systemTargetName(declaration) {
  for (const decorator of ts.getDecorators(declaration) ?? []) {
    if (!ts.isCallExpression(decorator.expression)) continue;
    const call = decorator.expression;
    if (!ts.isIdentifier(call.expression) || call.expression.text !== "systemFor") continue;
    if (call.arguments.length !== 1 || !ts.isIdentifier(call.arguments[0])) {
      throw new Error("@systemFor requires one Model class identifier");
    }
    return call.arguments[0].text;
  }
  return undefined;
}

function systemPublicMembers(file, source, declaration) {
  const result = [];
  const accessors = new Map();
  for (const member of declaration.members) {
    if (hasModifier(member, ts.SyntaxKind.PrivateKeyword) || hasModifier(member, ts.SyntaxKind.ProtectedKeyword)) {
      continue;
    }
    if (ts.isMethodDeclaration(member)) {
      if (!member.name || !member.type) {
        throw new Error(`${relative(file)}: public System methods require explicit return types`);
      }
      const typeParameters = member.typeParameters?.map((item) => item.getText(source)).join(", ");
      const parameters = member.parameters.map((parameter) => parameterSignature(file, source, parameter));
      result.push(
        `${member.name.getText(source)}${typeParameters ? `<${typeParameters}>` : ""}(${parameters.join(", ")}): ${member.type.getText(source)};`,
      );
      continue;
    }
    if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
      const name = member.name.getText(source);
      const current = accessors.get(name) ?? {};
      if (ts.isGetAccessorDeclaration(member)) {
        if (!member.type) throw new Error(`${relative(file)}: public System getters require an explicit type`);
        current.get = member.type.getText(source);
      } else {
        const parameter = member.parameters[0];
        if (!parameter?.type) throw new Error(`${relative(file)}: public System setters require an explicit type`);
        current.set = parameter.type.getText(source);
      }
      accessors.set(name, current);
    }
  }
  for (const [name, accessor] of accessors) {
    if (accessor.get && accessor.set && accessor.get !== accessor.set) {
      throw new Error(`${relative(file)}: System accessor type mismatch: ${name}`);
    }
    result.push(`${accessor.set ? "" : "readonly "}${name}: ${accessor.set ?? accessor.get};`);
  }
  return result;
}

function parameterSignature(file, source, parameter) {
  if (!parameter.type) throw new Error(`${relative(file)}: public System parameters require explicit types`);
  const optional = parameter.questionToken || parameter.initializer ? "?" : "";
  const rest = parameter.dotDotDotToken ? "..." : "";
  return `${rest}${parameter.name.getText(source)}${optional}: ${parameter.type.getText(source)}`;
}

function modelTypeImports(source, publicSignatures) {
  const names = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== "#tiangz/model") continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (!new RegExp(`\\b${escapeRegExp(element.name.text)}\\b`).test(publicSignatures)) continue;
      names.push(element.propertyName ? `${element.propertyName.text} as ${element.name.text}` : element.name.text);
    }
  }
  return [...new Set(names)].sort((left, right) => left.localeCompare(right));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasModifier(node, kind) {
  return node.modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, "/");
}
