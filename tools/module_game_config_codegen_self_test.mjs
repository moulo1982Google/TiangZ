import { spawn } from "node:child_process";
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
  await writeFile(
    path.join(moduleRoot, "game_config", "Data", "cards.json"),
    `${JSON.stringify({ cards: [{ id: 1, name: "Changed Deck", tags: ["starter"] }] }, null, 2)}\n`,
    "utf8",
  );
  const stale = await runCodegen("--check", true);
  if (stale.code === 0 || !`${stale.stderr}\n${stale.stdout}`.includes("stale")) {
    throw new Error("--check did not reject stale generated module config");
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}

process.stdout.write("module game config codegen self-test passed\n");

async function writeFixture(target) {
  await Promise.all([
    mkdir(path.join(target, "src", "model"), { recursive: true }),
    mkdir(path.join(target, "src", "hotfix"), { recursive: true }),
    mkdir(path.join(target, "game_config", "Defines"), { recursive: true }),
    mkdir(path.join(target, "game_config", "Data"), { recursive: true }),
  ]);
  await writeFile(path.join(target, "src", "model", "index.ts"), "export {};\n", "utf8");
  await writeFile(path.join(target, "src", "hotfix", "index.ts"), "export {};\n", "utf8");
  await writeFile(path.join(target, "tiangz.module.json"), `${JSON.stringify({
    formatVersion: 1,
    id: "org.example.cards",
    version: "1.0.0",
    engine: { minVersion: "0.4.0", maxVersionExclusive: "0.5.0" },
    dependencies: [],
    capabilities: ["example.cards"],
    entries: { model: "src/model/index.ts", hotfix: "src/hotfix/index.ts" },
    gameConfig: {
      project: "game_config/luban.conf",
      target: "server",
      generatedCode: "src/hotfix/generated/config",
      generatedData: "game_config/generated",
    },
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(target, "game_config", "luban.conf"), `${JSON.stringify({
    groups: [{ names: ["s"], default: true }],
    schemaFiles: [{ fileName: "Defines", type: "" }],
    dataDir: "Data",
    targets: [{ name: "server", manager: "Tables", groups: ["s"], topModule: "cfg" }],
    xargs: [],
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(target, "game_config", "Defines", "cards.xml"), `\
<module name="cards">
  <bean name="Card">
    <var name="id" type="int"/>
    <var name="name" type="string"/>
    <var name="tags" type="list,string"/>
  </bean>
  <table name="TbCard" value="Card" input="*cards@cards.json"/>
</module>
`, "utf8");
  await writeFile(
    path.join(target, "game_config", "Data", "cards.json"),
    `${JSON.stringify({ cards: [{ id: 1, name: "Starter Deck", tags: ["starter"] }] }, null, 2)}\n`,
    "utf8",
  );
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
