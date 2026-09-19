import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { atomicReleaseId } from "./atomic_release_identity.mjs";
import { stopRuntime, sleep } from "./lib/process_test_harness.mjs";

const root = path.resolve(import.meta.dirname, "..");
const endpoint = argument("--endpoint");
if (!endpoint) throw new Error("--endpoint must name an isolated acceptance DBProxy");
const envFile = argument("--env-file");
let token = process.env.TIANGZ_DBPROXY_AUTH_TOKEN;
if (!token && envFile) {
  const content = await readFile(path.resolve(envFile), "utf8");
  token = /^DBPROXY_AUTH_TOKEN=(.+)$/m.exec(content)?.[1]?.trim().replace(/^(['"])(.*)\1$/, "$2");
}
if (!token) throw new Error("set TIANGZ_DBPROXY_AUTH_TOKEN or supply --env-file; credentials are never logged");
await mkdir(path.join(root, "temp"), { recursive: true });
const directory = await mkdtemp(path.join(root, "temp", "module-migration-runtime-"));
const key = `acceptance-${Date.now()}`;
const executable = path.join(root, "target/debug", process.platform === "win32" ? "TiangZ.exe" : "TiangZ");
try {
  // 模块化宿主的主工程dist不含游戏模块；用正式模块工具链构建只含空场景的夹具。
  // The modular Host's engine dist has no game modules; build a fixture with one empty scene through the official module toolchain.
  const modules = path.join(directory, "modules");
  const moduleRoot = path.join(modules, "probe");
  const dist = path.join(directory, "dist");
  const tool = args => execFileSync(process.execPath, args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 180_000,
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TIANGZ_MODULES_DIR: modules } });
  await mkdir(path.join(directory, "configs"));
  tool(["tools/create_game_module.mjs", "--id", "org.tiangz.migrationprobe", "--path", moduleRoot]);
  await writeFile(path.join(moduleRoot, "src/model/index.ts"), `import { EntryScene, entryScene, defineGameModule } from "#tiangz/core";
// 迁移验收只需要宿主场景；读写逻辑由测试注入。 / The migration check only needs a host scene; storage logic is injected by the test.
@entryScene()
export class MigrationProbeScene extends EntryScene {}
defineGameModule({ id: "org.tiangz.migrationprobe", version: "0.1.0", modelExports: { MigrationProbeScene } });
`);
  await writeFile(path.join(moduleRoot, "src/hotfix/index.ts"), "export {};\n");
  tool(["tools/prepare_game_modules.mjs", "--modules-dir", modules]);
  tool(["tools/build_runtime_bundles.mjs", "--modules-dir", modules, "--out-dir", dist]);
  tool(["tools/build_game_config_data.mjs", "--modules-dir", modules, "--out-dir", dist, "--initial"]);
  const original = await readFile(path.join(dist, "model.js"), "utf8");
  const manifests = Object.fromEntries(await Promise.all(["model.manifest.json", "hotfix.manifest.json"].map(async file =>
    [file, await readFile(path.join(dist, file), "utf8")])));
  const port = await freePort();
  const configPath = path.join(directory, "configs/probe.json");
  await writeFile(configPath, JSON.stringify({
    process: { name: "module-migration-probe", identity: { originServerId: 32, workerId: 0 },
      persistence: { dbProxy: { endpoint, authTokenEnv: "TIANGZ_DBPROXY_AUTH_TOKEN", clientPoolSize: 1,
        connectTimeoutMs: 5000, requestTimeoutMs: 5000, maxFrameBytes: 8388608 } } },
    scenes: [{ name: "probe", sceneType: "MigrationProbe", ip: "127.0.0.1", port, protocol: "websocket", audience: "outer" }],
  }));
  for (const mode of ["create", "verify"]) {
    const model = original + `\n(() => {
      const { DbProxyEntityRepository } = globalThis.__tiangzModelExports;
      const codec = (schemaVersion) => ({
        recordNamespace: "org.tiangz.module-migration.acceptance", schema: "org.tiangz.counter", schemaVersion,
        Capture: value => value, Encode: value => new Uint8Array([value.value]), Decode: bytes => ({value: bytes[0]}),
        migrations: schemaVersion === 1 ? [] : [{ fromVersion: 1, toVersion: 2,
          Migrate: bytes => new Uint8Array([bytes[0] + 10]) }]
      });
      const start = globalThis.__etsStartProcess;
      globalThis.__etsStartProcess = async (config) => {
        const old = new DbProxyEntityRepository(codec(1), "acceptance-old");
        const current = new DbProxyEntityRepository(codec(2), "acceptance-current");
        const key = ${JSON.stringify(key)};
        if (${JSON.stringify(mode)} === "create") await old.SaveSnapshot(key, {value: 1}, 0n);
        for (let i = 0; i < 2; i++) {
          const saved = await current.Load(key);
          if (saved?.data.value !== 11 || saved.revision !== 2n) throw new Error("migration did not persist exactly once");
        }
        let rejected = false;
        try { await old.SaveSnapshot(key, {value: 99}, 2n); } catch (error) { rejected = /unsupported/.test(error.message); }
        if (!rejected || (await current.Load(key)).data.value !== 11) throw new Error("old writer overwrote migrated data");
        const result = await start(config);
        console.log("MODULE_MIGRATION_${mode.toUpperCase()}_PASSED");
        return result;
      };
    })();\n`;
    await writeFile(path.join(dist, "model.js"), model);
    const fingerprint = createHash("sha256").update(model).digest("hex");
    for (const [file, content] of Object.entries(manifests)) {
      const manifest = JSON.parse(content);
      manifest.modelFingerprint = fingerprint;
      // 发布身份绑定Model指纹；按同一契约重算，不绕过宿主校验。 / The release identity binds the Model fingerprint; recompute it, never bypass the Host check.
      if (typeof manifest.releaseId === "string") {
        manifest.releaseId = atomicReleaseId(manifest);
        manifest.bundleVersion = `${manifest.bundleVersion.split("+")[0]}+${manifest.releaseId}`;
      }
      await writeFile(path.join(dist, file), JSON.stringify(manifest));
    }
    const child = spawn(executable, [`--runtime-root=${directory}`, configPath], { cwd: directory, windowsHide: true,
      env: { ...process.env, RUST_LOG: "info", TIANGZ_DBPROXY_AUTH_TOKEN: token, TIANGZ_WATCHER_CONTROL: "stdin" }, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let failure;
    child.on("error", (error) => { failure = error; });
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    try {
      const deadline = Date.now() + 30000;
      while (!output.includes(`MODULE_MIGRATION_${mode.toUpperCase()}_PASSED`) && Date.now() < deadline && child.exitCode === null && !failure) await sleep(50);
      if (failure) throw failure;
      assert.match(output, new RegExp(`MODULE_MIGRATION_${mode.toUpperCase()}_PASSED`), output.slice(-4000));
    } finally {
      await stopRuntime({ child });
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log("isolated DBProxy migration, restart read and old-writer rejection passed");

function argument(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
