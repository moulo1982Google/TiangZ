import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** 只创建手写输入；Native 桥始终交给正式生成器。 / Scaffold inputs only; the official generator owns the bridge. */
export async function scaffoldModuleNative(engine, directory, id, version) {
  const metadata = spawnSync("cargo", ["metadata", "--format-version", "1", "--no-deps", "--offline", "--locked"],
    { cwd: engine, encoding: "utf8", windowsHide: true });
  if (metadata.error || metadata.status !== 0) throw new Error(`无法读取宿主 Rust 依赖，请先安装 Cargo：${metadata.error?.message ?? metadata.stderr}`);
  const host = JSON.parse(metadata.stdout).packages.find(item => path.resolve(item.manifest_path) === path.join(engine, "Cargo.toml"));
  const deno = host?.dependencies.find(item => item.name === "deno_core" && item.kind === null);
  if (!deno || deno.source !== "registry+https://github.com/rust-lang/crates.io-index") throw new Error("Rust 脚手架当前要求宿主 deno_core 来自 crates.io；不能猜测其他来源的类型身份。");
  const crateName = `tiangz_${id.replaceAll(/[.-]/g, "_")}_native`;
  const native = { source: "native", crate: "rust", crateName, generatedRust: "rust/src/generated", generatedTypeScript: "src/model/generated/native" };
  for (const file of ["native/Example.native", "rust/src/lib.rs", "rust/src/native_data.rs", "src/model/NativeExample.ts", "RUST.md"]) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), await readFile(path.join(engine, "tools/templates/module-native", file), "utf8"));
  }
  await writeFile(path.join(directory, "rust/Cargo.toml"), `[package]\nname = ${JSON.stringify(crateName)}\nversion = ${JSON.stringify(version)}\nedition = "2024"\n\n[dependencies]\ndeno_core = ${JSON.stringify(deno.req)}\n`);
  return native;
}
