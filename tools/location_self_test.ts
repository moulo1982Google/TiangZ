import assert from "node:assert/strict";
import { LocationDirectory } from "../app/core/public";
import { LocationComponent } from "../app/model/mmorpg/location/LocationComponent";
import { MapInstanceDirectoryComponent } from "../app/model/mmorpg/location/MapInstanceDirectoryComponent";
import { MapMessages } from "../app/generated/model/server/demo/protocol/messageDescriptors";
import { MapProtocol } from "../app/generated/model/server/demo/protocol/rpcs";

void main();

function main(): void {
  testLocationCasAndIdempotency();
  testOwnerRecovery();
  testGeneratedTransferPolicies();
  testMapInstanceDirectory();
  console.log("location self-test passed");
}

/** 验证静态/动态地图共享同一实例目录，并拒绝冲突覆盖和静态删除。 / Verifies one directory for static and dynamic maps with conflict and static-removal protection. */
function testMapInstanceDirectory(): void {
  const directory = new MapInstanceDirectoryComponent();
  const staticMap = {
    mapInstanceId: 1n,
    mapConfigId: 1,
    mapHostName: "map_1",
    dynamic: false,
    mapHost: mapHostEndpoint("map_1", 7301),
  };
  const dynamicMap = {
    mapInstanceId: 9_000_000_001n,
    mapConfigId: 1,
    mapHostName: "map_2",
    dynamic: true,
    mapHost: mapHostEndpoint("map_2", 7302),
  };

  assert.equal(directory.Register({
    instance: staticMap,
    ownerGeneration: 1n,
    leaseTimeoutMs: 0,
  }).created, true);
  assert.equal(directory.Register({
    instance: staticMap,
    ownerGeneration: 1n,
    leaseTimeoutMs: 0,
  }).created, false);
  assert.equal(directory.Register({
    instance: dynamicMap,
    ownerGeneration: 2n,
    leaseTimeoutMs: 1_000,
  }).created, true);
  assert.deepEqual(
    directory.Resolve({ mapInstanceId: dynamicMap.mapInstanceId }).instance,
    dynamicMap,
  );
  assert.throws(
    () => directory.Register({
      instance: { ...dynamicMap, mapHostName: "map_1" },
      ownerGeneration: 2n,
      leaseTimeoutMs: 1_000,
    }),
    /conflicts/,
  );
  assert.throws(
    () => directory.Remove({
      mapInstanceId: 1n,
      expectedMapHostName: "map_1",
      expectedOwnerGeneration: 1n,
    }),
    /static map instances cannot be removed/,
  );
  assert.throws(() => directory.Remove({
    mapInstanceId: dynamicMap.mapInstanceId,
    expectedMapHostName: "map_2",
    expectedOwnerGeneration: 1n,
  }), /conflicts/);
  assert.equal(directory.Remove({
    mapInstanceId: dynamicMap.mapInstanceId,
    expectedMapHostName: "map_2",
    expectedOwnerGeneration: 2n,
  }).removed, true);
  assert.equal(directory.Resolve({ mapInstanceId: dynamicMap.mapInstanceId }).found, false);

  assert.equal(directory.Register({
    instance: dynamicMap,
    ownerGeneration: 3n,
    leaseTimeoutMs: 1_000,
  }).created, true);
  assert.equal(directory.SweepExpired(Date.now() + 1_001), 1);
  assert.equal(directory.Resolve({ mapInstanceId: dynamicMap.mapInstanceId }).found, false);
  assert.equal(directory.Metrics().values.expired_dynamic_total, 1);
}

function mapHostEndpoint(name: string, port: number) {
  return { name, ip: "127.0.0.1", port, protocol: "tcp", audience: "inner" };
}

/** 验证Location重启后可从MapHost权威快照恢复，并且冲突批次不会部分写入。 / Verifies restart recovery from authoritative MapHost snapshots and atomic rejection of conflicting batches. */
function testOwnerRecovery(): void {
  const location = new LocationComponent();
  const route = {
    unitId: 1001,
    account: "recovery-a",
    characterId: 9001n,
    gateName: "gate_1",
    gateEpoch: 1n,
    mapHostName: "map_1",
    mapId: 1,
    mapInstanceId: 1n,
    actorInstanceId: 11,
  };
  assert.deepEqual(location.RecoverOwner({
    ownerName: "map_1",
    ownerGeneration: 101n,
    locations: [route],
  }), {
    rpcId: undefined,
    error: 0,
    message: "",
    recovered: 1,
    unchanged: 0,
    removedStale: 0,
    ownerReplaced: false,
  });
  assert.equal(location.Resolve({ unitId: 1001, account: "", characterId: 9001n }).location.account, "recovery-a");
  assert.equal(location.RecoverOwner({ ownerName: "map_1", ownerGeneration: 101n, locations: [route] }).unchanged, 1);

  const beforeRebind = location.Resolve({ unitId: 1001, account: "", characterId: 9001n }).location;
  const takeover = {
    unitId: route.unitId,
    characterId: route.characterId,
    expectedActorInstanceId: route.actorInstanceId,
    expectedRevision: beforeRebind.revision,
    expectedGateName: "gate_1",
    nextGateName: "gate_2",
    expectedGateEpoch: 1n,
    operationId: "gate-takeover-1",
    mapHostName: "map_1",
    ownerGeneration: 101n,
  };
  const rebound = location.RebindGate(takeover).location;
  assert.equal(rebound.gateName, "gate_2");
  assert.equal(rebound.gateEpoch, 2n);
  assert.equal(rebound.revision, beforeRebind.revision + 1n);
  assert.deepEqual(location.RebindGate(takeover).location, rebound);
  assert.throws(
    () => location.RebindGate({ ...takeover, operationId: "stale-takeover" }),
    /owner changed|revision mismatch/,
  );

  assert.throws(() => location.RecoverOwner({
    ownerName: "map_1",
    ownerGeneration: 101n,
    locations: [
      { ...route, unitId: 1002, account: "recovery-b", actorInstanceId: 12 },
      { ...route, actorInstanceId: 99 },
    ],
  }), /character 9001 already belongs to unit 1001/);
  assert.equal(location.Resolve({ unitId: 1002, account: "", characterId: 0n }).found, false);

  const replacement = { ...route, gateName: "gate_2", gateEpoch: 2n, actorInstanceId: 21 };
  assert.deepEqual(location.RecoverOwner({
    ownerName: "map_1",
    ownerGeneration: 102n,
    locations: [replacement],
  }), {
    rpcId: undefined,
    error: 0,
    message: "",
    recovered: 1,
    unchanged: 0,
    removedStale: 1,
    ownerReplaced: true,
  });
  assert.equal(location.Resolve({ unitId: 1001, account: "", characterId: 9001n }).location.actorInstanceId, 21);
  assert.throws(() => location.RecoverOwner({
    ownerName: "map_1",
    ownerGeneration: 101n,
    locations: [route],
  }), /stale location recovery generation/);
}

/** 验证旧revision、错误operation和重复Commit都不能破坏最新位置。 / Verifies stale revisions, foreign operations, and duplicate commits cannot corrupt the latest location. */
function testLocationCasAndIdempotency(): void {
  const locations = new LocationDirectory<number, string>();
  const created = locations.Register(1000, "map_1/actor_1");
  assert.equal(created.revision, 1n);
  assert.equal(created.state, "active");
  assert.throws(() => locations.Register(1000, "duplicate"), /already exists/);
  assert.throws(() => locations.Lock(1000, 2n, "move-1", "moving"), /revision mismatch/);

  const locked = locations.Lock(1000, 1n, "move-1", "moving");
  assert.equal(locked.state, "moving");
  assert.deepEqual(locations.Lock(1000, 1n, "move-1", "moving"), locked);
  assert.throws(() => locations.Lock(1000, 1n, "move-2", "moving"), /locked/);

  const committed = locations.Commit(1000, "move-1", "map_2/actor_2");
  assert.equal(committed.revision, 2n);
  assert.equal(committed.value, "map_2/actor_2");
  assert.deepEqual(
    locations.Commit(1000, "move-1", "ignored-idempotent-retry"),
    committed,
  );

  locations.Lock(1000, 2n, "offline-1", "removing");
  assert.throws(() => locations.Remove(1000, "offline-2"), /ownership mismatch/);
  assert.equal(locations.Remove(1000, "offline-1").value, "map_2/actor_2");
  assert.equal(locations.Resolve(1000), undefined);
}

/** 验证迁移策略来自Proto生成物，而不是Gate业务代码中的msgcode分支。 / Verifies transfer policies are generated from Proto instead of hard-coded msgcode branches in Gate. */
function testGeneratedTransferPolicies(): void {
  assert.equal(MapProtocol.UseItem.duringTransfer, "queue");
  assert.equal(MapProtocol.Probe.duringTransfer, "reject");
  assert.equal(MapMessages.Move.duringTransfer, "drop");
}
