import { expect, test } from "vitest";
import { evaluateBusinessRecovery, recoveryBaseline } from "../../tools/chaos/business_recovery.mjs";

const baseline = recoveryBaseline(["map-1", "map-100"].map(shard => ({
  type: "shard_finished", shard, epoch: 1, accountGeneration: 9,
})));
function rounds() {
  return [2, 3].flatMap(epoch => [
    { type: "epoch_started", epoch, at: new Date(1000 + epoch).toISOString() },
    ...["map-1", "map-100"].map(shard => ({ type: "shard_finished", epoch, shard,
      accountGeneration: 9, at: new Date(2000 + epoch).toISOString(), healthy: true, completed: true })),
  ]);
}
test("healthy infrastructure without same-player business evidence cannot pass", () => {
  expect(evaluateBusinessRecovery([], baseline, 1000).passed).toBe(false);
});
test("two fresh rounds for both unchanged player groups pass", () => {
  expect(evaluateBusinessRecovery(rounds(), baseline, 1000).passed).toBe(true);
});
test("missing Actor in one map fails even when every health endpoint is ready", () => {
  const events = rounds();
  Object.assign(events.at(-1)!, { healthy: false, completed: false });
  expect(evaluateBusinessRecovery(events, baseline, 1000).passed).toBe(false);
});
test("replacing stuck accounts or reusing pre-recovery setup is not recovery", () => {
  const events = rounds();
  Object.assign(events.at(-1)!, { accountGeneration: 10 });
  expect(evaluateBusinessRecovery(events, baseline, 1000).passed).toBe(false);
  expect(evaluateBusinessRecovery(rounds(), baseline, 1500).passed).toBe(false);
});
test("duplicate completed records cannot manufacture a second passing round", () => {
  const events = rounds().filter(e => e.epoch === 2);
  expect(evaluateBusinessRecovery([...events, ...events], baseline, 1000).passed).toBe(false);
});
