import { strict as assert } from "node:assert";
import { NumericType } from "../app/model/mmorpg/numeric/NumericType";
import {
  ExperienceRequiredForLevel,
  LevelFromExperience,
  STARTER_MAX_LEVEL,
} from "../app/hotfix/mmorpg/progression/ProgressionRules";
import {
  G2C_ProgressionChangedCodec,
  StarterDungeonCooldownSnapshotCodec,
} from "../app/generated/model/server/demo/protocol/messages";
import { STARTER_DUNGEON_COOLDOWN_MS } from "../app/model/mmorpg/dungeon/StarterDungeon";

assert.equal(NumericType.Level, 3);
assert.equal(NumericType.Experience, 4);
assert.equal(ExperienceRequiredForLevel(1n), 0n);
assert.equal(ExperienceRequiredForLevel(2n), 100n);
assert.equal(ExperienceRequiredForLevel(3n), 300n);
assert.equal(LevelFromExperience(0n), 1n);
assert.equal(LevelFromExperience(99n), 1n);
assert.equal(LevelFromExperience(100n), 2n);
assert.equal(LevelFromExperience(120n), 2n);
assert.equal(LevelFromExperience(300n), 3n);
assert.equal(LevelFromExperience(10_000_000n), STARTER_MAX_LEVEL);
assert.throws(() => LevelFromExperience(-1n), /non-negative/);

const receipt = {
  level: 2n,
  experience: 120n,
  gainedExperience: 120n,
  leveledUp: true,
};
assert.deepEqual(
  G2C_ProgressionChangedCodec.decode(G2C_ProgressionChangedCodec.encode(receipt)),
  receipt,
);
assert.equal(STARTER_DUNGEON_COOLDOWN_MS, 600_000);
const dungeonCooldown = {
  cooldownEndAtMs: 1_800_000_000_000n,
  operationId: "starter-dungeon:test",
};
assert.deepEqual(
  StarterDungeonCooldownSnapshotCodec.decode(StarterDungeonCooldownSnapshotCodec.encode(dungeonCooldown)),
  dungeonCooldown,
);

console.log("[progression] self-test passed");
