import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "game_config", "generated");
const dist = path.join(root, "dist");
const initial = process.argv.includes("--initial");
const manifest = JSON.parse(
  await readFile(path.join(source, "game-config.manifest.json"), "utf8"),
);

validateManifest(manifest);
const serverData = await readFile(path.join(source, manifest.serverFile));
const clientData = await readFile(path.join(source, manifest.clientFile));
assertHash(serverData, manifest.serverHash, "server data");
assertHash(clientData, manifest.clientHash, "client data");

const modelManifest = JSON.parse(
  await readFile(path.join(dist, "model.manifest.json"), "utf8"),
);
if (modelManifest.gameConfigSchemaFingerprint !== manifest.schemaFingerprint) {
  throw new Error(
    "GameConfig schema changed; data-only build is forbidden. Run npm run build and restart the Process.",
  );
}

const candidatesRoot = path.join(dist, "game-config-candidates");
const candidate = path.join(candidatesRoot, manifest.dataFingerprint.slice(0, 16));
await publish(candidate, manifest, serverData, clientData);
if (initial) {
  await publish(path.join(dist, "game-config"), manifest, serverData, clientData, true);
}

process.stdout.write(
  `[build:game-config] schema=${manifest.schemaFingerprint.slice(0, 12)} data=${manifest.dataFingerprint.slice(0, 12)} candidate=${path.relative(root, candidate).replaceAll(path.sep, "/")}\n`,
);

/** 原子发布完整数据包；候选按内容寻址，initial目录允许完整替换。 / Atomically publishes a complete package; candidates are content-addressed while the initial directory may be replaced. */
async function publish(directory, value, server, client, replace = false) {
  if (!replace) {
    try {
      const existing = JSON.parse(
        await readFile(path.join(directory, "game-config.manifest.json"), "utf8"),
      );
      if (existing.dataFingerprint === value.dataFingerprint) return;
      throw new Error(`immutable game config candidate collision: ${directory}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const building = `${directory}.building-${process.pid}`;
  await rm(building, { recursive: true, force: true });
  await mkdir(building, { recursive: true });
  await writeFile(path.join(building, value.serverFile), server);
  await writeFile(path.join(building, value.clientFile), client);
  await writeFile(
    path.join(building, "game-config.manifest.json"),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
  if (replace) await rm(directory, { recursive: true, force: true });
  await mkdir(path.dirname(directory), { recursive: true });
  await rename(building, directory);
}

function validateManifest(value) {
  if (value.formatVersion !== 1) throw new Error("unsupported game config manifest format");
  for (const key of [
    "schemaFingerprint",
    "clientSchemaFingerprint",
    "dataFingerprint",
    "serverHash",
    "clientHash",
  ]) {
    if (!/^[0-9a-f]{64}$/.test(value[key])) throw new Error(`invalid ${key}`);
  }
  if (value.serverFile !== "server.json" || value.clientFile !== "client.json") {
    throw new Error("game config data filenames are fixed");
  }
}

function assertHash(bytes, expected, name) {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`${name} hash mismatch: expected ${expected}, actual ${actual}`);
}
