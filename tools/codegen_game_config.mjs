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
  validateGeneratedActionAndSkillData(generated.server.data);
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
    `// Generated by tools/codegen_game_config.mjs. Do not edit.\nexport * from "./GameConfigs";\nexport { ActionType, BuffConflictPolicy, BuffRefreshStatePolicy, BuffRefreshTickPolicy, BuffStackScope, ConfigReloadMode, QuestObjectiveType, QuestStatus, SkillAutoAttackPolicy, SkillDelivery, SkillEffectTarget, SkillMovementPolicy, SkillTargetRelation, SpatialMode, game } from "./schema";\n`,
    "utf8",
  );
}

function createServerFacade(schemaFingerprint) {
  return `// Generated by tools/codegen_game_config.mjs for server. Do not edit.
import { SkillAutoAttackPolicy, SkillDelivery, SkillMovementPolicy, SkillTargetRelation, SpatialMode, Tables, type game } from "./schema";

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
export type BuffConfig = game.BuffConfig;
export type MapConfig = game.MapConfig;
export type PlayerConfig = game.PlayerConfig;
export type AoiConfig = game.AoiConfig;
export type AoiSyncTierConfig = game.AoiSyncTierConfig;
export type MonsterConfig = game.MonsterConfig;
export type MonsterAreaConfig = game.MonsterAreaConfig;
export type SkillConfig = game.SkillConfig;
export type SkillEffectConfig = game.SkillEffectConfig;
export type QuestConfig = game.QuestConfig;
export type QuestObjectiveConfig = game.QuestObjectiveConfig;

interface GameConfigSnapshot {
  readonly dataFingerprint: string;
  readonly hotDataFingerprint: string;
  readonly coldDataFingerprint: string;
  readonly ItemConfig: ConfigTable<game.ItemConfig>;
  readonly BuffConfig: ConfigTable<game.BuffConfig>;
  readonly MapConfig: ConfigTable<game.MapConfig>;
  readonly PlayerConfig: ConfigTable<game.PlayerConfig>;
  readonly AoiConfig: ConfigTable<game.AoiConfig>;
  readonly AoiSyncTierConfig: ConfigTable<game.AoiSyncTierConfig>;
  readonly MonsterConfig: ConfigTable<game.MonsterConfig>;
  readonly MonsterAreaConfig: ConfigTable<game.MonsterAreaConfig>;
  readonly SkillConfig: ConfigTable<game.SkillConfig>;
  readonly SkillEffectConfig: ConfigTable<game.SkillEffectConfig>;
  readonly QuestConfig: ConfigTable<game.QuestConfig>;
  readonly QuestObjectiveConfig: ConfigTable<game.QuestObjectiveConfig>;
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
      BuffConfig: new ConfigTable<game.BuffConfig>(tables.TbBuffConfig.getDataList()),
      MapConfig: new ConfigTable<game.MapConfig>(tables.TbMapConfig.getDataList()),
      PlayerConfig: new ConfigTable<game.PlayerConfig>(tables.TbPlayerConfig.getDataList()),
      AoiConfig: new ConfigTable<game.AoiConfig>(tables.TbAoiConfig.getDataList()),
      AoiSyncTierConfig: new ConfigTable<game.AoiSyncTierConfig>(tables.TbAoiSyncTierConfig.getDataList()),
      MonsterConfig: new ConfigTable<game.MonsterConfig>(tables.TbMonsterConfig.getDataList()),
      MonsterAreaConfig: new ConfigTable<game.MonsterAreaConfig>(tables.TbMonsterAreaConfig.getDataList()),
      SkillConfig: new ConfigTable<game.SkillConfig>(tables.TbSkillConfig.getDataList()),
      SkillEffectConfig: new ConfigTable<game.SkillEffectConfig>(tables.TbSkillEffectConfig.getDataList()),
      QuestConfig: new ConfigTable<game.QuestConfig>(tables.TbQuestConfig.getDataList()),
      QuestObjectiveConfig: new ConfigTable<game.QuestObjectiveConfig>(tables.TbQuestObjectiveConfig.getDataList()),
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
  get BuffConfig() { return GameConfigRegistry.RequireCurrent().BuffConfig; },
  get MapConfig() { return GameConfigRegistry.RequireCurrent().MapConfig; },
  get PlayerConfig() { return GameConfigRegistry.RequireCurrent().PlayerConfig; },
  get AoiConfig() { return GameConfigRegistry.RequireCurrent().AoiConfig; },
  get AoiSyncTierConfig() { return GameConfigRegistry.RequireCurrent().AoiSyncTierConfig; },
  get MonsterConfig() { return GameConfigRegistry.RequireCurrent().MonsterConfig; },
  get MonsterAreaConfig() { return GameConfigRegistry.RequireCurrent().MonsterAreaConfig; },
  get SkillConfig() { return GameConfigRegistry.RequireCurrent().SkillConfig; },
  get SkillEffectConfig() { return GameConfigRegistry.RequireCurrent().SkillEffectConfig; },
  get QuestConfig() { return GameConfigRegistry.RequireCurrent().QuestConfig; },
  get QuestObjectiveConfig() { return GameConfigRegistry.RequireCurrent().QuestObjectiveConfig; },
});

function validateSnapshot(snapshot: GameConfigSnapshot): void {
  for (const item of snapshot.ItemConfig.GetAll()) {
    if (
      !Number.isSafeInteger(item.cooldownMs) || item.cooldownMs < 0 ||
      !Number.isSafeInteger(item.globalCooldownMs) || item.globalCooldownMs < 0
    ) {
      throw new Error(\`item config \${item.id} has invalid cooldown values\`);
    }
    if (!Number.isSafeInteger(item.useEffect) || item.useEffect < 0 || item.useEffect > 2) {
      throw new Error(\`item config \${item.id} has unsupported use effect \${item.useEffect}\`);
    }
    if (!item.useParams.every(Number.isSafeInteger)) {
      throw new Error(\`item config \${item.id} contains a non-integer use parameter\`);
    }
    if (item.useEffect === 0 && item.useParams.length !== 0) {
      throw new Error(\`item config \${item.id} cannot carry parameters when useEffect is 0\`);
    }
    if (item.useEffect === 1) {
      if (item.useParams.length !== 1 || !snapshot.BuffConfig.TryGet(item.useParams[0])) {
        throw new Error(\`item config \${item.id} AddBuff requires one valid BuffConfig id\`);
      }
    }
    if (item.useEffect === 2) {
      if (item.useParams.length === 0) {
        throw new Error(\`item config \${item.id} ExecuteAction requires [actionType, ...parameters]\`);
      }
      validateActionConfig(
        \`item config \${item.id}\`,
        "use",
        item.useParams[0],
        item.useParams.slice(1),
        false,
        snapshot,
      );
    }
  }
  for (const quest of snapshot.QuestConfig.GetAll()) {
    if (quest.objectiveIds.length === 0 || new Set(quest.objectiveIds).size !== quest.objectiveIds.length) {
      throw new Error(\`quest config \${quest.id} needs unique objectives\`);
    }
    for (const objectiveId of quest.objectiveIds) {
      const objective = snapshot.QuestObjectiveConfig.TryGet(objectiveId);
      if (!objective || objective.questConfigId !== quest.id) {
        throw new Error(\`quest config \${quest.id} references invalid objective \${objectiveId}\`);
      }
    }
    if (!Number.isSafeInteger(quest.minimumLevel) || quest.minimumLevel < 1) {
      throw new Error(\`quest config \${quest.id} has invalid minimum level \${quest.minimumLevel}\`);
    }
    if (new Set(quest.requiredQuestIds).size !== quest.requiredQuestIds.length) {
      throw new Error(\`quest config \${quest.id} has duplicate prerequisites\`);
    }
    for (const requiredQuestId of quest.requiredQuestIds) {
      if (requiredQuestId === quest.id || !snapshot.QuestConfig.TryGet(requiredQuestId)) {
        throw new Error(\`quest config \${quest.id} references invalid prerequisite \${requiredQuestId}\`);
      }
    }
    if (quest.autoAccept && quest.requiredQuestIds.length !== 0) {
      throw new Error(\`auto-accept quest \${quest.id} cannot require completed quests\`);
    }
    validateActionConfig(\`QuestConfig \${quest.id}\`, "reward", quest.rewardActionType, quest.rewardActionParams, false, snapshot);
  }
  const visitingQuests = new Set<number>();
  const visitedQuests = new Set<number>();
  const visitQuest = (questId: number): void => {
    if (visitedQuests.has(questId)) return;
    if (visitingQuests.has(questId)) throw new Error(\`quest prerequisite cycle contains \${questId}\`);
    visitingQuests.add(questId);
    for (const requiredQuestId of snapshot.QuestConfig.Get(questId).requiredQuestIds) visitQuest(requiredQuestId);
    visitingQuests.delete(questId);
    visitedQuests.add(questId);
  };
  for (const quest of snapshot.QuestConfig.GetAll()) visitQuest(quest.id);
  for (const objective of snapshot.QuestObjectiveConfig.GetAll()) {
    if (!snapshot.QuestConfig.TryGet(objective.questConfigId) || objective.objectiveType < 1 || objective.objectiveType > 3 || objective.targetConfigId <= 0 || objective.requiredCount <= 0) {
      throw new Error(\`quest objective \${objective.id} has invalid owner, type, target, or count\`);
    }
  }
  for (const buff of snapshot.BuffConfig.GetAll()) {
    if (buff.description.trim().length === 0) {
      throw new Error(\`buff config \${buff.id} needs a non-empty server description\`);
    }
    if (
      !Number.isSafeInteger(buff.durationSeconds) || buff.durationSeconds < 0 ||
      !Number.isSafeInteger(buff.tickIntervalMs) || buff.tickIntervalMs < 0
    ) {
      throw new Error(\`buff config \${buff.id} has invalid duration or tick interval\`);
    }
    if (!Number.isSafeInteger(buff.stackGroup) || buff.stackGroup <= 0) {
      throw new Error(\`buff config \${buff.id} needs a positive stack group\`);
    }
    if (buff.stackScope < 1 || buff.stackScope > 2) {
      throw new Error(\`buff config \${buff.id} has unsupported stack scope \${buff.stackScope}\`);
    }
    if (buff.conflictPolicy < 1 || buff.conflictPolicy > 5) {
      throw new Error(\`buff config \${buff.id} has unsupported conflict policy \${buff.conflictPolicy}\`);
    }
    if (!Number.isSafeInteger(buff.conflictPriority) || buff.conflictPriority < 0) {
      throw new Error(\`buff config \${buff.id} has invalid conflict priority\`);
    }
    if (buff.conflictPolicy === 5 && buff.conflictPriority <= 0) {
      throw new Error(\`buff config \${buff.id} HigherWins requires a positive conflict priority\`);
    }
    if (buff.refreshTickPolicy < 1 || buff.refreshTickPolicy > 2) {
      throw new Error(\`buff config \${buff.id} has unsupported refresh Tick policy\`);
    }
    if (buff.refreshRuntimeState < 1 || buff.refreshRuntimeState > 2) {
      throw new Error(\`buff config \${buff.id} has unsupported refresh runtime-state policy\`);
    }
    validateActionConfig(
      "BuffConfig " + buff.id,
      "add",
      buff.addActionType,
      buff.addActionParams,
      false,
      snapshot,
    );
    validateActionConfig(
      "BuffConfig " + buff.id,
      "tick",
      buff.tickActionType,
      buff.tickActionParams,
      false,
      snapshot,
    );
    validateActionConfig(
      "BuffConfig " + buff.id,
      "remove",
      buff.removeActionType,
      buff.removeActionParams,
      true,
      snapshot,
    );
    if (buff.tickIntervalMs === 0 && buff.tickActionType !== 0) {
      throw new Error(\`buff config \${buff.id} has a Tick Action but no tick interval\`);
    }
    if (buff.tickIntervalMs > 0 && buff.tickActionType === 0) {
      throw new Error(\`buff config \${buff.id} has a tick interval but no Tick Action\`);
    }
  }
  const effectsBySkill = new Map<number, game.SkillEffectConfig[]>();
  for (const effect of snapshot.SkillEffectConfig.GetAll()) {
    if (!effect.skillId_ref) {
      throw new Error(\`skill effect \${effect.id} contains a missing SkillConfig reference\`);
    }
    if (!Number.isSafeInteger(effect.order) || effect.order <= 0) {
      throw new Error(\`skill effect \${effect.id} needs a positive integer order\`);
    }
    if (effect.target < 1 || effect.target > 2) {
      throw new Error(\`skill effect \${effect.id} has unsupported target \${effect.target}\`);
    }
    if (effect.description.trim().length === 0) {
      throw new Error(\`skill effect \${effect.id} needs a non-empty description\`);
    }
    if (effect.actionType === 0) {
      throw new Error(\`skill effect \${effect.id} cannot use ActionType.None\`);
    }
    validateActionConfig(
      \`SkillEffectConfig \${effect.id}\`,
      "resolve",
      effect.actionType,
      effect.actionParams,
      false,
      snapshot,
    );
    const effects = effectsBySkill.get(effect.skillId) ?? [];
    if (effects.some((current) => current.order === effect.order)) {
      throw new Error(\`skill config \${effect.skillId} has duplicate effect order \${effect.order}\`);
    }
    effects.push(effect);
    effectsBySkill.set(effect.skillId, effects);
  }
  for (const skill of snapshot.SkillConfig.GetAll()) {
    if (skill.description.trim().length === 0) {
      throw new Error(\`skill config \${skill.id} needs a non-empty description\`);
    }
    if (
      !Number.isSafeInteger(skill.castTimeMs) || skill.castTimeMs < 0 ||
      !Number.isSafeInteger(skill.cooldownMs) || skill.cooldownMs < 0 ||
      !Number.isSafeInteger(skill.globalCooldownMs) || skill.globalCooldownMs < 0 ||
      !Number.isFinite(skill.rangeMeters) || skill.rangeMeters <= 0 ||
      !Number.isSafeInteger(skill.queueWindowMs) || skill.queueWindowMs < 0 ||
      !Number.isSafeInteger(skill.channelTickMs) || skill.channelTickMs < 0 ||
      !Number.isSafeInteger(skill.channelTicks) || skill.channelTicks < 0
    ) {
      throw new Error(\`skill config \${skill.id} has invalid cast, cooldown, range, queue, or channel values\`);
    }
    if (skill.targetRelation < SkillTargetRelation.Enemy || skill.targetRelation > SkillTargetRelation.Friendly) {
      throw new Error(\`skill config \${skill.id} has unsupported target relation\`);
    }
    if (skill.movementPolicy < SkillMovementPolicy.Allow || skill.movementPolicy > SkillMovementPolicy.InterruptWhileCasting) {
      throw new Error(\`skill config \${skill.id} has unsupported movement policy\`);
    }
    if (skill.autoAttackPolicy < SkillAutoAttackPolicy.Keep || skill.autoAttackPolicy > SkillAutoAttackPolicy.Cancel) {
      throw new Error(\`skill config \${skill.id} has unsupported auto-attack policy\`);
    }
    if (skill.delivery === SkillDelivery.Direct) {
      if (skill.projectileSpeedMetersPerSecond !== 0) {
        throw new Error(\`direct skill config \${skill.id} must use zero projectile speed\`);
      }
    } else if (skill.delivery === SkillDelivery.Projectile) {
      if (!Number.isFinite(skill.projectileSpeedMetersPerSecond) || skill.projectileSpeedMetersPerSecond <= 0) {
        throw new Error(\`projectile skill config \${skill.id} needs a positive projectile speed\`);
      }
    } else {
      throw new Error(\`skill config \${skill.id} has unsupported delivery \${skill.delivery}\`);
    }
    if ((skill.channelTickMs === 0) !== (skill.channelTicks === 0)) {
      throw new Error(\`skill config \${skill.id} must configure channel tick interval and count together\`);
    }
    if (skill.channelTicks > 0 && (skill.delivery !== SkillDelivery.Direct || skill.castTimeMs < skill.channelTickMs * skill.channelTicks)) {
      throw new Error(\`skill config \${skill.id} channel must be direct and fit inside cast time\`);
    }
    if (
      skill.requiredAbsentBuffConfigId > 0 &&
      !snapshot.BuffConfig.TryGet(skill.requiredAbsentBuffConfigId)
    ) {
      throw new Error(\`skill config \${skill.id} references a missing blocking BuffConfig\`);
    }
    if ((effectsBySkill.get(skill.id) ?? []).length === 0) {
      throw new Error(\`skill config \${skill.id} needs at least one SkillEffectConfig row\`);
    }
  }
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
    if (
      player.moveSpeed <= 0 ||
      player.initialItemCount < 0 ||
      player.attackRange <= 0 ||
      player.attackRange > 4
    ) {
      throw new Error(\`player config \${player.id} has invalid movement, combat, or item values\`);
    }
  }
  for (const monster of snapshot.MonsterConfig.GetAll()) {
    if (
      monster.maxHp <= 0 ||
      monster.attackDamage < 0 ||
      monster.moveSpeed <= 0 ||
      monster.attackRange <= 0 ||
      monster.attackRange > 4 ||
      !Number.isSafeInteger(monster.attackIntervalMs) ||
      monster.attackIntervalMs <= 0 ||
      !Number.isSafeInteger(monster.respawnSeconds) ||
      monster.respawnSeconds < 0 ||
      (monster.attackMode !== 0 && monster.attackMode !== 1) ||
      monster.skillId < 0
    ) {
      throw new Error(\`monster config \${monster.id} has invalid combat values\`);
    }
  }
  for (const area of snapshot.MonsterAreaConfig.GetAll()) {
    if (!area.mapConfigId_ref || !area.monsterConfigId_ref) {
      throw new Error(\`monster spawn slot \${area.id} contains a missing reference\`);
    }
    if (
      ![area.spawnX, area.spawnY, area.spawnZ, area.spawnYaw].every(Number.isFinite) ||
      typeof area.initialSpawn !== "boolean"
    ) {
      throw new Error(\`monster spawn slot \${area.id} has invalid spatial or lifecycle values\`);
    }
  }
}

function validateActionConfig(
  owner: string,
  phase: string,
  type: number,
  parameters: readonly number[],
  allowEmptyRemove: boolean,
  snapshot: GameConfigSnapshot,
): void {
  if (!Number.isSafeInteger(type) || type < 0 || type > 7) {
    throw new Error(\`\${owner} has unsupported \${phase} Action type \${type}\`);
  }
  if (!parameters.every(Number.isSafeInteger)) {
    throw new Error(\`\${owner} has non-integer \${phase} Action parameters\`);
  }
  const expected = type === 0
    ? 0
    : type === 1
      ? 2
      : type === 2
        ? 1
        : type === 3
          ? allowEmptyRemove ? undefined : 1
          : type === 4
            ? 2
            : type === 6
              ? 1
              : type === 7
                ? 2
                : undefined;
  if (expected !== undefined && parameters.length !== expected) {
    throw new Error(\`\${owner} \${phase} Action expects \${expected} parameters\`);
  }
  if (type === 3 && expected === undefined && parameters.length > 1) {
    throw new Error(\`\${owner} \${phase} RemoveBuff expects zero or one parameter\`);
  }
  if (type === 5 && (parameters.length < 1 || parameters.length > 2)) {
    throw new Error(\`\${owner} \${phase} RegisterDamageAbsorber expects one or two parameters\`);
  }
  if (type === 1) {
    const numericType = parameters[0];
    if (numericType <= 0 || (numericType >= 1_000 && numericType <= 9_999)) {
      throw new Error(\`\${owner} \${phase} ChangeNumeric targets an invalid or derived NumericType\`);
    }
  }
  if (type === 2 && !snapshot.BuffConfig.TryGet(parameters[0])) {
    throw new Error(\`\${owner} \${phase} AddBuff references a missing BuffConfig\`);
  }
  if (type === 3 && parameters.length === 1 && parameters[0] <= 0) {
    throw new Error(\`\${owner} \${phase} RemoveBuff needs a positive runtime Buff instance id\`);
  }
  if (type === 4) {
    if (parameters[0] < 0 || parameters[1] < 1 || parameters[1] > 4) {
      throw new Error(\`\${owner} \${phase} DealDamage needs [non-negative amount, valid DamageSchool]\`);
    }
  }
  if (type === 5 && (parameters[0] <= 0 || (parameters[1] ?? 0) < 0)) {
    throw new Error(\`\${owner} \${phase} RegisterDamageAbsorber needs positive amount and non-negative priority\`);
  }
  if (type === 6 && parameters[0] < 0) {
    throw new Error(\`\${owner} \${phase} Heal needs a non-negative amount\`);
  }
  if (type === 7 && (!snapshot.ItemConfig.TryGet(parameters[0]) || parameters[1] <= 0)) {
    throw new Error(\`\${owner} \${phase} GrantItem needs [valid ItemConfig, positive count]\`);
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

/** 在覆盖Generated输出前校验Buff/Action/Skill跨表约束，坏表不会进入运行包。 / Validates Buff, Action, and Skill cross-table contracts before replacing Generated output. */
function validateGeneratedActionAndSkillData(data) {
  const items = data.game_tbitemconfig;
  const buffs = data.game_tbbuffconfig;
  const skills = data.game_tbskillconfig;
  const effects = data.game_tbskilleffectconfig;
  if (!Array.isArray(items) || !Array.isArray(buffs) || !Array.isArray(skills) || !Array.isArray(effects)) {
    throw new Error("Luban Item/Buff/Skill config tables are missing");
  }
  const buffIds = new Set(buffs.map((row) => row.id));
  for (const item of items) {
    if (item.use_effect === 0 && item.use_params.length !== 0) {
      throw new Error(`ItemConfig ${item.id} cannot carry parameters when use_effect is 0`);
    }
    if (item.use_effect === 1) {
      if (item.use_params.length !== 1 || !buffIds.has(item.use_params[0])) {
        throw new Error(`ItemConfig ${item.id} AddBuff requires one valid BuffConfig id`);
      }
    } else if (item.use_effect === 2) {
      if (item.use_params.length === 0) {
        throw new Error(`ItemConfig ${item.id} ExecuteAction requires [actionType, ...parameters]`);
      }
      validateRawAction(
        `ItemConfig ${item.id}`,
        item.use_params[0],
        item.use_params.slice(1),
        buffIds,
        false,
      );
    } else if (item.use_effect !== 0) {
      throw new Error(`ItemConfig ${item.id} has unsupported use_effect ${item.use_effect}`);
    }
  }
  for (const buff of buffs) {
    validateRawAction(`BuffConfig ${buff.id} add`, buff.add_action_type, buff.add_action_params, buffIds, false);
    validateRawAction(`BuffConfig ${buff.id} tick`, buff.tick_action_type, buff.tick_action_params, buffIds, false);
    validateRawAction(`BuffConfig ${buff.id} remove`, buff.remove_action_type, buff.remove_action_params, buffIds, true);
    if ((buff.tick_interval_ms === 0) !== (buff.tick_action_type === 0)) {
      throw new Error(`BuffConfig ${buff.id} Tick interval and Action must be configured together`);
    }
  }

  const skillIds = new Set(skills.map((row) => row.id));
  const effectCountBySkill = new Map();
  const ordersBySkill = new Map();
  for (const effect of effects) {
    if (!skillIds.has(effect.skill_id)) {
      throw new Error(`SkillEffectConfig ${effect.id} references missing SkillConfig ${effect.skill_id}`);
    }
    if (!Number.isSafeInteger(effect.order) || effect.order <= 0) {
      throw new Error(`SkillEffectConfig ${effect.id} needs a positive integer order`);
    }
    const orders = ordersBySkill.get(effect.skill_id) ?? new Set();
    if (orders.has(effect.order)) {
      throw new Error(`SkillConfig ${effect.skill_id} has duplicate effect order ${effect.order}`);
    }
    orders.add(effect.order);
    ordersBySkill.set(effect.skill_id, orders);
    if (effect.target !== 1 && effect.target !== 2) {
      throw new Error(`SkillEffectConfig ${effect.id} has unsupported target ${effect.target}`);
    }
    if (typeof effect.description !== "string" || effect.description.trim().length === 0) {
      throw new Error(`SkillEffectConfig ${effect.id} needs a description`);
    }
    if (effect.action_type === 0) {
      throw new Error(`SkillEffectConfig ${effect.id} cannot use ActionType.None`);
    }
    validateRawAction(`SkillEffectConfig ${effect.id}`, effect.action_type, effect.action_params, buffIds, false);
    effectCountBySkill.set(effect.skill_id, (effectCountBySkill.get(effect.skill_id) ?? 0) + 1);
  }
  for (const skill of skills) {
    if (typeof skill.description !== "string" || skill.description.trim().length === 0) {
      throw new Error(`SkillConfig ${skill.id} needs a description`);
    }
    if (
      !Number.isSafeInteger(skill.cast_time_ms) || skill.cast_time_ms < 0 ||
      !Number.isSafeInteger(skill.cooldown_ms) || skill.cooldown_ms < 0 ||
      !Number.isSafeInteger(skill.global_cooldown_ms) || skill.global_cooldown_ms < 0 ||
      !Number.isFinite(skill.range_meters) || skill.range_meters <= 0 ||
      !Number.isSafeInteger(skill.queue_window_ms) || skill.queue_window_ms < 0 ||
      !Number.isSafeInteger(skill.channel_tick_ms) || skill.channel_tick_ms < 0 ||
      !Number.isSafeInteger(skill.channel_ticks) || skill.channel_ticks < 0
    ) {
      throw new Error(`SkillConfig ${skill.id} has invalid cast, cooldown, range, queue, or channel values`);
    }
    if (skill.target_relation !== 1 && skill.target_relation !== 2) {
      throw new Error(`SkillConfig ${skill.id} has unsupported target relation`);
    }
    if (skill.movement_policy !== 1 && skill.movement_policy !== 2) {
      throw new Error(`SkillConfig ${skill.id} has unsupported movement policy`);
    }
    if (!Number.isSafeInteger(skill.auto_attack_policy) || skill.auto_attack_policy < 1 || skill.auto_attack_policy > 4) {
      throw new Error(`SkillConfig ${skill.id} has unsupported auto-attack policy`);
    }
    if (
      (skill.delivery === 1 && skill.projectile_speed_meters_per_second !== 0) ||
      (skill.delivery === 2 && (!Number.isFinite(skill.projectile_speed_meters_per_second) || skill.projectile_speed_meters_per_second <= 0)) ||
      (skill.delivery !== 1 && skill.delivery !== 2)
    ) {
      throw new Error(`SkillConfig ${skill.id} has invalid delivery or projectile speed`);
    }
    if ((skill.channel_tick_ms === 0) !== (skill.channel_ticks === 0)) {
      throw new Error(`SkillConfig ${skill.id} must configure channel tick interval and count together`);
    }
    if (skill.channel_ticks > 0 && (skill.delivery !== 1 || skill.cast_time_ms < skill.channel_tick_ms * skill.channel_ticks)) {
      throw new Error(`SkillConfig ${skill.id} channel must be direct and fit inside cast time`);
    }
    if (skill.required_absent_buff_config_id > 0 && !buffIds.has(skill.required_absent_buff_config_id)) {
      throw new Error(`SkillConfig ${skill.id} references missing blocking BuffConfig`);
    }
    if ((effectCountBySkill.get(skill.id) ?? 0) === 0) {
      throw new Error(`SkillConfig ${skill.id} needs at least one effect`);
    }
  }
}

function validateRawAction(owner, type, parameters, buffIds, allowEmptyRemove) {
  if (!Number.isSafeInteger(type) || type < 0 || type > 7 || !Array.isArray(parameters)) {
    throw new Error(`${owner} has an unsupported Action`);
  }
  if (!parameters.every(Number.isSafeInteger)) {
    throw new Error(`${owner} has non-integer Action parameters`);
  }
  const expected = type === 0 ? 0
    : type === 1 ? 2
      : type === 2 ? 1
        : type === 3 ? (allowEmptyRemove ? undefined : 1)
          : type === 4 ? 2
            : type === 6 ? 1
              : type === 7 ? 2
                : undefined;
  if (expected !== undefined && parameters.length !== expected) {
    throw new Error(`${owner} expects ${expected} Action parameters`);
  }
  if (type === 3 && allowEmptyRemove && parameters.length > 1) {
    throw new Error(`${owner} RemoveBuff expects zero or one parameter`);
  }
  if (type === 5 && (parameters.length < 1 || parameters.length > 2)) {
    throw new Error(`${owner} RegisterDamageAbsorber expects one or two parameters`);
  }
  if (type === 1 && (parameters[0] <= 0 || (parameters[0] >= 1_000 && parameters[0] <= 9_999))) {
    throw new Error(`${owner} ChangeNumeric targets an invalid or derived NumericType`);
  }
  if (type === 2 && !buffIds.has(parameters[0])) {
    throw new Error(`${owner} AddBuff references missing BuffConfig ${parameters[0]}`);
  }
  if (type === 4 && (parameters[0] < 0 || parameters[1] < 1 || parameters[1] > 4)) {
    throw new Error(`${owner} DealDamage needs [non-negative amount, valid DamageSchool]`);
  }
  if (type === 5 && (parameters[0] <= 0 || (parameters[1] ?? 0) < 0)) {
    throw new Error(`${owner} RegisterDamageAbsorber needs positive amount and non-negative priority`);
  }
  if (type === 6 && parameters[0] < 0) {
    throw new Error(`${owner} Heal needs a non-negative amount`);
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
export type BuffConfig = game.BuffConfig;
export type MapConfig = game.MapConfig;
export type PlayerConfig = game.PlayerConfig;
export type AoiConfig = game.AoiConfig;
export type AoiSyncTierConfig = game.AoiSyncTierConfig;
export type MonsterConfig = game.MonsterConfig;
export type SkillConfig = game.SkillConfig;
export type QuestConfig = game.QuestConfig;
export type QuestObjectiveConfig = game.QuestObjectiveConfig;

export const GameConfigFingerprint = "${dataFingerprint}";
export const GameConfigs = Object.freeze({
  ItemConfig: new ConfigTable<game.ItemConfig>(tables.TbItemConfig.getDataList()),
  BuffConfig: new ConfigTable<game.BuffConfig>(tables.TbBuffConfig.getDataList()),
  MapConfig: new ConfigTable<game.MapConfig>(tables.TbMapConfig.getDataList()),
  PlayerConfig: new ConfigTable<game.PlayerConfig>(tables.TbPlayerConfig.getDataList()),
  AoiConfig: new ConfigTable<game.AoiConfig>(tables.TbAoiConfig.getDataList()),
  AoiSyncTierConfig: new ConfigTable<game.AoiSyncTierConfig>(tables.TbAoiSyncTierConfig.getDataList()),
  MonsterConfig: new ConfigTable<game.MonsterConfig>(tables.TbMonsterConfig.getDataList()),
  SkillConfig: new ConfigTable<game.SkillConfig>(tables.TbSkillConfig.getDataList()),
  QuestConfig: new ConfigTable<game.QuestConfig>(tables.TbQuestConfig.getDataList()),
  QuestObjectiveConfig: new ConfigTable<game.QuestObjectiveConfig>(tables.TbQuestObjectiveConfig.getDataList()),
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
