import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
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
const directory = await mkdtemp(path.join(root, "temp", "module-migration-runtime-"));
const key = `acceptance-${Date.now()}`;
const executable = path.join(root, "target/debug", process.platform === "win32" ? "TiangZ.exe" : "TiangZ");
try {
  await mkdir(path.join(directory, "configs"));
  await mkdir(path.join(directory, "dist"));
  for (const name of ["model.js", "hotfix.js", "model.manifest.json", "hotfix.manifest.json", "game-config"]) {
    await cp(path.join(root, "dist", name), path.join(directory, "dist", name), { recursive: true });
  }
  const original = await readFile(path.join(directory, "dist/model.js"), "utf8");
  const port = await freePort();
  await writeFile(path.join(directory, "configs/probe.json"), JSON.stringify({
    process: { name: "module-migration-probe", identity: { originServerId: 32, workerId: 0 },
      persistence: { dbProxy: { endpoint, authTokenEnv: "TIANGZ_DBPROXY_AUTH_TOKEN", clientPoolSize: 1,
        connectTimeoutMs: 5000, requestTimeoutMs: 5000, maxFrameBytes: 8388608 } } },
    scenes: [{ name: "probe", sceneType: "Location", ip: "127.0.0.1", port }],
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
    await writeFile(path.join(directory, "dist/model.js"), model);
    for (const file of ["model.manifest.json", "hotfix.manifest.json"]) {
      const manifestPath = path.join(directory, "dist", file);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.modelFingerprint = createHash("sha256").update(model).digest("hex");
      await writeFile(manifestPath, JSON.stringify(manifest));
    }
    const child = spawn(executable, ["configs/probe.json"], { cwd: directory, windowsHide: true,
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
      assert.match(output, new RegExp(`MODULE_MIGRATION_${mode.toUpperCase()}_PASSED`));
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
