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
  "app/model/demo/scenes/MapHostScene.ts",
  "app/model/demo/login/CharacterRepository.ts",
  "app/hotfix/demo/login/handlers/C2S_CreateCharacterHandler.ts",
  "app/model/demo/map/MapComponent.ts",
  "app/model/demo/monster/MonsterComponent.ts",
  "app/model/demo/item/ItemComponent.ts",
  "app/model/demo/quest/QuestComponent.ts",
  "app/model/demo/persistence/PlayerRepository.ts",
  "app/hotfix/demo/skill",
  "app/hotfix/demo/quest",
  "app/hotfix/demo/reward",
  "app/generated/model/native/NativeItemPersistence.ts",
  "docs/starter/acceptance-matrix.md",
  "tools/character_selection_smoke.mjs",
];

const missing = requiredPaths.filter((relativePath) => !existsSync(path.join(root, relativePath)));
if (missing.length > 0) {
  console.error("[starter] required Starter files are missing:");
  for (const relativePath of missing) console.error(`  - ${relativePath}`);
  process.exit(1);
}

const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const expectedScripts = ["starter:dev", "starter:verify", "starter:smoke", "starter:character-smoke"];
const missingScripts = expectedScripts.filter((name) => !packageJson.scripts?.[name]);
if (missingScripts.length > 0) {
  console.error(`[starter] missing package scripts: ${missingScripts.join(", ")}`);
  process.exit(1);
}

console.log(`[starter] static verification passed: ${requiredPaths.length} paths, ${expectedScripts.length} commands`);
console.log("[starter] next runtime gate: npm run starter:smoke");
