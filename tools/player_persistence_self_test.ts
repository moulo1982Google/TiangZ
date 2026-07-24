import assert from "node:assert/strict";
import type { Entity } from "../app/core/runtime";
import { PlayerPersistenceComponent } from "../app/demo/persistence/PlayerPersistenceComponent";
import { InMemoryPlayerRepository } from "../app/demo/persistence/PlayerRepository";

void main();

async function main(): Promise<void> {
  const repository = new InMemoryPlayerRepository();
  const component = new PlayerPersistenceComponent();
  const player = {
    Account: "persistence-test",
    UnitId: 1001,
    logger: { info: () => undefined },
    Snapshot: () => ({
      account: "persistence-test",
      mapId: 1,
      unitId: 1001,
      gateName: "gate_1",
      gateSessionId: "session-1",
      x: 0,
      y: 0,
      cellX: 0,
      cellY: 0,
      speedCellsPerSecond: 10,
      facing: 0,
      alive: true,
      numerics: [],
    }),
    GetComponent: () => ({ Snapshot: () => [] }),
  };
  component.__attach(player as unknown as Entity);
  component.__awake(repository);

  const first = component.SaveOnOffline("disconnect");
  const second = component.SaveOnOffline("duplicate-disconnect");
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(repository.SaveCount("persistence-test"), 1);
  assert.equal(repository.Get("persistence-test")?.reason, "disconnect");
  console.log("player persistence self-test passed");
}
