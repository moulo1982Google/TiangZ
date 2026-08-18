import { strict as assert } from "node:assert";
import { NumericType } from "../app/model/mmorpg/numeric/NumericType";
import {
  ExperienceRequiredForLevel,
  LevelFromExperience,
  STARTER_MAX_LEVEL,
} from "../app/hotfix/mmorpg/progression/ProgressionRules";
import { G2C_ProgressionChangedCodec } from "../app/generated/model/server/demo/protocol/messages";

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

console.log("[progression] self-test passed");
