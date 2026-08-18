import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredPaths = [
  "configs/local/all-in-one.json",
  "configs/local/cluster/manager.json",
  "configs/local/cluster/login-1.json",
  "configs/local/cluster/gate-1.json",
  "configs/local/cluster/map-1.json",
  "configs/local/cluster/dungeon-1.json",
  "app/model/mmorpg/scenes/MapHostScene.ts",
  "app/model/mmorpg/login/CharacterRepository.ts",
  "app/hotfix/mmorpg/login/handlers/C2S_CreateCharacterHandler.ts",
  "app/model/mmorpg/map/MapComponent.ts",
  "app/model/mmorpg/monster/MonsterComponent.ts",
  "app/model/mmorpg/item/ItemComponent.ts",
  "app/model/mmorpg/quest/QuestComponent.ts",
  "app/model/mmorpg/persistence/PlayerRepository.ts",
  "app/hotfix/mmorpg/skill",
  "app/hotfix/mmorpg/quest",
  "app/hotfix/mmorpg/reward",
  "app/generated/model/native/NativeItemPersistence.ts",
  "docs/starter/acceptance-matrix.md",
  "tools/character_selection_smoke.mjs",
  "tools/dbproxy_outage_probe.ts",
  "tools/tiangz_fault_matrix_acceptance.mjs",
  "tools/starter_acceptance.mjs",
];

const missing = requiredPaths.filter((relativePath) => !existsSync(path.join(root, relativePath)));
if (missing.length > 0) {
  console.error("[starter] required Starter files are missing:");
  for (const relativePath of missing) console.error(`  - ${relativePath}`);
  process.exit(1);
}

const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const expectedScripts = [
  "starter:dev",
  "starter:verify",
  "starter:smoke",
  "starter:character-smoke",
  "starter:acceptance",
  "starter:acceptance:persistent",
  "starter:acceptance:faults",
  "test:tiangz-fault-matrix",
];
const missingScripts = expectedScripts.filter((name) => !packageJson.scripts?.[name]);
if (missingScripts.length > 0) {
  console.error(`[starter] missing package scripts: ${missingScripts.join(", ")}`);
  process.exit(1);
}

console.log(`[starter] static verification passed: ${requiredPaths.length} paths, ${expectedScripts.length} commands`);
console.log("[starter] next runtime gate: npm run starter:smoke");
