import assert from "node:assert/strict";
import { LocationDirectory } from "../app/core/public";
import { LocationComponent } from "../app/model/demo/location/LocationComponent";
import { MapInstanceDirectoryComponent } from "../app/model/demo/location/MapInstanceDirectoryComponent";
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

  assert.equal(directory.Register({ instance: staticMap }).created, true);
  assert.equal(directory.Register({ instance: staticMap }).created, false);
  assert.equal(directory.Register({ instance: dynamicMap }).created, true);
  assert.deepEqual(
    directory.Resolve({ mapInstanceId: dynamicMap.mapInstanceId }).instance,
    dynamicMap,
  );
  assert.throws(
    () => directory.Register({ instance: { ...dynamicMap, mapHostName: "map_1" } }),
    /conflicts/,
  );
  assert.throws(
    () => directory.Remove({ mapInstanceId: 1n, expectedMapHostName: "map_1" }),
    /static map instances cannot be removed/,
  );
  assert.equal(directory.Remove({
    mapInstanceId: dynamicMap.mapInstanceId,
    expectedMapHostName: "map_2",
  }).removed, true);
  assert.equal(directory.Resolve({ mapInstanceId: dynamicMap.mapInstanceId }).found, false);
}

function mapHostEndpoint(name: string, port: number) {
  return { name, innerIp: "127.0.0.1", port, protocol: "tcp", audience: "inner" };
}

/** 验证Location重启后可从MapHost权威快照恢复，并且冲突批次不会部分写入。 / Verifies restart recovery from authoritative MapHost snapshots and atomic rejection of conflicting batches. */
function testOwnerRecovery(): void {
  const location = new LocationComponent();
  const route = {
    unitId: 1001,
    account: "recovery-a",
    gateName: "gate_1",
    mapHostName: "map_1",
    mapId: 1,
    mapInstanceId: 1n,
    actorInstanceId: 11,
  };
  assert.deepEqual(location.RecoverOwner({
    ownerName: "map_1",
    locations: [route],
  }), {
    rpcId: undefined,
    error: 0,
    message: "",
    recovered: 1,
    unchanged: 0,
  });
  assert.equal(location.Resolve({ unitId: 1001, account: "" }).location.account, "recovery-a");
  assert.equal(location.RecoverOwner({ ownerName: "map_1", locations: [route] }).unchanged, 1);

  assert.throws(() => location.RecoverOwner({
    ownerName: "map_1",
    locations: [
      { ...route, unitId: 1002, account: "recovery-b", actorInstanceId: 12 },
      { ...route, actorInstanceId: 99 },
    ],
  }), /conflicts/);
  assert.equal(location.Resolve({ unitId: 1002, account: "" }).found, false);
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
