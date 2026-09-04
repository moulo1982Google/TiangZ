import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const scriptFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptFile), "..");
const options = parseArguments(process.argv.slice(2));
const configPath = path.resolve(root, options.project ?? "tsconfig.json");
const configRoot = path.dirname(configPath);
const scanRoot = path.resolve(root, options.scanRoot ?? "app");
const synchronousHooks = new Set([
  "Awake",
  "OnDestroy",
  "Deserialize",
  "CaptureTransfer",
  "RestoreTransfer",
]);
const timerFactories = new Set(["NewOnceTimer", "NewRepeatedTimer"]);

const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(formatDiagnostic(config.error));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, configRoot, undefined, configPath);
if (parsed.errors.length > 0) {
  throw new Error(parsed.errors.map(formatDiagnostic).join("\n"));
}

const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
const timerCancelledContextType = findNamedType("TimerCancelledContext");
const failures = [];

for (const sourceFile of program.getSourceFiles()) {
  const relativeToScanRoot = path.relative(scanRoot, sourceFile.fileName);
  if (
    sourceFile.isDeclarationFile ||
    path.isAbsolute(relativeToScanRoot) ||
    relativeToScanRoot === ".." ||
    relativeToScanRoot.startsWith(`..${path.sep}`)
  ) continue;
  visit(sourceFile, sourceFile);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  console.error(`runtime contract verification failed with ${failures.length} violation(s)`);
  process.exitCode = 1;
} else {
  console.log("runtime contract verification passed");
}

function visit(node, sourceFile) {
  if (ts.isMethodDeclaration(node)) verifySynchronousHook(node, sourceFile);
  if (ts.isCallExpression(node)) verifyTimerCall(node, sourceFile);
  ts.forEachChild(node, (child) => visit(child, sourceFile));
}

function verifySynchronousHook(method, sourceFile) {
  const name = propertyName(method.name);
  if (!name || !synchronousHooks.has(name) || !method.body) return;
  if (method.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
    report(sourceFile, method.name, `${name} must be synchronous; remove the async modifier`);
    return;
  }
  const signature = checker.getSignatureFromDeclaration(method);
  if (!signature) return;
  const returnType = checker.getReturnTypeOfSignature(signature);
  if (isThenableType(returnType, method)) {
    report(sourceFile, method.name, `${name} must be synchronous; its return type is ${checker.typeToString(returnType)}`);
  }
}

function verifyTimerCall(call, sourceFile) {
  if (!ts.isPropertyAccessExpression(call.expression)) return;
  const factoryName = call.expression.name.text;
  if (!timerFactories.has(factoryName) || call.arguments.length < 2) return;
  const resolved = checker.getResolvedSignature(call);
  if (!resolved || resolved.parameters.length < 2) return;
  const methodParameterType = checker.getTypeOfSymbolAtLocation(resolved.parameters[1], call);
  if (!isStringType(methodParameterType)) return;

  const methodNameNode = call.arguments[1];
  const methodName = stringLiteral(methodNameNode);
  if (!methodName) {
    report(sourceFile, methodNameNode, `${factoryName} method name must be a string literal`);
    return;
  }
  const owner = enclosingClass(call);
  if (!owner) {
    report(sourceFile, call, `${factoryName} with a method name must be called inside a class`);
    return;
  }
  verifyReferencedMethod(owner, methodName, call.arguments[2], 1, sourceFile, methodNameNode, factoryName);

  const options = call.arguments[3];
  if (!options || options.kind === ts.SyntaxKind.UndefinedKeyword) return;
  if (!ts.isObjectLiteralExpression(options)) {
    report(sourceFile, options, `${factoryName} options must be an object literal when onCancelled is used`);
    return;
  }
  const cancellation = options.properties.find((property) =>
    ts.isPropertyAssignment(property) && propertyName(property.name) === "onCancelled"
  );
  if (!cancellation || !ts.isPropertyAssignment(cancellation)) return;
  const cancellationName = stringLiteral(cancellation.initializer);
  if (!cancellationName) {
    report(sourceFile, cancellation.initializer, `${factoryName} onCancelled must be a string literal`);
    return;
  }
  verifyReferencedMethod(
    owner,
    cancellationName,
    call.arguments[2],
    2,
    sourceFile,
    cancellation.initializer,
    `${factoryName} onCancelled`,
    timerCancelledContextType,
  );
}

function verifyReferencedMethod(
  owner,
  methodName,
  argsNode,
  maximumParameters,
  sourceFile,
  location,
  label,
  requiredSecondArgumentType,
) {
  const ownerType = checker.getTypeAtLocation(owner.name ?? owner);
  const symbol = checker.getPropertyOfType(ownerType, methodName);
  if (!symbol) {
    report(sourceFile, location, `${label} target does not exist on ${owner.name?.text ?? "the containing class"}: ${methodName}`);
    return;
  }
  const methodType = checker.getTypeOfSymbolAtLocation(symbol, owner);
  const signatures = checker.getSignaturesOfType(methodType, ts.SignatureKind.Call);
  if (signatures.length === 0) {
    report(sourceFile, location, `${label} target is not callable: ${methodName}`);
    return;
  }
  const compatible = signatures.some((signature) => {
    if (signature.minArgumentCount > maximumParameters) return false;
    const parameters = signature.getParameters();
    if (parameters.length > maximumParameters && !hasRestParameter(signature)) return false;
    if (requiredSecondArgumentType) {
      if (parameters.length < 2) return false;
      const secondParameterType = checker.getTypeOfSymbolAtLocation(parameters[1], owner);
      if (!checker.isTypeAssignableTo(requiredSecondArgumentType, secondParameterType)) return false;
    }
    if (parameters.length === 0) return true;
    if (!argsNode && signature.minArgumentCount === 0) return true;
    const argsType = argsNode ? checker.getTypeAtLocation(argsNode) : checker.getUndefinedType();
    const firstParameterType = checker.getTypeOfSymbolAtLocation(parameters[0], owner);
    return checker.isTypeAssignableTo(argsType, firstParameterType);
  });
  if (!compatible) {
    const supplied = argsNode ? checker.typeToString(checker.getTypeAtLocation(argsNode)) : "no args";
    report(sourceFile, location, `${label} arguments (${supplied}) do not match ${methodName}`);
  }
}

function findNamedType(name) {
  for (const sourceFile of program.getSourceFiles()) {
    for (const statement of sourceFile.statements) {
      if (
        (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
        statement.name.text === name
      ) {
        return checker.getTypeAtLocation(statement.name);
      }
    }
  }
  throw new Error(`required runtime contract type is missing: ${name}`);
}

function hasRestParameter(signature) {
  const declaration = signature.getDeclaration();
  return Boolean(declaration?.parameters.at(-1)?.dotDotDotToken);
}

function isThenableType(type, location) {
  if (type.isUnionOrIntersection()) {
    return type.types.some((part) => isThenableType(part, location));
  }
  return Boolean(checker.getPropertyOfType(type, "then")) ||
    checker.typeToString(type, location).startsWith("Promise<");
}

function isStringType(type) {
  if ((type.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)) !== 0) return true;
  return type.isUnion() && type.types.every(isStringType);
}

function enclosingClass(node) {
  let current = node.parent;
  while (current && !ts.isClassDeclaration(current) && !ts.isClassExpression(current)) {
    current = current.parent;
  }
  return current;
}

function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function stringLiteral(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

function report(sourceFile, node, message) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const relative = path.relative(root, sourceFile.fileName).replaceAll("\\", "/");
  failures.push(`${relative}:${position.line + 1}:${position.character + 1}: ${message}`);
}

function formatDiagnostic(diagnostic) {
  return ts.formatDiagnostic(diagnostic, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  });
}

function parseArguments(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--project" || argument === "--scan-root") {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a path`);
      result[argument === "--project" ? "project" : "scanRoot"] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown runtime contract verifier argument: ${argument}`);
  }
  return result;
}
