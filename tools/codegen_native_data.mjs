import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaRoot = path.join(root, "native_data");
const rustOutput = path.join(root, "src", "generated", "native_data.rs");
const rustOpsOutput = path.join(root, "src", "generated", "native_ops.rs");
const bootstrapOutput = path.join(root, "src", "generated", "native_ops_bootstrap.js");
const tsOutputRoot = path.join(root, "app", "generated", "model", "native");
const tsOpsOutput = path.join(tsOutputRoot, "NativeOps.ts");

const schemaFiles = await collectSchemaFiles(schemaRoot);
const fragments = await Promise.all(schemaFiles.map(async (file) =>
  parseSchema(await readFile(file, "utf8"), file)
));
const schema = mergeSchemas(fragments);
validateSchema(schema);

await mkdir(path.dirname(rustOutput), { recursive: true });
await mkdir(tsOutputRoot, { recursive: true });
await writeFile(rustOutput, renderRust(schema), "utf8");
await writeFile(rustOpsOutput, renderRustOps(schema), "utf8");
await writeFile(bootstrapOutput, renderNativeOpsBootstrap(schema), "utf8");
await writeFile(tsOpsOutput, renderTypeScriptOps(schema), "utf8");
formatRust(rustOutput);
formatRust(rustOpsOutput);
const concreteEntities = schema.entities.filter((entity) => !entity.abstract);
for (const entity of concreteEntities) {
  const output = path.join(tsOutputRoot, `Native${entity.name}Ref.ts`);
  await writeFile(output, renderTypeScript(schema, entity), "utf8");
}
console.log(
  `[codegen:native-data] generated native data, ${schema.operations.length} op binding(s), and ${concreteEntities.length} TS handle(s)`,
);

function formatRust(file) {
  const result = spawnSync("rustfmt", ["--edition", "2024", file], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(`failed to start rustfmt: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`rustfmt failed:\n${result.stderr || result.stdout}`);
  }
}

async function collectSchemaFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectSchemaFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".native")) files.push(fullPath);
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

function parseSchema(source, file) {
  const clean = source.replace(/\/\/.*$/gm, "");
  const namespace = /\bnamespace\s+([A-Za-z_]\w*)\s*;/.exec(clean)?.[1];
  if (!namespace) throw new Error(`${file}: namespace is required`);

  const entities = [];
  const operations = [];
  const entityPattern = /((?:@[A-Za-z_]\w*(?:\([^)]*\))?\s*)*)(?:(abstract)\s+)?entity\s+([A-Za-z_]\w*)(?:\s+extends\s+([A-Za-z_]\w*))?\s*\{([^}]*)\}/g;
  for (const match of clean.matchAll(entityPattern)) {
    const annotations = match[1];
    const typeIdText = /@typeId\((\d+)\)/.exec(annotations)?.[1];
    const fields = [];
    const fieldPattern = /(?:(readonly)\s+)?([A-Za-z_]\w*)\s*:\s*(u32|i32|i8|f32)(?:\s*=\s*(-?(?:\d+(?:\.\d*)?|\.\d+)))?\s*;/g;
    for (const field of match[5].matchAll(fieldPattern)) {
      fields.push({
        readonly: field[1] === "readonly",
        name: field[2],
        type: field[3],
        defaultValue: field[4],
      });
    }
    entities.push({
      namespace,
      sourceFile: file,
      typeId: typeIdText === undefined ? undefined : Number(typeIdText),
      component: /@component\b/.test(annotations),
      abstract: match[2] === "abstract",
      name: match[3],
      parent: match[4],
      fields,
    });
  }
  const operationPattern = /\bop\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*:\s*(u32|i32|i8|f64|bool|bytes|void)\s*;/g;
  for (const match of clean.matchAll(operationPattern)) {
    const params = match[2].trim() === ""
      ? []
      : match[2].split(",").map((item) => {
          const parameter = /^\s*([A-Za-z_]\w*)\s*:\s*(u32|i32|i8|f64|bool|bytes|f64\[\])\s*$/.exec(item);
          if (!parameter) throw new Error(`${file}: invalid native op parameter ${item.trim()}`);
          return { name: parameter[1], type: parameter[2] };
        });
    operations.push({
      namespace,
      sourceFile: file,
      name: match[1],
      params,
      returnType: match[3],
    });
  }
  if (entities.length === 0 && operations.length === 0) {
    throw new Error(`${file}: no entity or op declarations`);
  }
  return { namespace, entities, operations };
}

function mergeSchemas(fragments) {
  return {
    entities: fragments.flatMap((fragment) => fragment.entities),
    operations: fragments.flatMap((fragment) => fragment.operations),
  };
}

function validateSchema(schema) {
  const byName = entityMap(schema);
  const typeIds = new Map();
  for (const entity of schema.entities) {
    if (byName.get(entity.name) !== entity) {
      throw new Error(`${entity.sourceFile}: duplicate entity ${entity.name}`);
    }
    if (entity.parent && !byName.has(entity.parent)) {
      throw new Error(`${entity.sourceFile}: unknown parent ${entity.parent}`);
    }
    if (entity.abstract && entity.typeId !== undefined) {
      throw new Error(`${entity.sourceFile}: abstract entity ${entity.name} cannot have @typeId`);
    }
    if (entity.abstract && entity.component) {
      throw new Error(`${entity.sourceFile}: abstract entity ${entity.name} cannot be @component`);
    }
    if (!entity.abstract) {
      if (!Number.isSafeInteger(entity.typeId) || entity.typeId <= 0 || entity.typeId > 0xffff) {
        throw new Error(`${entity.sourceFile}: concrete entity ${entity.name} needs @typeId(1..65535)`);
      }
      const previous = typeIds.get(entity.typeId);
      if (previous) throw new Error(`${entity.sourceFile}: @typeId(${entity.typeId}) is already used by ${previous}`);
      typeIds.set(entity.typeId, entity.name);
      if (!inheritsFrom(schema, entity, "Entity")) {
        throw new Error(`${entity.sourceFile}: concrete entity ${entity.name} must extend Entity`);
      }
    }
    const localNames = new Set();
    for (const field of entity.fields) {
      if (localNames.has(field.name)) throw new Error(`${entity.sourceFile}: duplicate field ${field.name}`);
      localNames.add(field.name);
      if (field.defaultValue !== undefined) validateDefault(field, entity.sourceFile);
    }
  }
  for (const entity of schema.entities) {
    const fields = flattenFields(schema, entity.name);
    const names = new Set();
    for (const field of fields) {
      if (names.has(field.name)) throw new Error(`${entity.sourceFile}: inherited field ${field.name} is duplicated`);
      names.add(field.name);
    }
  }

  const entity = byName.get("Entity");
  if (!entity?.abstract) throw new Error("native schema needs abstract entity Entity");
  for (const name of ["id", "instanceId"]) {
    const field = entity.fields.find((candidate) => candidate.name === name);
    if (field?.type !== "u32" || !field.readonly) {
      throw new Error(`Entity.${name} must be readonly u32`);
    }
  }

  const operationNames = new Set();
  for (const operation of schema.operations) {
    if (operationNames.has(operation.name)) {
      throw new Error(`${operation.sourceFile}: duplicate native op ${operation.name}`);
    }
    operationNames.add(operation.name);
    const parameterNames = new Set();
    for (const parameter of operation.params) {
      if (parameterNames.has(parameter.name)) {
        throw new Error(
          `${operation.sourceFile}: duplicate parameter ${parameter.name} in native op ${operation.name}`,
        );
      }
      parameterNames.add(parameter.name);
    }
  }
  if (schema.operations.length === 0) {
    throw new Error("native schema needs at least one op declaration");
  }
}

function validateDefault(field, sourceFile) {
  const value = Number(field.defaultValue);
  if (!Number.isFinite(value)) throw new Error(`${sourceFile}: invalid default for ${field.name}`);
  if (field.type !== "f32" && !Number.isInteger(value)) {
    throw new Error(`${sourceFile}: ${field.name} default must be an integer`);
  }
  const ranges = {
    u32: [0, 0xffff_ffff],
    i32: [-0x8000_0000, 0x7fff_ffff],
    i8: [-128, 127],
  };
  const range = ranges[field.type];
  if (range && (value < range[0] || value > range[1])) {
    throw new Error(`${sourceFile}: ${field.name} default is outside ${field.type}`);
  }
}

function renderRust(schema) {
  const entities = schema.entities.map((entity) => renderRustStruct(entity)).join("\n\n");
  const concrete = schema.entities.filter((entity) => !entity.abstract)
    .sort((left, right) => left.typeId - right.typeId);
  const typeConstants = concrete
    .map((entity) => `pub const ENTITY_TYPE_${toScreamingSnakeCase(entity.name)}: u32 = ${entity.typeId};`)
    .join("\n");
  const fieldSections = concrete.map((entity) => renderRustFields(schema, entity)).join("\n\n");
  const variants = concrete.map((entity) => `    ${entity.name}(${entity.name}Data),`).join("\n");
  const typeMatches = concrete
    .map((entity) => `            Self::${entity.name}(_) => ENTITY_TYPE_${toScreamingSnakeCase(entity.name)},`)
    .join("\n");
  const accessors = concrete.map((entity) => renderRustVariantAccessors(entity)).join("\n");
  const createMatches = concrete.map((entity) => renderRustCreateMatch(schema, entity)).join("\n");
  const getterMatches = concrete
    .map((entity) => `        NativeEntityData::${entity.name}(value) => get_${toSnakeCase(entity.name)}_number(value, field),`)
    .join("\n");
  const setterMatches = concrete
    .map((entity) => `        NativeEntityData::${entity.name}(value) => set_${toSnakeCase(entity.name)}_number(value, field, number),`)
    .join("\n");
  return `// Generated by tools/codegen_native_data.mjs. Do not edit.\n#![allow(dead_code)]\n\n\
${entities}\n\n\
${typeConstants}\n\n\
${fieldSections}\n\n\
#[derive(Debug, Clone)]\n\
pub enum NativeEntityData {\n${variants}\n}\n\n\
impl NativeEntityData {\n\
    pub fn type_id(&self) -> u32 {\n\
        match self {\n${typeMatches}\n        }\n\
    }\n\n\
${accessors}\
}\n\n\
pub fn create_entity(type_id: u32, values: &[f64]) -> Result<NativeEntityData, &'static str> {\n\
    match type_id {\n${createMatches}\n        _ => Err("unknown native entity type"),\n\
    }\n\
}\n\n\
pub fn get_entity_number(value: &NativeEntityData, field: u32) -> Option<f64> {\n\
    match value {\n${getterMatches}\n    }\n\
}\n\n\
pub fn set_entity_number(value: &mut NativeEntityData, field: u32, number: f64) -> Result<(), &'static str> {\n\
    match value {\n${setterMatches}\n    }\n\
}\n\n\
fn read_number(values: &[f64], index: usize) -> Result<f64, &'static str> {\n\
    values.get(index).copied().ok_or("native entity create values are truncated")\n\
}\n\n\
fn read_f32(values: &[f64], index: usize) -> Result<f32, &'static str> {\n\
    let number = read_number(values, index)?;\n\
    if !number.is_finite() || number < f32::MIN as f64 || number > f32::MAX as f64 {\n\
        return Err("native entity create value must be a finite f32");\n\
    }\n\
    Ok(number as f32)\n\
}\n\n\
fn read_u32(values: &[f64], index: usize) -> Result<u32, &'static str> {\n\
    let number = read_number(values, index)?;\n\
    if !number.is_finite() || number.fract() != 0.0 || number < 0.0 || number > u32::MAX as f64 {\n\
        return Err("native entity create value must be u32");\n\
    }\n\
    Ok(number as u32)\n\
}\n\n\
fn read_i32(values: &[f64], index: usize) -> Result<i32, &'static str> {\n\
    let number = read_number(values, index)?;\n\
    if !number.is_finite() || number.fract() != 0.0 || number < i32::MIN as f64 || number > i32::MAX as f64 {\n\
        return Err("native entity create value must be i32");\n\
    }\n\
    Ok(number as i32)\n\
}\n\n\
fn read_i8(values: &[f64], index: usize) -> Result<i8, &'static str> {\n\
    let number = read_number(values, index)?;\n\
    if !number.is_finite() || number.fract() != 0.0 || number < i8::MIN as f64 || number > i8::MAX as f64 {\n\
        return Err("native entity create value must be i8");\n\
    }\n\
    Ok(number as i8)\n\
}\n`;
}

function renderRustOps(schema) {
  const rustNames = schema.operations.map((operation) => nativeRustOpName(operation));
  return `// Generated by tools/codegen_native_data.mjs. Do not edit.\n\
use crate::native_data::{${rustNames.join(", ")}};\n\n\
deno_core::extension!(\n\
    native_data_host,\n\
    ops = [\n${rustNames.map((name) => `        ${name},`).join("\n")}\n    ],\n\
);\n\n\
pub(crate) fn init() -> deno_core::Extension {\n\
    native_data_host::init()\n\
}\n\n\
pub(crate) const BOOTSTRAP_SOURCE: &str = include_str!("native_ops_bootstrap.js");\n`;
}

function renderNativeOpsBootstrap(schema) {
  const methods = schema.operations.map((operation) => {
    const params = operation.params.map((parameter) => parameter.name).join(", ");
    const args = operation.params
      .map((parameter) => renderBootstrapArgument(parameter))
      .join(", ");
    return `    ${toCamelCase(operation.name)}: (${params}) => core.ops.${nativeRustOpName(operation)}(${args}),`;
  }).join("\n");
  return `// Generated by tools/codegen_native_data.mjs. Do not edit.\n\
(() => {\n\
  const core = globalThis.Deno.core;\n\
  const integer = (value, min, max, name) => {\n\
    if (!Number.isInteger(value) || value < min || value > max) {\n\
      throw new RangeError(\`native op \${name} must be an integer in [\${min}, \${max}]\`);\n\
    }\n\
    return value;\n\
  };\n\
  const u32 = (value, name) => integer(value, 0, 0xffff_ffff, name);\n\
  const i32 = (value, name) => integer(value, -0x8000_0000, 0x7fff_ffff, name);\n\
  const i8 = (value, name) => integer(value, -128, 127, name);\n\
  const f64 = (value, name) => {\n\
    if (typeof value !== "number" || !Number.isFinite(value)) {\n\
      throw new TypeError(\`native op \${name} must be a finite number\`);\n\
    }\n\
    return value;\n\
  };\n\
  const f64Array = (value, name) => {\n\
    if (!(value instanceof Float64Array)) {\n\
      throw new TypeError(\`native op \${name} must be Float64Array\`);\n\
    }\n\
    return value;\n\
  };\n\
  const bytes = (value, name) => {\n\
    if (!(value instanceof Uint8Array)) {\n\
      throw new TypeError(\`native op \${name} must be Uint8Array\`);\n\
    }\n\
    return value;\n\
  };\n\
  const bool = (value, name) => {\n\
    if (typeof value !== "boolean") {\n\
      throw new TypeError(\`native op \${name} must be boolean\`);\n\
    }\n\
    return value;\n\
  };\n\
  globalThis.__etsNativeOps = Object.freeze({\n${methods}\n  });\n\
})();\n`;
}

function renderTypeScriptOps(schema) {
  const interfaceMethods = schema.operations.map((operation) => {
    const params = operation.params
      .map((parameter) => `${parameter.name}: ${nativeTypeScriptType(parameter.type)}`)
      .join(", ");
    return `  ${toCamelCase(operation.name)}(${params}): ${nativeTypeScriptType(operation.returnType)};`;
  }).join("\n");
  const facadeMethods = schema.operations.map((operation) => {
    const params = operation.params
      .map((parameter) => `${parameter.name}: ${nativeTypeScriptType(parameter.type)}`)
      .join(", ");
    const args = operation.params.map((parameter) => parameter.name).join(", ");
    const call = `nativeHostOps().${toCamelCase(operation.name)}(${args})`;
    return operation.returnType === "void"
      ? `  static ${operation.name}(${params}): void {\n    ${call};\n  }`
      : `  static ${operation.name}(${params}): ${nativeTypeScriptType(operation.returnType)} {\n    return ${call};\n  }`;
  }).join("\n\n");
  return `// Generated by tools/codegen_native_data.mjs. Do not edit.\n\n\
export interface NativeHostOpsApi {\n${interfaceMethods}\n}\n\n\
function nativeHostOps(): NativeHostOpsApi {\n\
  const host = (globalThis as typeof globalThis & {\n\
    __etsNativeOps?: NativeHostOpsApi;\n\
  }).__etsNativeOps;\n\
  if (!host) throw new Error("native host ops are not installed");\n\
  return host;\n\
}\n\n\
export class NativeOps {\n${facadeMethods}\n}\n`;
}

function renderBootstrapArgument(parameter) {
  const conversions = {
    u32: "u32",
    i32: "i32",
    i8: "i8",
    f64: "f64",
    "f64[]": "f64Array",
    bytes: "bytes",
    bool: "bool",
  };
  return `${conversions[parameter.type]}(${parameter.name}, ${JSON.stringify(parameter.name)})`;
}

function nativeTypeScriptType(type) {
  const types = {
    u32: "number",
    i32: "number",
    i8: "number",
    f64: "number",
    "f64[]": "Float64Array",
    bool: "boolean",
    bytes: "Uint8Array",
    void: "void",
  };
  return types[type];
}

function nativeRustOpName(operation) {
  return `op_native_${toSnakeCase(operation.name)}`;
}

function renderRustStruct(entity) {
  const rustType = { u32: "u32", i32: "i32", i8: "i8", f32: "f32" };
  const parent = entity.parent ? `    pub ${toSnakeCase(entity.parent)}: ${entity.parent}Data,\n` : "";
  const fields = entity.fields
    .map((field) => `    pub ${toSnakeCase(field.name)}: ${rustType[field.type]},`)
    .join("\n");
  return `#[derive(Debug, Clone)]\npub struct ${entity.name}Data {\n${parent}${fields}\n}`;
}

function renderRustFields(schema, entity) {
  const fields = flattenFields(schema, entity.name);
  const snakeName = toSnakeCase(entity.name);
  const upperName = toScreamingSnakeCase(entity.name);
  const constants = fields
    .map((field, index) => `pub const ${upperName}_FIELD_${toScreamingSnakeCase(field.name)}: u32 = ${index + 1};`)
    .join("\n");
  const getters = fields
    .map((field, index) => `        ${index + 1} => Some(${rustFieldPath("value", field)} as f64),`)
    .join("\n");
  const setters = fields
    .map((field, index) => field.readonly
      ? `        ${index + 1} => Err("native ${entity.name} field ${field.name} is readonly"),`
      : `        ${index + 1} => { ${renderRustSetter(entity, field)} Ok(()) },`)
    .join("\n");
  return `${constants}\n\n\
pub fn get_${snakeName}_number(value: &${entity.name}Data, field: u32) -> Option<f64> {\n\
    match field {\n${getters}\n        _ => None,\n    }\n\
}\n\n\
pub fn set_${snakeName}_number(value: &mut ${entity.name}Data, field: u32, number: f64) -> Result<(), &'static str> {\n\
    match field {\n${setters}\n        _ => Err("unknown native ${entity.name} field"),\n    }\n\
}`;
}

function renderRustVariantAccessors(entity) {
  const snake = toSnakeCase(entity.name);
  return `    pub fn as_${snake}(&self) -> Option<&${entity.name}Data> {\n\
        match self { Self::${entity.name}(value) => Some(value), _ => None }\n\
    }\n\n\
    pub fn as_${snake}_mut(&mut self) -> Option<&mut ${entity.name}Data> {\n\
        match self { Self::${entity.name}(value) => Some(value), _ => None }\n\
    }\n`;
}

function renderRustCreateMatch(schema, entity) {
  const fields = flattenFields(schema, entity.name);
  const values = new Map(fields.map((field, index) => [field.name, `read_${field.type}(values, ${index})?`]));
  const init = renderRustStructInit(schema, entity.name, values, 12);
  return `        ENTITY_TYPE_${toScreamingSnakeCase(entity.name)} => {\n\
            if values.len() != ${fields.length} { return Err("native ${entity.name} create value count mismatch"); }\n\
            if read_u32(values, 0)? == 0 || read_u32(values, 1)? == 0 {\n\
                return Err("native Entity id and instanceId must be greater than zero");\n\
            }\n\
            Ok(NativeEntityData::${entity.name}(${init}))\n\
        },`;
}

function renderRustStructInit(schema, entityName, values, indent) {
  const entity = entityMap(schema).get(entityName);
  const padding = " ".repeat(indent);
  const childPadding = " ".repeat(indent + 4);
  const lines = [];
  if (entity.parent) {
    lines.push(`${childPadding}${toSnakeCase(entity.parent)}: ${renderRustStructInit(schema, entity.parent, values, indent + 4)},`);
  }
  for (const field of entity.fields) {
    lines.push(`${childPadding}${toSnakeCase(field.name)}: ${values.get(field.name)},`);
  }
  return `${entity.name}Data {\n${lines.join("\n")}\n${padding}}`;
}

function renderTypeScript(schema, entity) {
  const fields = flattenFields(schema, entity.name);
  const fieldConstants = entity.fields
    .map((field) => {
      const index = fields.findIndex((candidate) => candidate.name === field.name);
      return `  ${toPascalCase(field.name)}: ${index + 1},`;
    })
    .join("\n");
  const fieldTypes = `export const Native${entity.name}Field = {\n${fieldConstants}\n} as const;\n\nexport type Native${entity.name}Field = typeof Native${entity.name}Field[keyof typeof Native${entity.name}Field];`;
  const args = fields.map((field) => {
    const optional = field.defaultValue === undefined ? "" : "?";
    return `  ${field.name}${optional}: number;`;
  }).join("\n");
  const values = fields
    .map((field) => field.defaultValue === undefined
      ? `      args.${field.name},`
      : `      args.${field.name} ?? ${field.defaultValue},`)
    .join("\n");
  const properties = fields.map((field, index) => {
    const setter = field.readonly ? "" : `\n  set ${field.name}(value: number) {\n    NativeOps.EntitySetNumber(this.Handle, ${index + 1}, value);\n  }\n`;
    return `  get ${field.name}(): number {\n    return NativeOps.EntityGetNumber(this.Handle, ${index + 1});\n  }\n${setter}`;
  }).join("\n");
  if (!entity.component) {
    return renderTypeScriptHandle(entity, args, values, properties, fieldTypes);
  }
  return `// Generated by tools/codegen_native_data.mjs. Do not edit.\n\n\
import { NativeOps } from "./NativeOps";\n\
import { Component } from "../../../core/runtime/entities";\n\
import { component } from "../../../core/runtime/metadata";\n\
\n\
${fieldTypes}\n\n\
export interface Native${entity.name}CreateArgs {\n${args}\n}\n\n\
@component()\n\
export class Native${entity.name}Ref extends Component<[args: Native${entity.name}CreateArgs]> {\n\
  private nativeHandle = 0;\n\n\
  get Handle(): number {\n\
    if (this.nativeHandle === 0) throw new Error("native ${entity.name} handle is not alive");\n\
    return this.nativeHandle;\n\
  }\n\n\
  protected override Awake(args: Native${entity.name}CreateArgs): void {\n\
    this.nativeHandle = NativeOps.EntityCreate(${entity.typeId}, new Float64Array([\n${values}\n    ]));\n\
  }\n\n\
${properties}\
  protected override OnDestroy(): void {\n\
    if (this.nativeHandle === 0) return;\n\
    NativeOps.EntityDestroy(this.nativeHandle);\n\
    this.nativeHandle = 0;\n\
  }\n\
}\n`;
}

function renderTypeScriptHandle(entity, args, values, properties, fieldTypes) {
  return `// Generated by tools/codegen_native_data.mjs. Do not edit.\n\n\
import { NativeOps } from "./NativeOps";\n\n\
${fieldTypes}\n\n\
export class Native${entity.name}Ref {\n\
  private nativeHandle: number;\n\n\
  private constructor(handle: number) {\n\
    this.nativeHandle = handle;\n\
  }\n\n\
  static Create(args: Native${entity.name}CreateArgs): Native${entity.name}Ref {\n\
    return new Native${entity.name}Ref(NativeOps.EntityCreate(${entity.typeId}, new Float64Array([\n${values}\n    ])));\n\
  }\n\n\
  get Handle(): number {\n\
    if (this.nativeHandle === 0) throw new Error("native ${entity.name} handle is not alive");\n\
    return this.nativeHandle;\n\
  }\n\n\
${properties}\n\
  Dispose(): void {\n\
    if (this.nativeHandle === 0) return;\n\
    NativeOps.EntityDestroy(this.nativeHandle);\n\
    this.nativeHandle = 0;\n\
  }\n\
}\n\n\
export interface Native${entity.name}CreateArgs {\n${args}\n}\n`;
}

function flattenFields(schema, entityName, stack = []) {
  if (stack.includes(entityName)) throw new Error(`native entity inheritance cycle: ${[...stack, entityName].join(" -> ")}`);
  const entity = entityMap(schema).get(entityName);
  if (!entity) throw new Error(`unknown native entity ${entityName}`);
  const inherited = entity.parent
    ? flattenFields(schema, entity.parent, [...stack, entityName]).map((field) => ({
        ...field,
        path: [toSnakeCase(entity.parent), ...field.path],
      }))
    : [];
  return [...inherited, ...entity.fields.map((field) => ({ ...field, path: [toSnakeCase(field.name)] }))];
}

function entityMap(schema) {
  return new Map(schema.entities.map((entity) => [entity.name, entity]));
}

function inheritsFrom(schema, entity, expectedParent) {
  const byName = entityMap(schema);
  let current = entity;
  const visited = new Set();
  while (current.parent) {
    if (current.parent === expectedParent) return true;
    if (visited.has(current.parent)) return false;
    visited.add(current.parent);
    current = byName.get(current.parent);
    if (!current) return false;
  }
  return false;
}

function rustFieldPath(root, field) {
  return `${root}.${field.path.join(".")}`;
}

function renderRustSetter(entity, field) {
  const target = rustFieldPath("value", field);
  if (field.type === "f32") {
    return `if !number.is_finite() || number < f32::MIN as f64 || number > f32::MAX as f64 { return Err("native ${entity.name} field ${field.name} must be a finite f32"); } ${target} = number as f32;`;
  }
  const ranges = {
    u32: ["0.0", "u32::MAX as f64", "u32"],
    i32: ["i32::MIN as f64", "i32::MAX as f64", "i32"],
    i8: ["i8::MIN as f64", "i8::MAX as f64", "i8"],
  };
  const [min, max, type] = ranges[field.type];
  return `if !number.is_finite() || number.fract() != 0.0 || number < ${min} || number > ${max} { return Err("native ${entity.name} field ${field.name} must be ${field.type}"); } ${target} = number as ${type};`;
}

function toSnakeCase(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function toScreamingSnakeCase(value) {
  return toSnakeCase(value).toUpperCase();
}

function toPascalCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function toCamelCase(value) {
  return value.charAt(0).toLowerCase() + value.slice(1);
}
