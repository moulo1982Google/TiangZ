import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "tiangz-module-config-codegen-"));
const moduleRoot = path.join(temporary, "modules", "cards");

try {
  await writeFixture(moduleRoot);
  await runCodegen();

  const generatedDataRoot = path.join(moduleRoot, "game_config", "generated");
  const generatedCodeRoot = path.join(moduleRoot, "src", "hotfix", "generated", "config");
  const manifest = JSON.parse(await readFile(
    path.join(generatedDataRoot, "module-game-config.manifest.json"),
    "utf8",
  ));
  const tables = JSON.parse(await readFile(path.join(generatedDataRoot, "server.json"), "utf8"));
  const schema = await readFile(path.join(generatedCodeRoot, "schema.ts"), "utf8");
  const clientData = await readFile(path.join(moduleRoot, "generated/client/data/client.json"), "utf8");
  if (!clientData.includes("Starter Deck") || clientData.includes("server-only")) {
    throw new Error("client config export omitted public data or leaked a server field");
  }

  if (manifest.moduleId !== "org.example.cards" || manifest.target !== "server") {
    throw new Error(`generated manifest mismatch: ${JSON.stringify(manifest)}`);
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.schemaFingerprint)) {
    throw new Error("generated schema fingerprint is invalid");
  }
  if (tables.cards_tbcard?.[0]?.name !== "Starter Deck") {
    throw new Error(`generated table mismatch: ${JSON.stringify(tables)}`);
  }
  if (!schema.includes("export class Card") || !schema.includes("export class Tables")) {
    throw new Error("generated TypeScript schema is missing the declared table types");
  }

  await runCodegen("--check");
  const other = path.join(temporary, "modules", "catalog");
  await writeFixture(other, "org.example.catalog");
  run("tools/codegen_module_configs.mjs", ["--modules-dir", path.dirname(moduleRoot)]);
  const dist = path.join(temporary, "dist");
  const bundleArgs = ["--modules-dir", path.dirname(moduleRoot), "--out-dir", dist];
  run("tools/prepare_game_modules.mjs", ["--modules-dir", path.dirname(moduleRoot)]);
  run("tools/build_runtime_bundles.mjs", bundleArgs);
  run("tools/build_game_config_data.mjs", ["--out-dir", dist, "--initial"]);
  const context = { TextEncoder, TextDecoder, console, setTimeout, clearTimeout };
  runInNewContext(await readFile(path.join(dist, "model.js"), "utf8"), context);
  const hostManifest = JSON.parse(await readFile(path.join(dist, "game-config/game-config.manifest.json"), "utf8"));
  const hostData = await readFile(path.join(dist, "game-config/server.json"), "utf8");
  const install = (manifest) => JSON.parse(context.__etsInstallGameConfig(JSON.stringify(manifest), hostData));
  assert.equal(install(hostManifest).moduleConfigGeneration, 1);
  const registry = context.__tiangzModelExports.ModuleConfigRegistry;
  const old = registry.Get("org.example.cards");
  const candidates = JSON.parse(hostManifest.moduleConfigsJson);
  candidates[0].tables.cards_tbcard[0].name = "Updated Catalog";
  candidates[1].tables.cards_tbcard[0].name = "Updated Cards";
  const updated = { ...hostManifest, moduleConfigsJson: JSON.stringify(candidates) };
  assert.equal(install(updated).moduleConfigGeneration, 2);
  assert.equal(old.tables.cards_tbcard[0].name, "Starter Deck");
  const latest = registry.Get("org.example.cards");
  const invalid = structuredClone(candidates);
  delete invalid[1].tables.cards_tbcard;
  assert.throws(() => install({ ...hostManifest, moduleConfigsJson: JSON.stringify(invalid) }), /table missing/);
  assert.equal(registry.Get("org.example.cards"), latest);
  assert.equal(registry.Generation, 2);
  assert.throws(() => install({ ...updated, schemaFingerprint: "0".repeat(64) }), /schema|built-in game config/i);
  assert.equal(registry.Generation, 2);
  const changedSchema = structuredClone(candidates);
  changedSchema[0].schemaFingerprint = "0".repeat(64);
  assert.throws(() => install({ ...hostManifest, moduleConfigsJson: JSON.stringify(changedSchema) }), /restart required/);

  await writeFile(
    path.join(moduleRoot, "game_config", "Data", "cards.json"),
    `${JSON.stringify({ cards: [{ id: 1, name: "Changed Deck", tags: ["starter"], secret: "server-only" }] }, null, 2)}\n`,
    "utf8",
  );
  const stale = await runCodegen("--check", true);
  if (stale.code === 0 || !`${stale.stderr}\n${stale.stdout}`.includes("stale")) {
    throw new Error("--check did not reject stale generated module config");
  }
  await runCodegen();
  run("tools/build_runtime_bundles.mjs", [...bundleArgs, "--hotfix-only"]);
  run("tools/build_game_config_data.mjs", ["--out-dir", dist]);
  const configFile = path.join(moduleRoot, "game_config/luban.conf");
  const configText = await readFile(configFile, "utf8");
  const brokenClient = JSON.parse(configText);
  brokenClient.targets = brokenClient.targets.filter((target) => target.name !== "client");
  const beforeFailure = await readFile(path.join(generatedDataRoot, "server.json"), "utf8");
  await writeFile(configFile, JSON.stringify(brokenClient));
  assert.notEqual((await runCodegen(undefined, true)).code, 0);
  assert.equal(await readFile(path.join(generatedDataRoot, "server.json"), "utf8"), beforeFailure);
  await writeFile(configFile, configText);
  const schemaFile = path.join(moduleRoot, "game_config/Defines/cards.xml");
  await writeFile(schemaFile, (await readFile(schemaFile, "utf8")).replace('name="name"', 'name="title"'));
  const sourceFile = path.join(moduleRoot, "game_config/Data/cards.json");
  await writeFile(sourceFile, (await readFile(sourceFile, "utf8")).replace('"name":', '"title":'));
  await runCodegen();
  run("tools/build_runtime_bundles.mjs", [...bundleArgs, "--hotfix-only"], /Model source changed/);
  run("tools/build_game_config_data.mjs", ["--out-dir", dist], /schema changed/);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

process.stdout.write("module game config codegen self-test passed\n");

async function writeFixture(target, id = "org.example.cards") {
  await Promise.all([
    mkdir(path.join(target, "src", "model"), { recursive: true }),
    mkdir(path.join(target, "src", "hotfix"), { recursive: true }),
    mkdir(path.join(target, "game_config", "Defines"), { recursive: true }),
    mkdir(path.join(target, "game_config", "Data"), { recursive: true }),
  ]);
  await writeFile(path.join(target, "src", "model", "index.ts"), `import { defineGameModule } from "#tiangz/core"; defineGameModule({id: ${JSON.stringify(id)}, version: "1.0.0"});\n`, "utf8");
  await writeFile(path.join(target, "src", "hotfix", "index.ts"), "export {};\n", "utf8");
  await writeFile(path.join(target, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true }, include: ["src/**/*.ts"] }));
  await writeFile(path.join(target, "tiangz.module.json"), `${JSON.stringify({
    formatVersion: 1,
    id,
    version: "1.0.0",
    engine: { minVersion: "0.6.0-alpha.0", maxVersionExclusive: "0.7.0" },
    dependencies: [],
    capabilities: ["example.cards"],
    entries: { model: "src/model/index.ts", hotfix: "src/hotfix/index.ts" },
    gameConfig: {
      project: "game_config/luban.conf",
      target: "server",
      generatedCode: "src/hotfix/generated/config",
      generatedData: "game_config/generated",
      client: { target: "client", generatedCode: "generated/client/code", generatedData: "generated/client/data" },
    },
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(target, "game_config", "luban.conf"), `${JSON.stringify({
    groups: [{ names: ["s", "c"], default: true }],
    schemaFiles: [{ fileName: "Defines", type: "" }],
    dataDir: "Data",
    targets: [
      { name: "server", manager: "Tables", groups: ["s"], topModule: "cfg" },
      { name: "client", manager: "Tables", groups: ["c"], topModule: "cfg" },
    ],
    xargs: [],
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(target, "game_config", "Defines", "cards.xml"), `\
<module name="cards">
  <bean name="Card">
    <var name="id" type="int"/>
    <var name="name" type="string"/>
    <var name="tags" type="list,string"/>
    <var name="secret" type="string" group="s"/>
  </bean>
  <table name="TbCard" value="Card" input="*cards@cards.json"/>
</module>
`, "utf8");
  await writeFile(
    path.join(target, "game_config", "Data", "cards.json"),
    `${JSON.stringify({ cards: [{ id: 1, name: "Starter Deck", tags: ["starter"], secret: "server-only" }] }, null, 2)}\n`,
    "utf8",
  );
}

function run(script, args, rejection) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8", windowsHide: true,
    env: { ...process.env, TIANGZ_MODULES_DIR: path.dirname(moduleRoot) } });
  if (result.error) throw result.error;
  const output = result.stdout + result.stderr;
  if (rejection) { assert.notEqual(result.status, 0, output); assert.match(output, rejection); }
  else assert.equal(result.status, 0, output);
}

function runCodegen(mode, allowFailure = false) {
  const argumentsList = [
    "tools/codegen_module_game_config.mjs",
    "--module-root",
    moduleRoot,
    ...(mode ? [mode] : []),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argumentsList, {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0 || allowFailure) resolve({ code, stdout, stderr });
      else reject(new Error(`${stderr}\n${stdout}`));
    });
  });
}
