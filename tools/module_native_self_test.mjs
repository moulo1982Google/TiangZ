import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { loadGameModuleCatalog } from "./game_module_catalog.mjs";
import { moduleNativeFingerprint } from "./module_native.mjs";

const root = path.resolve(import.meta.dirname, "..");
const hostMetadataResult=spawnSync('cargo',['metadata','--format-version','1','--no-deps','--offline','--locked'],{cwd:root,encoding:'utf8',windowsHide:true});
assert.equal(hostMetadataResult.status,0,hostMetadataResult.stderr);
const hostPackage=JSON.parse(hostMetadataResult.stdout).packages.find(item=>path.resolve(item.manifest_path)===path.join(root,'Cargo.toml'));
function hostRequirement(name){
  const dependency=hostPackage?.dependencies.find(item=>item.name===name&&item.kind===null);
  assert(dependency,`host dependency not found: ${name}`);
  return JSON.stringify(dependency.req);
}
const fixture = path.join(root, "temp", "module-native-fixture");
const modules = path.join(fixture, "modules");
for (const name of ["left", "right"]) {
  const directory = path.join(modules, name);
  for (const folder of ["src/model", "src/hotfix", "native", "rust/src"]) await mkdir(path.join(directory, folder), { recursive: true });
  await writeFile(path.join(directory, "tiangz.module.json"), JSON.stringify({
    formatVersion: 1, id: `org.example.${name}`, version: "1.0.0",
    engine: { minVersion: "0.4.0", maxVersionExclusive: "0.5.0" }, dependencies: [],
    entries: { model: "src/model/index.ts", hotfix: "src/hotfix/index.ts" },
    native: { source: "native", crate: "rust", crateName: `module_native_${name}`,
      generatedRust: "rust/src/generated", generatedTypeScript: "src/model/generated/native" },
  }));
  await writeFile(path.join(directory, "src/model/index.ts"),
    `import { defineGameModule } from "#tiangz/core";\ndefineGameModule({id: "org.example.${name}", version: "1.0.0"});\n`);
  await writeFile(path.join(directory, "src/hotfix/index.ts"), "export {};\n");
  await writeFile(path.join(directory, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ES2022", moduleResolution: "Bundler", strict: true,
      skipLibCheck: true, experimentalDecorators: true }, include: ["src/**/*.ts"],
  }));
  await writeFile(path.join(directory, "native/Counter.native"), `namespace fixture;
abstract entity Entity { readonly id: u32; @transient readonly instanceId: u32; }
@typeId(100)
entity Counter extends Entity { value: u32 = 1; }
@typeId(101)
entity OtherCounter extends Entity { value: u32 = 2; }
op EntityCreate(entityType: u32, values: f64[]): u32;
op EntityDestroy(handle: u32): void;
op EntityGetNumber(handle: u32, field: u32): f64;
op EntitySetNumber(handle: u32, field: u32, value: f64): void;
op Add(left: u32, right: u32): u32;
`);
  await writeFile(path.join(directory, "rust/Cargo.toml"), `[package]
name = "module_native_${name}"
version = "1.0.0"
edition = "2024"
[dependencies]
deno_core = ${hostRequirement('deno_core')}
deno_error = ${hostRequirement('deno_error')}
`);
  await writeFile(path.join(directory, "rust/src/lib.rs"), `pub mod generated;
pub mod native_data;
pub use generated::{extension, BOOTSTRAP};
`);
  await writeFile(path.join(directory, "rust/src/native_data.rs"), `use deno_core::{op2, OpState};
use deno_error::JsErrorBox;
use crate::generated::native_data::{NativeEntityData, create_entity, get_entity_number, set_entity_number};
#[derive(Default)]
struct Store(Vec<Option<NativeEntityData>>);
fn store(state: &mut OpState) -> &mut Store {
    if !state.has::<Store>() { state.put(Store::default()); }
    state.borrow_mut::<Store>()
}
#[op2(fast)]
pub fn op_native_entity_create(state: &mut OpState, entity_type: u32, #[buffer] values: &[f64]) -> Result<u32, JsErrorBox> {
    let entity = create_entity(entity_type, values).map_err(JsErrorBox::generic)?;
    let store = store(state);
    let handle = u32::try_from(store.0.len() + 1).map_err(|_| JsErrorBox::generic("handles exhausted"))?;
    store.0.push(Some(entity));
    Ok(handle)
}
#[op2(fast)]
pub fn op_native_entity_destroy(state: &mut OpState, handle: u32) -> Result<(), JsErrorBox> {
    let slot = store(state).0.get_mut(handle.wrapping_sub(1) as usize).ok_or_else(|| JsErrorBox::generic("stale handle"))?;
    slot.take().ok_or_else(|| JsErrorBox::generic("stale handle"))?;
    Ok(())
}
#[op2(fast)]
pub fn op_native_entity_get_number(state: &mut OpState, handle: u32, field: u32) -> Result<f64, JsErrorBox> {
    let entity = store(state).0.get(handle.wrapping_sub(1) as usize).and_then(Option::as_ref).ok_or_else(|| JsErrorBox::generic("stale handle"))?;
    get_entity_number(entity, field).ok_or_else(|| JsErrorBox::generic("unknown field"))
}
#[op2(fast)]
pub fn op_native_entity_set_number(state: &mut OpState, handle: u32, field: u32, value: f64) -> Result<(), JsErrorBox> {
    let entity = store(state).0.get_mut(handle.wrapping_sub(1) as usize).and_then(Option::as_mut).ok_or_else(|| JsErrorBox::generic("stale handle"))?;
    set_entity_number(entity, field, value).map_err(JsErrorBox::generic)
}
#[op2(fast)]
pub fn op_native_add(left: u32, right: u32) -> u32 { left + right ${name === "right" ? "+ 100" : ""} }
`);
}
run(process.execPath, ["tools/codegen_module_native.mjs", "--modules-dir", modules]);
run(process.execPath, ["tools/codegen_module_native.mjs", "--modules-dir", modules, "--check"]);
run(process.execPath, ["tools/typecheck_game_modules.mjs", "--modules-dir", modules]);
const catalog = await loadGameModuleCatalog({ projectRoot: root, modulesDirectory: modules });
const original = await moduleNativeFingerprint(catalog);
const leftFile = path.join(modules, "left/rust/src/native_data.rs");
const left = await readFile(leftFile, "utf8");
await writeFile(leftFile, left + "\n// changed native source\n");
assert.notEqual(await moduleNativeFingerprint(catalog), original);
await writeFile(leftFile, left);
const context = { Deno: { core: { ops: {} } }, Uint8Array, Float64Array };
for (const name of ["left", "right"]) {
  context.Deno.core.ops[`org.example.${name}::op_native_add`] = (left, right) => left + right + (name === "right" ? 100 : 0);
  const bootstrap = await readFile(path.join(modules, name, "rust/src/generated/native_ops_bootstrap.js"), "utf8");
  runInNewContext(bootstrap, context);
  const bundle = await build({ entryPoints: [path.join(modules, name, "src/model/generated/native/NativeOps.ts")],
    bundle: true, format: "iife", globalName: "ModuleApi", write: false, logLevel: "silent" });
  runInNewContext(bundle.outputFiles[0].text, context);
  assert.equal(context.ModuleApi.NativeOps.Add(2, 3), name === "right" ? 105 : 5);
}
const bundles = path.join(fixture, "dist");
run(process.execPath, ["tools/build_runtime_bundles.mjs", "--modules-dir", modules, "--out-dir", bundles]);
const model = await readFile(path.join(bundles, "model.js"), "utf8");
const hostContext = { TextEncoder, TextDecoder, console, setTimeout, clearTimeout };
assert.throws(() => runInNewContext(model, { ...hostContext }), /Native binary does not match Model/);
runInNewContext(model, { ...hostContext, __tiangzModuleNativeFingerprint: original });
await writeFile(leftFile, left + "\n// incompatible source change\n");
const rejected = spawnSync(process.execPath, ["tools/build_runtime_bundles.mjs", "--modules-dir", modules, "--out-dir", bundles, "--hotfix-only"],
  { cwd: root, encoding: "utf8", windowsHide: true });
await writeFile(leftFile, left);
assert.notEqual(rejected.status, 0);
assert.match(rejected.stdout + rejected.stderr, /Model source changed/);
if (process.argv.includes("--rust")) {
  const incompatible=path.join(fixture,'incompatible-deno-core');
  await mkdir(path.join(incompatible,'src'),{recursive:true});
  await writeFile(path.join(incompatible,'Cargo.toml'),'[package]\nname="deno_core"\nversion="0.0.0"\nedition="2024"\n');
  await writeFile(path.join(incompatible,'src/lib.rs'),'pub struct Extension;\n');
  const leftCargo=path.join(modules,'left/rust/Cargo.toml');
  const validCargo=await readFile(leftCargo,'utf8');
  try {
    await writeFile(leftCargo,validCargo.replace(/^deno_core = .*$/m,`deno_core = { path = ${JSON.stringify(incompatible.replaceAll(path.sep,'/'))} }`));
    const mismatch=spawnSync(process.execPath,['tools/build_module_native.mjs','--modules-dir',modules,'--check','--offline'],{cwd:root,encoding:'utf8',windowsHide:true});
    assert.notEqual(mismatch.status,0);
    assert.match(mismatch.stdout+mismatch.stderr,/Native dependency mismatch: org.example.left/);
  } finally { await writeFile(leftCargo,validCargo); }
  run(process.execPath, ["tools/build_module_native.mjs", "--modules-dir", modules, "--offline"]);
  const output = path.join(root, "temp/module-native-build", catalog.graphHash);
  const assertions = [];
  for (const name of ["left", "right"]) {
    const result = await build({ stdin: { contents:
      `export { NativeOps } from "./NativeOps"; export { NativeCounterRef } from "./NativeCounterRef";`,
      resolveDir: path.join(modules, name, "src/model/generated/native"), loader: "ts" },
      bundle: true, format: "iife", globalName: name, write: false });
    assertions.push(result.outputFiles[0].text);
  }
  assertions.push(`
    function check(value) { if (!value) throw new Error("module Native runtime assertion failed"); }
    check(left.NativeOps.Add(2, 3) === 5 && right.NativeOps.Add(2, 3) === 105);
    const a = left.NativeCounterRef.Create({id: 1, instanceId: 2, value: 11});
    const b = right.NativeCounterRef.Create({id: 1, instanceId: 2, value: 22});
    check(a.Handle === b.Handle && a.value === 11 && b.value === 22);
    a.value = 33; check(a.value === 33 && b.value === 22);
    const stale = a.Handle; a.Dispose(); a.Dispose();
    let rejected = false; try { left.NativeOps.EntityGetNumber(stale, 3); } catch { rejected = true; }
    check(rejected && b.value === 22); b.Dispose();
    check(Object.keys(left.NativeOps.NativeRefMetrics()).length === 0);
    check(Object.keys(right.NativeOps.NativeRefMetrics()).length === 0);
  `);
  await writeFile(path.join(output, "acceptance.js"), assertions.join("\n"));
  await writeFile(path.join(output, "acceptance.rs"), `
    fn main() {
      let mut runtime = deno_core::JsRuntime::new(deno_core::RuntimeOptions {
        extensions: vec![tiangz_module_0::extension(), tiangz_module_1::extension()],
        ..Default::default()
      });
      runtime.execute_script("left-bootstrap", tiangz_module_0::BOOTSTRAP).unwrap();
      runtime.execute_script("right-bootstrap", tiangz_module_1::BOOTSTRAP).unwrap();
      runtime.execute_script("acceptance", include_str!("acceptance.js")).unwrap();
      println!("two module Native V8 runtime acceptance passed");
    }
  `);
  const manifest = path.join(output, "Cargo.toml");
  await writeFile(manifest, await readFile(manifest, "utf8") + '\n[[bin]]\nname = "module-native-acceptance"\npath = "acceptance.rs"\n');
  run("cargo", ["run", "--offline", "--manifest-path", manifest, "--bin", "module-native-acceptance"],
    { ...process.env, TIANGZ_ENGINE_ROOT: root, TIANGZ_MODULE_NATIVE_BRIDGE: path.join(output, "bridge.rs") });
}
process.stdout.write("module Native self-test passed\n");

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed`);
}
