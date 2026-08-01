import assert from "node:assert/strict";
import {
  BroadcastHub,
  ClientAudience,
  ClientBroadcast,
  type BroadcastAudience,
  type BroadcastTransport,
  type EncodedAudienceBatch,
} from "../app/core/broadcast";
import { readU16BE } from "../app/core/protocol/binary";
import { ClientBroadcasts } from "../app/generated/model/server/demo/protocol/broadcastDescriptors";
import {
  G2C_BuffAddedCodec,
  G2C_BuffDetailCodec,
  G2C_EntityLeaveCodec,
  G2C_EntityMoveCodec,
  G2C_EntityNumericCodec,
  type CellMovementState,
} from "../app/generated/model/server/demo/protocol/messages";
import { MsgCode } from "../app/generated/model/server/demo/protocol/msgcodes";
import { StateReplicationSystem } from "../app/core/replication";
import { SceneBroadcastTransport } from "../app/model/demo/broadcast/SceneBroadcastTransport";
import type { SceneMessageHelper } from "../app/core/process/SceneMessageHelper";
import { MapClientRouteResolver } from "../app/model/demo/broadcast/MapClientRouteResolver";
import type { LocationProxy } from "../app/model/demo/location/LocationProxy";

interface ControlledSend {
  readonly audience: BroadcastAudience;
  readonly frame: Uint8Array;
  resolve(): void;
  reject(error: Error): void;
}

class ControlledTransport implements BroadcastTransport {
  readonly sends: ControlledSend[] = [];

  Send(audience: BroadcastAudience, frame: Uint8Array): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.sends.push({ audience, frame, resolve, reject });
    });
  }
}

interface ControlledBatchSend {
  readonly batches: readonly EncodedAudienceBatch[];
  resolve(): void;
  reject(error: Error): void;
}

class ControlledBatchTransport extends ControlledTransport {
  readonly batchSends: ControlledBatchSend[] = [];

  SendMany(batches: readonly EncodedAudienceBatch[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.batchSends.push({ batches, resolve, reject });
    });
  }
}

const audience: BroadcastAudience = {
  key: "map:1",
  routes: [
    { route: "Gate1", recipientId: 1001 },
    { route: "Gate2", recipientId: 1002 },
  ],
};

async function main(): Promise<void> {
  await testLogicalAudienceSetOperations();
  await testClientBroadcastHidesPhysicalRoutes();
  await testBuffAudienceProjectionDoesNotLeakDetails();
  await testMapRouteResolverUsesLocalAndCachedRemoteRoutes();
  await testLatestSingleFlight();
  await testNumericLatestCoverage();
  await testEncodedLatestSnapshot();
  await testEncodedAoiBatchesSingleFlight();
  await testEncodedAoiBatchesUseTransportBatch();
  await testSceneTransportCoalescesJobsByGate();
  await testReplicationAckOnlyAfterSuccessfulSend();
  await testBatchedReplicationAckAfterEveryAudience();
  await testEventOrderingAndCapacity();
  console.log("broadcast framework self-test passed");
}

async function testBuffAudienceProjectionDoesNotLeakDetails(): Promise<void> {
  const transport = new ControlledTransport();
  const hub = new BroadcastHub(transport);
  const broadcast = new ClientBroadcast(hub, {
    Resolve: (unitIds) => unitIds.map((recipientId) => ({
      route: recipientId <= 3 ? "GateA" : "GateB",
      recipientId,
    })),
  });
  const nearby = ClientAudience.ForUnits("map:1:observers:10", [1, 2, 3]);
  const party = ClientAudience.ForUnits("party:7", [1, 4]);
  const publicAudience = ClientAudience.Union(nearby, party);
  const detailAudience = ClientAudience.Union(ClientAudience.Self(1), party);
  const added = broadcast.Publish(publicAudience, ClientBroadcasts.BuffAdded, {
    buff: {
      unitId: 1,
      buffInstanceId: 9001n,
      buffConfigId: 100,
      stacks: 1,
      expireTimeMs: 30_000n,
      revision: 1,
    },
  });
  const detail = broadcast.Publish(detailAudience, ClientBroadcasts.BuffDetail, {
    unitId: 1,
    buffInstanceId: 9001n,
    absorbRemaining: 500,
    revision: 1,
  }, 20);

  assert.equal(transport.sends.length, 2);
  const publicSend = transport.sends.find((send) => readU16BE(send.frame, 0) === MsgCode.G2C_BuffAdded)!;
  const detailSend = transport.sends.find((send) => readU16BE(send.frame, 0) === MsgCode.G2C_BuffDetail)!;
  assert.deepEqual(publicSend.audience.routes.map((route) => route.recipientId), [1, 2, 3, 4]);
  assert.deepEqual(detailSend.audience.routes.map((route) => route.recipientId), [1, 4]);
  assert.equal(G2C_BuffAddedCodec.decode(publicSend.frame.subarray(2)).buff.buffConfigId, 100);
  assert.equal(G2C_BuffDetailCodec.decode(detailSend.frame.subarray(2)).buffs[0]?.absorbRemaining, 500);
  for (const send of transport.sends) send.resolve();
  await Promise.all([added, detail]);
}

async function testLogicalAudienceSetOperations(): Promise<void> {
  const aoi = ClientAudience.ForUnits("aoi:1001", [1003, 1001, 1002, 1002]);
  const party = ClientAudience.ForUnits("party:7", [1002, 1004]);
  assert.deepEqual(aoi.UnitIds, [1001, 1002, 1003]);
  assert.deepEqual(ClientAudience.Union(aoi, party).UnitIds, [1001, 1002, 1003, 1004]);
  assert.deepEqual(ClientAudience.Intersect(aoi, party).UnitIds, [1002]);
  assert.deepEqual(ClientAudience.Except(aoi, party).UnitIds, [1001, 1003]);
  assert.deepEqual(ClientAudience.Union(ClientAudience.Self(1001), aoi).UnitIds, [1001, 1002, 1003]);
}

async function testClientBroadcastHidesPhysicalRoutes(): Promise<void> {
  const transport = new ControlledTransport();
  const hub = new BroadcastHub(transport);
  const resolvedIds: number[][] = [];
  const broadcast = new ClientBroadcast(hub, {
    Resolve: (unitIds) => {
      resolvedIds.push([...unitIds]);
      return unitIds.map((recipientId) => ({
        route: recipientId % 2 === 0 ? "Gate2" : "Gate1",
        recipientId,
      }));
    },
  });
  const logical = ClientAudience.ForUnits("buff-public:77", [1002, 1001, 1002]);
  const delivery = broadcast.Publish(
    logical,
    ClientBroadcasts.EntityLeave,
    { unitId: 77 },
  );
  assert.deepEqual(resolvedIds, [[1001, 1002]]);
  assert.deepEqual(transport.sends[0].audience, {
    key: "buff-public:77",
    routes: [
      { route: "Gate1", recipientId: 1001 },
      { route: "Gate2", recipientId: 1002 },
    ],
  });
  transport.sends[0].resolve();
  await delivery;
}

async function testMapRouteResolverUsesLocalAndCachedRemoteRoutes(): Promise<void> {
  let locationCalls = 0;
  const location = {
    ResolveMany: async ({ unitIds }: { unitIds: readonly number[] }) => {
      locationCalls += 1;
      return {
        locations: unitIds.map((unitId) => ({
          unitId,
          gateName: "GateRemote",
          state: "active",
        })),
      };
    },
  } as unknown as LocationProxy;
  const resolver = new MapClientRouteResolver(
    (unitId) => unitId === 1001 ? "GateLocal" : undefined,
    location,
  );

  const first = await resolver.Resolve([1001, 2001]);
  assert.deepEqual(first, [
    { route: "GateLocal", recipientId: 1001 },
    { route: "GateRemote", recipientId: 2001 },
  ]);
  const second = resolver.Resolve([1001, 2001]);
  assert.ok(!("then" in (second as object)), "cached routes should keep the local synchronous path");
  assert.deepEqual(second, first);
  assert.equal(locationCalls, 1, "remote routes must be batch-resolved once and then cached");
}

async function testSceneTransportCoalescesJobsByGate(): Promise<void> {
  const sends: Array<{ target: string; message: { batches: readonly unknown[] } }> = [];
  const scenes = {
    byName: (name: string) => ({ name }),
    send: (target: { name: string }, _descriptor: unknown, message: { batches: readonly unknown[] }) => {
      sends.push({ target: target.name, message });
      return Promise.resolve();
    },
  } as unknown as SceneMessageHelper;
  const transport = new SceneBroadcastTransport(scenes);
  const first = transport.SendMany([
    {
      audience: { key: "move:a", routes: [{ route: "Gate1", recipientId: 1001 }] },
      frame: Uint8Array.from([0x27, 0x20, 1]),
      itemCount: 1,
    },
  ]);
  const second = transport.SendMany([
    {
      audience: {
        key: "numeric:a",
        routes: [
          { route: "Gate1", recipientId: 1001 },
          { route: "Gate2", recipientId: 1002 },
        ],
      },
      frame: Uint8Array.from([0x27, 0x21, 2]),
      itemCount: 1,
    },
  ]);

  assert.equal(sends.length, 0, "same-tick jobs must wait for the transport flush boundary");
  await Promise.all([first, second]);
  assert.equal(sends.length, 2, "each Gate must receive at most one inner batch per flush");
  assert.deepEqual(
    sends.map((send) => [send.target, send.message.batches.length]),
    [["Gate1", 2], ["Gate2", 1]],
  );
}

async function testEncodedAoiBatchesUseTransportBatch(): Promise<void> {
  const transport = new ControlledBatchTransport();
  const hub = new BroadcastHub(transport);
  const delivery = hub.PublishEncodedLatestBatches("map:1:aoi", "Client.EntityMove", [
    {
      audience: { key: "aoi:a", routes: [{ route: "Gate1", recipientId: 1001 }] },
      frame: Uint8Array.from([0x27, 0x20, 1]),
      itemCount: 2,
    },
    {
      audience: { key: "aoi:b", routes: [{ route: "Gate2", recipientId: 1002 }] },
      frame: Uint8Array.from([0x27, 0x20, 2]),
      itemCount: 1,
    },
  ]);
  assert.equal(transport.sends.length, 0, "batch-capable transports must not receive per-audience sends");
  assert.equal(transport.batchSends.length, 1, "one AOI job must become one transport batch");
  assert.equal(transport.batchSends[0].batches.length, 2);
  transport.batchSends[0].resolve();
  await delivery;
  assert.equal(hub.Snapshot().sentItems, 3);
}

async function testEncodedAoiBatchesSingleFlight(): Promise<void> {
  const transport = new ControlledTransport();
  const hub = new BroadcastHub(transport);
  const first = hub.PublishEncodedLatestBatches("map:1:aoi", "Client.EntityMove", [
    {
      audience: { key: "aoi:a", routes: [{ route: "Gate1", recipientId: 1001 }] },
      frame: Uint8Array.from([0x27, 0x20, 1]),
      itemCount: 2,
    },
    {
      audience: { key: "aoi:b", routes: [{ route: "Gate2", recipientId: 1002 }] },
      frame: Uint8Array.from([0x27, 0x20, 2]),
      itemCount: 1,
    },
  ]);
  assert.equal(transport.sends.length, 2, "one AOI job may fan out multiple encoded groups");
  transport.sends[0].resolve();
  await settlePromises();
  assert.equal(hub.Snapshot().inFlight, 1, "the AOI job remains in flight until every group completes");
  transport.sends[1].resolve();
  await first;
  assert.equal(hub.Snapshot().sentItems, 3);
}

async function testBatchedReplicationAckAfterEveryAudience(): Promise<void> {
  const transport = new ControlledTransport();
  const hub = new BroadcastHub(transport);
  let acknowledged = 0;
  const replication = new StateReplicationSystem(hub, () => audience);
  replication.Add({
    name: "Client.AoiState",
    Peek: () => ({
      itemCount: 2,
      audienceKey: "map:1:aoi",
      batches: [
        {
          audience: { key: "aoi:a", routes: [{ route: "Gate1", recipientId: 1001 }] },
          frame: Uint8Array.from([0x27, 0x22, 1]),
          itemCount: 1,
        },
        {
          audience: { key: "aoi:b", routes: [{ route: "Gate2", recipientId: 1002 }] },
          frame: Uint8Array.from([0x27, 0x22, 2]),
          itemCount: 1,
        },
      ],
      Ack: () => { acknowledged += 1; },
    }),
  });

  replication.FrameFlush();
  await settlePromises();
  assert.equal(transport.sends.length, 2);
  transport.sends[0].resolve();
  await settlePromises();
  assert.equal(acknowledged, 0, "partial AOI delivery must not acknowledge dirty state");
  transport.sends[1].resolve();
  await settlePromises();
  assert.equal(acknowledged, 1);
}

async function testReplicationAckOnlyAfterSuccessfulSend(): Promise<void> {
  const transport = new ControlledTransport();
  const errors: unknown[] = [];
  const hub = new BroadcastHub(transport, { onError: () => undefined });
  let acknowledged = 0;
  let peeked = 0;
  const replication = new StateReplicationSystem(
    hub,
    () => audience,
    (_name, error) => errors.push(error),
  );
  replication.Add({
    name: "Client.TestState",
    Peek: () => {
      peeked += 1;
      return {
        itemCount: 1,
        frame: Uint8Array.from([0x27, 0x22, acknowledged + 1]),
        Ack: () => { acknowledged += 1; },
      };
    },
  });

  replication.FrameFlush();
  replication.FrameFlush();
  assert.equal(peeked, 1, "an in-flight source must not be peeked twice");
  assert.equal(transport.sends.length, 1, "an in-flight revision must not be sent twice");
  transport.sends[0].reject(new Error("expected replication failure"));
  await settlePromises();
  assert.equal(acknowledged, 0, "failed state delivery must not acknowledge dirty data");
  assert.equal(errors.length, 1);

  replication.FrameFlush();
  assert.equal(peeked, 2, "failed delivery must make the dirty source retryable");
  transport.sends[1].resolve();
  await settlePromises();
  assert.equal(acknowledged, 1);
}

async function testNumericLatestCoverage(): Promise<void> {
  const transport = new ControlledTransport();
  const hub = new BroadcastHub(transport);

  const first = hub.Publish(
    audience,
    ClientBroadcasts.EntityNumeric,
    { unitId: 1, numericType: 1, value: 100n },
    1,
  );
  const replaced = hub.Publish(
    audience,
    ClientBroadcasts.EntityNumeric,
    { unitId: 1, numericType: 1, value: 101n },
    2,
  );
  const latest = hub.Publish(
    audience,
    ClientBroadcasts.EntityNumeric,
    { unitId: 1, numericType: 1, value: 102n },
    3,
  );
  const maxHp = hub.Publish(
    audience,
    ClientBroadcasts.EntityNumeric,
    { unitId: 1, numericType: 1_000, value: 1000n },
    3,
  );

  assert.equal(transport.sends.length, 1);
  transport.sends[0].resolve();
  await settlePromises();
  assert.equal(transport.sends.length, 2);
  const body = decodeNumeric(transport.sends[1].frame);
  assert.equal(body.serverTick, 3);
  assert.deepEqual(body.numerics, [
    { unitId: 1, numericType: 1, value: 102n },
    { unitId: 1, numericType: 1_000, value: 1000n },
  ]);
  transport.sends[1].resolve();
  await Promise.all([first, replaced, latest, maxHp]);
  assert.equal(hub.Snapshot().coalescedItems, 1);
}

async function testEncodedLatestSnapshot(): Promise<void> {
  const transport = new ControlledTransport();
  const hub = new BroadcastHub(transport);
  const firstFrame = Uint8Array.from([0x27, 0x20, 1]);
  const replacedFrame = Uint8Array.from([0x27, 0x20, 2]);
  const latestFrame = Uint8Array.from([0x27, 0x20, 3]);

  const first = hub.PublishEncodedLatestSnapshot(
    audience,
    "Client.EntityMove",
    firstFrame,
    2,
  );
  const replaced = hub.PublishEncodedLatestSnapshot(
    audience,
    "Client.EntityMove",
    replacedFrame,
    3,
  );
  const latest = hub.PublishEncodedLatestSnapshot(
    audience,
    "Client.EntityMove",
    latestFrame,
    4,
  );
  assert.equal(transport.sends.length, 1);
  assert.equal(hub.Snapshot().pendingItems, 4);

  transport.sends[0].resolve();
  await settlePromises();
  assert.equal(transport.sends.length, 2);
  assert.equal(transport.sends[1].frame, latestFrame);
  transport.sends[1].resolve();
  await Promise.all([first, replaced, latest]);

  const metrics = hub.Snapshot();
  assert.equal(metrics.queuedItems, 9);
  assert.equal(metrics.coalescedItems, 3);
  assert.equal(metrics.sentItems, 6);
  assert.equal(metrics.broadcastsStarted, 2);
  assert.equal(metrics.broadcastsCompleted, 2);
}

async function testLatestSingleFlight(): Promise<void> {
  const transport = new ControlledTransport();
  const errors: unknown[] = [];
  const hub = new BroadcastHub(transport, {
    onError: (_name, error) => errors.push(error),
  });

  const first = hub.Publish(audience, ClientBroadcasts.EntityMove, movement(1, 1), 1);
  assert.equal(transport.sends.length, 1);
  assert.equal(hub.Snapshot().inFlight, 1);

  const second = hub.PublishMany(
    audience,
    ClientBroadcasts.EntityMove,
    [movement(1, 2), movement(2, 1)],
    2,
  );
  const third = hub.Publish(audience, ClientBroadcasts.EntityMove, movement(1, 3), 3);
  assert.equal(transport.sends.length, 1, "latest broadcast must be single-flight");
  assert.equal(hub.Snapshot().pendingItems, 2);

  transport.sends[0].resolve();
  await settlePromises();
  assert.equal(transport.sends.length, 2);
  const next = decodeMovement(transport.sends[1].frame);
  assert.equal(next.serverTick, 3);
  assert.deepEqual(
    next.movements.map((item) => [item.unitId, item.acknowledgedSequence]),
    [[1, 3], [2, 1]],
    "latest broadcast must keep only the newest state for each key",
  );

  const fourth = hub.Publish(audience, ClientBroadcasts.EntityMove, movement(3, 1), 4);
  transport.sends[1].reject(new Error("expected broadcast failure"));
  await assert.rejects(second);
  await assert.rejects(third);
  await settlePromises();
  assert.equal(transport.sends.length, 3, "a failed send must not stop the channel");
  assert.equal(errors.length, 1);

  transport.sends[2].resolve();
  await Promise.all([first, fourth]);
  const metrics = hub.Snapshot();
  assert.equal(metrics.inFlight, 0);
  assert.equal(metrics.pendingItems, 0);
  assert.equal(metrics.queuedItems, 5);
  assert.equal(metrics.coalescedItems, 1);
  assert.equal(metrics.sentItems, 4);
  assert.equal(metrics.broadcastsStarted, 3);
  assert.equal(metrics.broadcastsCompleted, 2);
  assert.equal(metrics.broadcastFailures, 1);
  assert.equal(metrics.maxPendingItems, 2);
  assert.equal(metrics.maxInFlightItems, 2);
}

async function testEventOrderingAndCapacity(): Promise<void> {
  const transport = new ControlledTransport();
  const hub = new BroadcastHub(transport, { maxEventQueuePerChannel: 1 });
  assert.throws(
    () => hub.PublishMany(
      audience,
      ClientBroadcasts.EntityLeave,
      [{ unitId: 8 }, { unitId: 9 }],
    ),
    /single-event broadcast/,
  );
  const first = hub.Publish(audience, ClientBroadcasts.EntityLeave, { unitId: 10 });
  const second = hub.Publish(audience, ClientBroadcasts.EntityLeave, { unitId: 11 });
  assert.throws(
    () => hub.Publish(audience, ClientBroadcasts.EntityLeave, { unitId: 12 }),
    /event queue is full/,
    "event overflow must be visible instead of silently dropping an event",
  );

  assert.equal(transport.sends.length, 1);
  assert.equal(decodeLeave(transport.sends[0].frame).unitId, 10);
  transport.sends[0].resolve();
  await first;
  await settlePromises();
  assert.equal(transport.sends.length, 2);
  assert.equal(decodeLeave(transport.sends[1].frame).unitId, 11);
  transport.sends[1].resolve();
  await second;
}

function decodeMovement(frame: Uint8Array) {
  assert.equal(readU16BE(frame, 0), MsgCode.G2C_EntityMove);
  return G2C_EntityMoveCodec.decode(frame.subarray(2));
}

function decodeLeave(frame: Uint8Array) {
  assert.equal(readU16BE(frame, 0), MsgCode.G2C_EntityLeave);
  return G2C_EntityLeaveCodec.decode(frame.subarray(2));
}

function decodeNumeric(frame: Uint8Array) {
  assert.equal(readU16BE(frame, 0), MsgCode.G2C_EntityNumeric);
  return G2C_EntityNumericCodec.decode(frame.subarray(2));
}

function movement(unitId: number, sequence: number): CellMovementState {
  return {
    unitId,
    acknowledgedSequence: sequence,
    fromCellX: sequence - 1,
    fromCellZ: 0,
    toCellX: sequence,
    toCellZ: 0,
    moveStartTick: sequence,
    moveEndTick: sequence + 1,
    moving: true,
    facing: 2,
  };
}

async function settlePromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
