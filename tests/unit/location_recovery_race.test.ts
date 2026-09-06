import { describe, expect, test } from "vitest";
import { LocationComponent } from "../../app/model/mmorpg/location/LocationComponent";

const route = { unitId: 1001, account: "race-player", characterId: 9001n,
  gateName: "gate_1", gateEpoch: 1n, mapHostName: "map_1", mapId: 1,
  mapInstanceId: 1n, actorInstanceId: 11 };
const recovery = { ownerName: "map_1", ownerGeneration: 101n, locations: [route] };
const resolve = { unitId: 1001, account: "", characterId: 9001n };

function remove(location: LocationComponent) {
  const current = location.Resolve(resolve).location;
  location.Lock({ unitId: 1001, expectedRevision: current.revision,
    expectedActorInstanceId: current.actorInstanceId, operationId: "offline", state: "removing" });
  location.Remove({ unitId: 1001, operationId: "offline" });
}

describe("Location recovery versus acknowledged offline", () => {
  test.each(["before-delete", "after-delete", "repeated-after-delete"])(
    "a captured recovery snapshot cannot resurrect an offline Actor: %s", (order) => {
      const location = new LocationComponent();
      location.RecoverOwner(recovery);
      const captured = structuredClone(recovery);
      if (order === "before-delete") location.RecoverOwner(captured);
      remove(location);
      if (order !== "before-delete") location.RecoverOwner(captured);
      if (order === "repeated-after-delete") location.RecoverOwner(captured);
      expect(location.Resolve(resolve).found).toBe(false);
    });

  test("Location restart still restores every live Actor on the first owner report", () => {
    const restarted = new LocationComponent();
    expect(restarted.RecoverOwner(recovery).recovered).toBe(1);
    expect(restarted.Resolve(resolve).location.actorInstanceId).toBe(11);
    expect(restarted.RecoverOwner(recovery).unchanged).toBe(1);
  });

  test("a normal explicit entry can register a new Actor after offline", () => {
    const location = new LocationComponent();
    location.RecoverOwner(recovery);
    remove(location);
    const next = { ...route, actorInstanceId: 12, ownerGeneration: 101n };
    expect(location.Register(next).created).toBe(true);
    expect(() => location.RecoverOwner(recovery)).toThrow(/conflicts/);
    expect(location.Resolve(resolve).location.actorInstanceId).toBe(12);
  });

  test("failed persistence unlocks the same Actor; recovery cannot reset removing state", () => {
    const location = new LocationComponent();
    location.RecoverOwner(recovery);
    location.Lock({ unitId: 1001, expectedRevision: 1n, expectedActorInstanceId: 11,
      operationId: "save-failed", state: "removing" });
    location.RecoverOwner(recovery);
    expect(location.Resolve(resolve).location.state).toBe("removing");
    location.Unlock({ unitId: 1001, operationId: "save-failed" });
    expect(location.Resolve(resolve).location.state).toBe("active");
    remove(location);
    location.RecoverOwner(recovery);
    expect(location.Resolve(resolve).found).toBe(false);
  });

  test("a new owner generation fences all old recovery reports", () => {
    const location = new LocationComponent();
    location.RecoverOwner(recovery);
    location.RecoverOwner({ ...recovery, ownerGeneration: 102n,
      locations: [{ ...route, actorInstanceId: 22 }] });
    expect(() => location.RecoverOwner(recovery)).toThrow(/stale/);
    expect(location.Resolve(resolve).location.actorInstanceId).toBe(22);
  });

  test.each(["unit", "character"])("duplicate %s identities reject the whole first report", (kind) => {
    const location = new LocationComponent();
    const duplicate = kind === "unit" ? { ...route, characterId: 9002n }
      : { ...route, unitId: 1002 };
    expect(() => location.RecoverOwner({ ...recovery, locations: [route, duplicate] }))
      .toThrow(/duplicate recovery/);
    expect(location.Resolve(resolve).found).toBe(false);
    expect(location.RecoverOwner(recovery).recovered).toBe(1);
  });
});
