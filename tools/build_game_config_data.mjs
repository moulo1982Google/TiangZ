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
const files = await readPackageFiles(source, manifest);

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
if (!initial) {
  const activeManifest = JSON.parse(
    await readFile(path.join(dist, "game-config", "game-config.manifest.json"), "utf8"),
  );
  if (activeManifest.coldDataFingerprint !== manifest.coldDataFingerprint) {
    throw new Error(
      "Cold GameConfig data changed; reload-config is forbidden. Run npm run build, deploy the full package, and restart the Process.",
    );
  }
}
await publish(candidate, manifest, files);
if (initial) {
  await publish(path.join(dist, "game-config"), manifest, files, true);
}

const mode = initial ? "startup" : "hot-reload-candidate";
const relativeCandidate = path.relative(root, candidate).replaceAll(path.sep, "/");
process.stdout.write(
  `[build:game-config] mode=${mode} schema=${manifest.schemaFingerprint.slice(0, 12)} data=${manifest.dataFingerprint.slice(0, 12)} candidate=${relativeCandidate}\n`,
);
if (initial) {
  process.stdout.write(
    "[build:game-config] 已更新dist/game-config，服务器重启时会读取这个启动包。\n",
  );
} else {
  process.stdout.write(
    "[build:game-config] 仅生成热重载候选，不会更新dist/game-config；重启生效请运行npm run build:game-config:startup。\n",
  );
}

/** 原子发布完整数据包；候选按内容寻址，initial目录允许完整替换。 / Atomically publishes a complete package; candidates are content-addressed while the initial directory may be replaced. */
async function publish(directory, value, files, replace = false) {
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
  for (const [name, bytes] of files) await writeFile(path.join(building, name), bytes);
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
  if (value.formatVersion !== 2) throw new Error("unsupported game config manifest format");
  for (const key of [
    "schemaFingerprint",
    "clientSchemaFingerprint",
    "dataFingerprint",
    "hotDataFingerprint",
    "coldDataFingerprint",
    "serverHash",
    "serverHotHash",
    "serverColdHash",
    "clientHash",
    "clientHotHash",
    "clientColdHash",
  ]) {
    if (!/^[0-9a-f]{64}$/.test(value[key])) throw new Error(`invalid ${key}`);
  }
  const expectedFiles = {
    serverFile: "server.json",
    serverHotFile: "server.hot.json",
    serverColdFile: "server.cold.json",
    clientFile: "client.json",
    clientHotFile: "client.hot.json",
    clientColdFile: "client.cold.json",
  };
  if (Object.entries(expectedFiles).some(([key, expected]) => value[key] !== expected)) {
    throw new Error("game config data filenames are fixed");
  }
  if (!Array.isArray(value.reloadPolicies?.hot) || !Array.isArray(value.reloadPolicies?.cold)) {
    throw new Error("game config reload policies are missing");
  }
}

async function readPackageFiles(directory, value) {
  const specs = [
    [value.serverFile, value.serverHash, "server data"],
    [value.serverHotFile, value.serverHotHash, "server hot data"],
    [value.serverColdFile, value.serverColdHash, "server cold data"],
    [value.clientFile, value.clientHash, "client data"],
    [value.clientHotFile, value.clientHotHash, "client hot data"],
    [value.clientColdFile, value.clientColdHash, "client cold data"],
  ];
  const files = [];
  for (const [name, hash, description] of specs) {
    const bytes = await readFile(path.join(directory, name));
    assertHash(bytes, hash, description);
    files.push([name, bytes]);
  }
  assertCombinedHash(files[0][1], files[3][1], value.dataFingerprint, "complete game config");
  assertCombinedHash(files[1][1], files[4][1], value.hotDataFingerprint, "hot game config");
  assertCombinedHash(files[2][1], files[5][1], value.coldDataFingerprint, "cold game config");
  return files;
}

function assertCombinedHash(server, client, expected, name) {
  const actual = sha256(Buffer.concat([server, Buffer.from([0]), client]));
  if (actual !== expected) throw new Error(`${name} fingerprint mismatch: expected ${expected}, actual ${actual}`);
}

function assertHash(bytes, expected, name) {
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`${name} hash mismatch: expected ${expected}, actual ${actual}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
