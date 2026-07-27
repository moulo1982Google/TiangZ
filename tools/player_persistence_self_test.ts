import assert from "node:assert/strict";
import type { Entity } from "../app/core/runtime/entities";
import { PlayerPersistenceComponent } from "../app/model/demo/persistence/PlayerPersistenceComponent";
import { InMemoryPlayerRepository } from "../app/model/demo/persistence/PlayerRepository";
import type {
  PlayerRepository,
  PlayerSaveData,
} from "../app/model/demo/persistence/PlayerRepository";

void main();

async function main(): Promise<void> {
  await testSuccessfulSaveIsIdempotent();
  await testSaveFailureIsVisibleAndIdempotent();
  console.log("player persistence self-test passed");
}

async function testSuccessfulSaveIsIdempotent(): Promise<void> {
  const repository = new InMemoryPlayerRepository();
  const component = new PlayerPersistenceComponent();
  component.__attach(createPlayer() as unknown as Entity);
  component.__awake(repository);

  const first = component.SaveOnOffline("disconnect");
  const second = component.SaveOnOffline("duplicate-disconnect");
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(repository.SaveCount("persistence-test"), 1);
  assert.equal(repository.Get("persistence-test")?.reason, "disconnect");
}

async function testSaveFailureIsVisibleAndIdempotent(): Promise<void> {
  const repository = new FailingPlayerRepository();
  const component = new PlayerPersistenceComponent();
  component.__attach(createPlayer() as unknown as Entity);
  component.__awake(repository);

  const first = component.SaveOnOffline("shutdown");
  const second = component.SaveOnOffline("duplicate-shutdown");
  assert.equal(first, second);
  await assert.rejects(first, /injected repository failure/);
  await assert.rejects(second, /injected repository failure/);
  assert.equal(repository.saveCount, 1);
}

function createPlayer(): object {
  return {
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
}

class FailingPlayerRepository implements PlayerRepository {
  saveCount = 0;

  Save(_data: PlayerSaveData): Promise<void> {
    this.saveCount += 1;
    return Promise.reject(new Error("injected repository failure"));
  }
}
