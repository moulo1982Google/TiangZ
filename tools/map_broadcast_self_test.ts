import assert from "node:assert/strict";
import {
  BroadcastHub,
  type BroadcastAudience,
  type BroadcastTransport,
} from "../app/core/broadcast";
import { readU16BE } from "../app/core/protocol/binary";
import { ClientBroadcasts } from "../app/generated/model/server/demo/protocol/broadcastDescriptors";
import {
  G2C_EntityLeaveCodec,
  G2C_EntityMoveCodec,
  G2C_EntityNumericCodec,
  type CellMovementState,
} from "../app/generated/model/server/demo/protocol/messages";
import { MsgCode } from "../app/generated/model/server/demo/protocol/msgcodes";

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

const audience: BroadcastAudience = {
  key: "map:1",
  routes: [
    { route: "Gate1", recipientId: 1001 },
    { route: "Gate2", recipientId: 1002 },
  ],
};

async function main(): Promise<void> {
  await testLatestSingleFlight();
  await testNumericLatestCoverage();
  await testEncodedLatestSnapshot();
  await testEventOrderingAndCapacity();
  console.log("broadcast framework self-test passed");
}

async function testNumericLatestCoverage(): Promise<void> {
  const transport = new ControlledTransport();
  const hub = new BroadcastHub(transport);

  const first = hub.Publish(
    audience,
    ClientBroadcasts.EntityNumeric,
    { unitId: 1, currentHp: 100, maxHp: 1000 },
    1,
  );
  const replaced = hub.Publish(
    audience,
    ClientBroadcasts.EntityNumeric,
    { unitId: 1, currentHp: 101, maxHp: 1000 },
    2,
  );
  const latest = hub.Publish(
    audience,
    ClientBroadcasts.EntityNumeric,
    { unitId: 1, currentHp: 102, maxHp: 1000 },
    3,
  );

  assert.equal(transport.sends.length, 1);
  transport.sends[0].resolve();
  await settlePromises();
  assert.equal(transport.sends.length, 2);
  const body = decodeNumeric(transport.sends[1].frame);
  assert.equal(body.serverTick, 3);
  assert.deepEqual(body.numerics, [
    { unitId: 1, currentHp: 102, maxHp: 1000 },
  ]);
  transport.sends[1].resolve();
  await Promise.all([first, replaced, latest]);
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
    fromCellY: 0,
    toCellX: sequence,
    toCellY: 0,
    moveStartTick: sequence,
    moveEndTick: sequence + 1,
    moving: true,
  };
}

async function settlePromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
