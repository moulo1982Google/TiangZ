import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectGeneratedFiles, recordGenerator } from "./codegen_manifest.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptFile), "..");
const configRoot = path.join(root, "game_config");
const lubanDll = path.join(root, "tools", "third_party", "luban", "4.10.2", "Luban.dll");
const stagingRoot = path.join(root, "temp", "game-config-codegen");
const serverOutput = path.join(root, "app", "generated", "model", "config");
const clientOutput = path.join(root, "client_sdk", "typescript", "Generated", "Config");
const dataOutput = path.join(configRoot, "generated");
const sources = await collectSources(configRoot);

await rm(stagingRoot, { recursive: true, force: true });
await mkdir(stagingRoot, { recursive: true });

let dataFingerprint;
try {
  const generated = {
    server: await generateTarget("server"),
    client: await generateTarget("client"),
  };
  validateGeneratedSpatialData(generated.server.data);
  const serverSchemaFingerprint = sha256(generated.server.schema);
  const clientSchemaFingerprint = sha256(generated.client.schema);
  const serverData = canonicalJson(generated.server.data);
  const clientData = canonicalJson(generated.client.data);
  const reloadPolicies = readReloadPolicies(generated.server.data, generated.client.data);
  const serverPartitions = partitionData(generated.server.data, reloadPolicies);
  const clientPartitions = partitionData(generated.client.data, reloadPolicies);
  const serverHotData = canonicalJson(serverPartitions.hot);
  const serverColdData = canonicalJson(serverPartitions.cold);
  const clientHotData = canonicalJson(clientPartitions.hot);
  const clientColdData = canonicalJson(clientPartitions.cold);
  dataFingerprint = sha256(`${serverData}\0${clientData}`);
  const manifest = {
    formatVersion: 2,
    schemaFingerprint: serverSchemaFingerprint,
    clientSchemaFingerprint,
    dataFingerprint,
    hotDataFingerprint: sha256(`${serverHotData}\0${clientHotData}`),
    coldDataFingerprint: sha256(`${serverColdData}\0${clientColdData}`),
    reloadPolicies,
    serverFile: "server.json",
    serverHash: sha256(serverData),
    serverHotFile: "server.hot.json",
    serverHotHash: sha256(serverHotData),
    serverColdFile: "server.cold.json",
    serverColdHash: sha256(serverColdData),
    clientFile: "client.json",
    clientHash: sha256(clientData),
    clientHotFile: "client.hot.json",
    clientHotHash: sha256(clientHotData),
    clientColdFile: "client.cold.json",
    clientColdHash: sha256(clientColdData),
  };
  await writeDataPackage(manifest, {
    serverData,
    serverHotData,
    serverColdData,
    clientData,
    clientHotData,
    clientColdData,
  });
  await writeTarget("server", serverOutput, generated.server, {
    schemaFingerprint: serverSchemaFingerprint,
  });
  await writeTarget("client", clientOutput, generated.client, {
    dataFingerprint,
  });
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}

const outputRoots = [
  ...[serverOutput, clientOutput].map((outputPath) => ({
    path: outputPath,
    extensions: [".ts"],
  })),
  { path: dataOutput, extensions: [".json"] },
];
await recordGenerator(root, {
  id: "game-config",
  command: "npm run codegen:game-config",
  contentInputs: [scriptFile, lubanDll, ...sources],
  outputs: await collectGeneratedFiles(outputRoots),
  outputRoots,
});

console.log(`[codegen:game-config] generated schema and data package fingerprint=${dataFingerprint.slice(0, 12)}`);

async function generateTarget(target) {
  const codeDirectory = path.join(stagingRoot, target, "code");
  const dataDirectory = path.join(stagingRoot, target, "data");
  await mkdir(codeDirectory, { recursive: true });
  await mkdir(dataDirectory, { recursive: true });

  run("dotnet", [
    lubanDll,
    "-t",
    target,
    "-c",
    "typescript-json",
    "-d",
    "json",
    "--conf",
    path.join(configRoot, "luban.conf"),
    "-x",
    `outputCodeDir=${codeDirectory}`,
    "-x",
    `outputDataDir=${dataDirectory}`,
  ]);

  const schema = normalizeText(await readFile(path.join(codeDirectory, "schema.ts"), "utf8"));
  const dataFiles = (await readdir(dataDirectory))
    .filter((name) => name.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right, "en"));
  const data = Object.fromEntries(await Promise.all(dataFiles.map(async (name) => [
    name.slice(0, -".json".length),
    JSON.parse(await readFile(path.join(dataDirectory, name), "utf8")),
  ])));

  return { schema, data };
}

async function writeDataPackage(manifest, data) {
  await rm(dataOutput, { recursive: true, force: true });
  await mkdir(dataOutput, { recursive: true });
  await writeFile(path.join(dataOutput, manifest.serverFile), data.serverData, "utf8");
  await writeFile(path.join(dataOutput, manifest.serverHotFile), data.serverHotData, "utf8");
  await writeFile(path.join(dataOutput, manifest.serverColdFile), data.serverColdData, "utf8");
  await writeFile(path.join(dataOutput, manifest.clientFile), data.clientData, "utf8");
  await writeFile(path.join(dataOutput, manifest.clientHotFile), data.clientHotData, "utf8");
  await writeFile(path.join(dataOutput, manifest.clientColdFile), data.clientColdData, "utf8");
  await writeFile(
    path.join(dataOutput, "game-config.manifest.json"),
    canonicalJson(manifest),
    "utf8",
  );
}

async function writeTarget(target, outputRoot, generated, fingerprints) {
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(outputRoot, "schema.ts"), generated.schema, "utf8");
  await writeFile(
    path.join(outputRoot, "GameConfigs.ts"),
    target === "server"
      ? createServerFacade(fingerprints.schemaFingerprint)
      : createClientFacade(generated.data, fingerprints.dataFingerprint),
    "utf8",
  );
  await writeFile(
    path.join(outputRoot, "index.ts"),
    `// Generated by tools/codegen_game_config.mjs. Do not edit.\nexport * from "./GameConfigs";\nexport { ConfigReloadMode, SpatialMode, game } from "./schema";\n`,
    "utf8",
  );
}

function createServerFacade(schemaFingerprint) {
  return `// Generated by tools/codegen_game_config.mjs for server. Do not edit.
import { SpatialMode, Tables, type game } from "./schema";

export interface GameConfigManifest {
  readonly formatVersion: number;
  readonly schemaFingerprint: string;
  readonly dataFingerprint: string;
  readonly hotDataFingerprint: string;
  readonly coldDataFingerprint: string;
}

export interface GameConfigInstallResult {
  readonly previousFingerprint?: string;
  readonly dataFingerprint: string;
  readonly hotDataFingerprint: string;
  readonly coldDataFingerprint: string;
}

class ConfigTable<T extends { readonly id: number }> {
  private readonly byId: ReadonlyMap<number, T>;
  private readonly values: readonly T[];

  constructor(values: readonly T[]) {
    const copy = values.map((value) => Object.freeze(value));
    this.values = Object.freeze(copy);
    this.byId = new Map(copy.map((value) => [value.id, value]));
  }

  Get(id: number): T {
    const value = this.byId.get(id);
    if (!value) throw new Error(\`game config not found: id=\${id}\`);
    return value;
  }

  TryGet(id: number): T | undefined {
    return this.byId.get(id);
  }

  GetAll(): readonly T[] {
    return this.values;
  }
}

export type ItemConfig = game.ItemConfig;
export type MapConfig = game.MapConfig;
export type PlayerConfig = game.PlayerConfig;
export type AoiConfig = game.AoiConfig;
export type AoiSyncTierConfig = game.AoiSyncTierConfig;

interface GameConfigSnapshot {
  readonly dataFingerprint: string;
  readonly hotDataFingerprint: string;
  readonly coldDataFingerprint: string;
  readonly ItemConfig: ConfigTable<game.ItemConfig>;
  readonly MapConfig: ConfigTable<game.MapConfig>;
  readonly PlayerConfig: ConfigTable<game.PlayerConfig>;
  readonly AoiConfig: ConfigTable<game.AoiConfig>;
  readonly AoiSyncTierConfig: ConfigTable<game.AoiSyncTierConfig>;
}

export const GameConfigSchemaFingerprint = "${schemaFingerprint}";

export class GameConfigRegistry {
  private static current: GameConfigSnapshot | undefined;

  static get CurrentFingerprint(): string | undefined {
    return this.current?.dataFingerprint;
  }

  static get CurrentColdFingerprint(): string | undefined {
    return this.current?.coldDataFingerprint;
  }

  static Install(manifestJson: string, dataJson: string): GameConfigInstallResult {
    const manifest = JSON.parse(manifestJson) as GameConfigManifest;
    if (manifest.formatVersion !== 2) {
      throw new Error(\`unsupported game config manifest format: \${manifest.formatVersion}\`);
    }
    if (manifest.schemaFingerprint !== GameConfigSchemaFingerprint) {
      throw new Error(
        \`game config schema mismatch: model=\${GameConfigSchemaFingerprint}, candidate=\${manifest.schemaFingerprint}\`,
      );
    }
    for (const [name, fingerprint] of Object.entries({
      dataFingerprint: manifest.dataFingerprint,
      hotDataFingerprint: manifest.hotDataFingerprint,
      coldDataFingerprint: manifest.coldDataFingerprint,
    })) {
      if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
        throw new Error(\`game config \${name} must be lowercase sha256\`);
      }
    }
    if (
      this.current !== undefined &&
      manifest.coldDataFingerprint !== this.current.coldDataFingerprint
    ) {
      throw new Error(
        \`cold game config changed: active=\${this.current.coldDataFingerprint}, candidate=\${manifest.coldDataFingerprint}; rebuild and restart the Process\`,
      );
    }

    const rawData = JSON.parse(dataJson) as Record<string, unknown>;
    const tables = new Tables((file) => {
      const value = rawData[file];
      if (value === undefined) throw new Error(\`game config data not found: \${file}\`);
      return value;
    });
    const candidate: GameConfigSnapshot = Object.freeze({
      dataFingerprint: manifest.dataFingerprint,
      hotDataFingerprint: manifest.hotDataFingerprint,
      coldDataFingerprint: manifest.coldDataFingerprint,
      ItemConfig: new ConfigTable<game.ItemConfig>(tables.TbItemConfig.getDataList()),
      MapConfig: new ConfigTable<game.MapConfig>(tables.TbMapConfig.getDataList()),
      PlayerConfig: new ConfigTable<game.PlayerConfig>(tables.TbPlayerConfig.getDataList()),
      AoiConfig: new ConfigTable<game.AoiConfig>(tables.TbAoiConfig.getDataList()),
      AoiSyncTierConfig: new ConfigTable<game.AoiSyncTierConfig>(tables.TbAoiSyncTierConfig.getDataList()),
    });
    validateSnapshot(candidate);

    const previousFingerprint = this.current?.dataFingerprint;
    this.current = candidate;
    return {
      ...(previousFingerprint ? { previousFingerprint } : {}),
      dataFingerprint: candidate.dataFingerprint,
      hotDataFingerprint: candidate.hotDataFingerprint,
      coldDataFingerprint: candidate.coldDataFingerprint,
    };
  }

  static RequireCurrent(): GameConfigSnapshot {
    if (!this.current) throw new Error("game config data is not installed");
    return this.current;
  }
}

export const GameConfigs = Object.freeze({
  get ItemConfig() { return GameConfigRegistry.RequireCurrent().ItemConfig; },
  get MapConfig() { return GameConfigRegistry.RequireCurrent().MapConfig; },
  get PlayerConfig() { return GameConfigRegistry.RequireCurrent().PlayerConfig; },
  get AoiConfig() { return GameConfigRegistry.RequireCurrent().AoiConfig; },
  get AoiSyncTierConfig() { return GameConfigRegistry.RequireCurrent().AoiSyncTierConfig; },
});

function validateSnapshot(snapshot: GameConfigSnapshot): void {
  const tiersByAoi = new Map<number, game.AoiSyncTierConfig[]>();
  for (const tier of snapshot.AoiSyncTierConfig.GetAll()) {
    if (!tier.aoiConfigId_ref) {
      throw new Error(\`AOI sync tier \${tier.id} contains a missing AOI reference\`);
    }
    if (!isPositiveOdd(tier.rangeGrids) || !Number.isSafeInteger(tier.syncHz) || tier.syncHz <= 0) {
      throw new Error(\`AOI sync tier \${tier.id} needs a positive odd range and positive integer Hz\`);
    }
    const tiers = tiersByAoi.get(tier.aoiConfigId) ?? [];
    tiers.push(tier);
    tiersByAoi.set(tier.aoiConfigId, tiers);
  }
  for (const aoi of snapshot.AoiConfig.GetAll()) {
    if (
      !Number.isSafeInteger(aoi.gridSizeCells) || aoi.gridSizeCells <= 0 ||
      !isPositiveOdd(aoi.enterRangeGrids) || !isPositiveOdd(aoi.detachRangeGrids) ||
      aoi.enterRangeGrids > aoi.detachRangeGrids
    ) {
      throw new Error(\`AOI config \${aoi.id} needs positive Grid size and nested odd Enter/Detach ranges\`);
    }
    const tiers = (tiersByAoi.get(aoi.id) ?? []).sort((left, right) => left.rangeGrids - right.rangeGrids);
    if (tiers.length === 0) {
      throw new Error(\`AOI config \${aoi.id} needs at least one sync tier\`);
    }
    for (let index = 0; index < tiers.length; index += 1) {
      const tier = tiers[index];
      if (tier.rangeGrids > aoi.detachRangeGrids) {
        throw new Error(\`AOI sync tier \${tier.id} exceeds Detach range\`);
      }
      if (index > 0) {
        const previous = tiers[index - 1];
        if (tier.rangeGrids === previous.rangeGrids || tier.syncHz > previous.syncHz) {
          throw new Error(\`AOI config \${aoi.id} sync tiers must widen uniquely without increasing Hz\`);
        }
      }
    }
    if (tiers[tiers.length - 1].rangeGrids !== aoi.detachRangeGrids) {
      throw new Error(\`AOI config \${aoi.id} outermost sync tier must equal Detach range\`);
    }
  }
  for (const map of snapshot.MapConfig.GetAll()) {
    if (![map.spawnX, map.spawnY, map.spawnZ, map.spawnYaw, map.cellSizeMeters].every(Number.isFinite)) {
      throw new Error(\`map config \${map.id} contains a non-finite spatial value\`);
    }
    if (!map.aoiConfigId_ref || map.cellSizeMeters <= 0) {
      throw new Error(\`map config \${map.id} needs a positive Cell size and valid AOI config\`);
    }
    if (
      map.widthCells < 3 || map.depthCells < 3 ||
      map.widthCells % map.aoiConfigId_ref.gridSizeCells !== 0 ||
      map.depthCells % map.aoiConfigId_ref.gridSizeCells !== 0
    ) {
      throw new Error(\`map config \${map.id} dimensions must align to its AOI Grid\`);
    }
    if (
      !Number.isSafeInteger(map.entryPlayersPerTick) || map.entryPlayersPerTick <= 0 ||
      !Number.isSafeInteger(map.entryQueueCapacity) ||
      map.entryQueueCapacity < map.entryPlayersPerTick
    ) {
      throw new Error(\`map config \${map.id} has invalid player-entry admission limits\`);
    }
    if (map.spatialMode === SpatialMode.Grid2D) {
      // Grid2D没有额外资源字段；公共地图边界校验已经覆盖Cell与AOI Grid对齐。
    } else if (map.spatialMode === SpatialMode.NavMesh3D) {
      if (!map.navigationAsset || !map.navigationVersion || !/^[0-9a-f]{64}$/.test(map.navigationHash)) {
        throw new Error(\`NavMesh3D map config \${map.id} needs an asset, version, and lowercase SHA-256\`);
      }
    } else {
      throw new Error(\`map config \${map.id} has unsupported spatial mode \${map.spatialMode}\`);
    }
  }
  for (const player of snapshot.PlayerConfig.GetAll()) {
    if (!player.initialMapId_ref || !player.initialItemConfigId_ref) {
      throw new Error(\`player config \${player.id} contains a missing reference\`);
    }
    if (player.initialHp < 0 || player.maxHp <= 0 || player.initialHp > player.maxHp) {
      throw new Error(\`player config \${player.id} has invalid hp values\`);
    }
    if (player.moveSpeed <= 0 || player.initialItemCount < 0) {
      throw new Error(\`player config \${player.id} has invalid movement or item values\`);
    }
  }
}

function isPositiveOdd(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value % 2 === 1;
}
`;
}

/** 在写出任何Generated文件前校验地图与AOI冷配置，避免无效空间数据拖到Runtime启动才失败。 / Validates cold Map/AOI data before writing Generated files. */
function validateGeneratedSpatialData(data) {
  const maps = data.game_tbmapconfig;
  const aois = data.game_tbaoiconfig;
  if (!Array.isArray(maps) || !Array.isArray(aois)) {
    throw new Error("Luban spatial config tables are missing");
  }
  const aoiById = new Map(aois.map((row) => [row.id, row]));
  for (const map of maps) {
    const aoi = aoiById.get(map.aoi_config_id);
    const gridSize = aoi?.grid_size_cells;
    if (!Number.isSafeInteger(gridSize) || gridSize <= 0) {
      throw new Error(`MapConfig ${map.id} references an invalid AoiConfig`);
    }
    if (
      !Number.isSafeInteger(map.width_cells) || !Number.isSafeInteger(map.depth_cells) ||
      map.width_cells < 3 || map.depth_cells < 3 ||
      map.width_cells % gridSize !== 0 || map.depth_cells % gridSize !== 0
    ) {
      throw new Error(
        `MapConfig ${map.id} width_cells/depth_cells must be positive multiples of AOI grid_size_cells=${gridSize}`,
      );
    }
  }
}

function createClientFacade(data, dataFingerprint) {
  return `// Generated by tools/codegen_game_config.mjs for client. Do not edit.
import { Tables, type game } from "./schema";

const RAW_DATA: Record<string, unknown> = ${JSON.stringify(data, null, 2)};

class ConfigTable<T extends { readonly id: number }> {
  private readonly byId: ReadonlyMap<number, T>;
  private readonly values: readonly T[];

  constructor(values: readonly T[]) {
    const copy = values.map((value) => Object.freeze(value));
    this.values = Object.freeze(copy);
    this.byId = new Map(copy.map((value) => [value.id, value]));
  }

  Get(id: number): T {
    const value = this.byId.get(id);
    if (!value) throw new Error(\`game config not found: id=\${id}\`);
    return value;
  }

  TryGet(id: number): T | undefined {
    return this.byId.get(id);
  }

  GetAll(): readonly T[] {
    return this.values;
  }
}

const tables = new Tables((file) => {
  const value = RAW_DATA[file];
  if (value === undefined) throw new Error(\`game config data not found: \${file}\`);
  return value;
});

export type ItemConfig = game.ItemConfig;
export type MapConfig = game.MapConfig;
export type PlayerConfig = game.PlayerConfig;
export type AoiConfig = game.AoiConfig;
export type AoiSyncTierConfig = game.AoiSyncTierConfig;

export const GameConfigFingerprint = "${dataFingerprint}";
export const GameConfigs = Object.freeze({
  ItemConfig: new ConfigTable<game.ItemConfig>(tables.TbItemConfig.getDataList()),
  MapConfig: new ConfigTable<game.MapConfig>(tables.TbMapConfig.getDataList()),
  PlayerConfig: new ConfigTable<game.PlayerConfig>(tables.TbPlayerConfig.getDataList()),
  AoiConfig: new ConfigTable<game.AoiConfig>(tables.TbAoiConfig.getDataList()),
  AoiSyncTierConfig: new ConfigTable<game.AoiSyncTierConfig>(tables.TbAoiSyncTierConfig.getDataList()),
});
`;
}

/** 从Luban元数据表读取每张业务表的冷热策略，并拒绝漏标或客户端未知表。 */
function readReloadPolicies(serverData, clientData) {
  const metadataKey = "game_tbconfigtablepolicy";
  const rows = serverData[metadataKey];
  if (!Array.isArray(rows)) {
    throw new Error(`Luban reload policy table is missing: ${metadataKey}`);
  }
  const hot = [];
  const cold = [metadataKey];
  const declared = new Set();
  for (const row of rows) {
    const tableName = row?.table_name;
    const mode = row?.reload_mode;
    if (typeof tableName !== "string" || tableName.length === 0) {
      throw new Error("Luban reload policy contains an invalid table_name");
    }
    const dataKey = `game_tb${tableName.toLowerCase()}`;
    if (declared.has(dataKey)) throw new Error(`duplicate reload policy: ${tableName}`);
    if (!(dataKey in serverData)) throw new Error(`reload policy references unknown table: ${tableName}`);
    declared.add(dataKey);
    if (mode === 1) hot.push(dataKey);
    else if (mode === 2) cold.push(dataKey);
    else throw new Error(`reload policy ${tableName} has unsupported mode ${mode}`);
  }
  for (const dataKey of Object.keys(serverData)) {
    if (dataKey !== metadataKey && !declared.has(dataKey)) {
      throw new Error(`Luban table has no Hot/Cold reload policy: ${dataKey}`);
    }
  }
  for (const dataKey of Object.keys(clientData)) {
    if (!declared.has(dataKey)) {
      throw new Error(`client Luban table has no Hot/Cold reload policy: ${dataKey}`);
    }
  }
  hot.sort((left, right) => left.localeCompare(right, "en"));
  cold.sort((left, right) => left.localeCompare(right, "en"));
  return Object.freeze({ hot, cold });
}

function partitionData(data, policies) {
  const select = (keys) => Object.fromEntries(
    keys.filter((key) => key in data).map((key) => [key, data[key]]),
  );
  return { hot: select(policies.hot), cold: select(policies.cold) };
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with code=${result.status} signal=${result.signal ?? "none"}`);
  }
}

async function collectSources(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectSources(fullPath));
    else if (entry.isFile() && isGeneratorInput(fullPath)) files.push(fullPath);
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

function isGeneratorInput(file) {
  return [".conf", ".xml", ".xlsx"].includes(path.extname(file).toLowerCase());
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeText(value) {
  return value.replaceAll("\r\n", "\n").replace(/[ \t]+$/gm, "");
}
