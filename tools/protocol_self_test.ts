import assert from "node:assert/strict";
import { isPromiseLike } from "../app/core/async";
import { BinaryReader, BinaryWriter } from "../app/core/protocol/binary";
import { ProtocolRegistry } from "../app/core/protocol/registry";
import {
  decodeActorLocationEnvelope,
  encodeActorLocationEnvelope,
} from "../app/core/process/ActorLocation";
import {
  C2S_LoginCodec,
  M2G_MapReadyCodec,
  M2G_EnterMapCodec,
  S2G_ClientBroadcastCodec,
  MapEntitySnapshotCodec,
  S2C_LoginCodec,
} from "../app/generated/model/server/demo/protocol/messages";
import {
  GateMessages,
  MapMessages,
} from "../app/generated/model/server/demo/protocol/messageDescriptors";
import { LoginProtocol } from "../app/generated/model/server/demo/protocol/rpcs";

void main();

async function main(): Promise<void> {
  testGeneratedScalarCodec();
  testActorLocationEnvelope();
  await testRpcMetadataRoundTrip();
  await testOneWayMessageHasNoResponse();
  testMalformedLengthDelimitedField();
  console.log("protocol self-test passed");
}

async function testOneWayMessageHasNoResponse(): Promise<void> {
  const registry = new ProtocolRegistry();
  let receivedUnitId = 0;
  registry.registerMessage(GateMessages.MapReady.msgcode, {
    decode: M2G_MapReadyCodec.decode,
    handle: async (message) => {
      receivedUnitId = message.unitId;
    },
  });

  const payload = M2G_MapReadyCodec.encode({
    account: "tester",
    mapId: 1,
    unitId: 42,
    x: 10,
    y: -20,
  });
  const frame = new Uint8Array(2 + payload.length);
  frame[0] = GateMessages.MapReady.msgcode >>> 8;
  frame[1] = GateMessages.MapReady.msgcode & 0xff;
  frame.set(payload, 2);

  const result = registry.handle(frame);
  assert.equal(isPromiseLike(result), true);
  assert.equal(await result, undefined);
  assert.equal(receivedUnitId, 42);
}

function testGeneratedScalarCodec(): void {
  const encoded = MapEntitySnapshotCodec.encode({
    unitId: 42,
    x: -12345,
    y: 67890,
    heading: 1.25,
    alive: true,
    state: new Uint8Array([0, 1, 127, 128, 255]),
    account: "tester",
    cellX: -1,
    cellY: 2,
    numerics: [{ unitId: 42, numericType: 1, value: 100 }],
    speedCellsPerSecond: 10,
    facing: 2,
  });
  const decoded = MapEntitySnapshotCodec.decode(encoded);

  assert.equal(decoded.unitId, 42);
  assert.equal(decoded.x, -12345);
  assert.equal(decoded.y, 67890);
  assert.ok(Math.abs(decoded.heading - 1.25) < 0.0001);
  assert.equal(decoded.alive, true);
  assert.deepEqual([...decoded.state], [0, 1, 127, 128, 255]);
  assert.equal(decoded.account, "tester");
  assert.equal(decoded.facing, 2);

  const mapResponse = M2G_EnterMapCodec.decode(
    M2G_EnterMapCodec.encode({
      account: "tester",
      mapId: 1,
      unitId: 42,
      x: -12345,
      y: 67890,
      entities: [decoded, { ...decoded, unitId: 43, account: "peer" }],
      actorInstanceId: 99,
      fixedUpdateMs: 50,
      items: [],
    }),
  );
  assert.deepEqual(
    mapResponse.entities.map((entity) => [entity.unitId, entity.account]),
    [[42, "tester"], [43, "peer"]],
  );

  const broadcast = S2G_ClientBroadcastCodec.decode(
    S2G_ClientBroadcastCodec.encode({
      targetUnitIds: [1001, 1002],
      frame: new Uint8Array([0x27, 0x19, 1, 2, 3]),
    }),
  );
  assert.deepEqual(broadcast.targetUnitIds, [1001, 1002]);
  assert.deepEqual([...broadcast.frame], [0x27, 0x19, 1, 2, 3]);

  const writer = new BinaryWriter();
  writer.int32(1, -2147483648);
  writer.double(2, Math.PI);
  const reader = new BinaryReader(writer.finish());
  assert.deepEqual(reader.tag(), { fieldNo: 1, wireType: 0 });
  assert.equal(reader.int32(), -2147483648);
  assert.deepEqual(reader.tag(), { fieldNo: 2, wireType: 1 });
  assert.equal(reader.double(), Math.PI);
  assert.equal(reader.eof(), true);
}

function testActorLocationEnvelope(): void {
  assert.equal(MapMessages.Move.routing, "actor-location");
  const movePayload = MapMessages.Move.codec.encode({
    inputX: 1,
    inputY: -1,
    sequence: 7,
  });
  const moveFrame = new Uint8Array(2 + movePayload.length);
  moveFrame[0] = MapMessages.Move.msgcode >>> 8;
  moveFrame[1] = MapMessages.Move.msgcode & 0xff;
  moveFrame.set(movePayload, 2);

  const envelope = decodeActorLocationEnvelope(
    encodeActorLocationEnvelope({ instanceId: 1001, frame: moveFrame }),
  );
  assert.equal(envelope.instanceId, 1001);
  assert.deepEqual(envelope.frame, moveFrame);
}

async function testRpcMetadataRoundTrip(): Promise<void> {
  const registry = new ProtocolRegistry();
  registry.register(LoginProtocol.Login.requestCode, {
    responseCode: LoginProtocol.Login.responseCode,
    decode: C2S_LoginCodec.decode,
    encode: S2C_LoginCodec.encode,
    handle: (request) => ({
      account: request.account,
      service: "self-test",
      loginCount: 1,
      token: "token",
      gateName: "gate",
      gateIp: "127.0.0.1",
      gatePort: 7201,
    }),
  });

  const requestPayload = C2S_LoginCodec.encode({
    account: "tester",
    rpcId: 77,
  });
  const request = new Uint8Array(2 + requestPayload.length);
  request[0] = LoginProtocol.Login.requestCode >>> 8;
  request[1] = LoginProtocol.Login.requestCode & 0xff;
  request.set(requestPayload, 2);

  const responseResult = registry.handle(request);
  assert.equal(isPromiseLike(responseResult), false);
  const responseFrame = await responseResult;
  assert.ok(responseFrame);
  const response = S2C_LoginCodec.decode(responseFrame.subarray(2));
  assert.equal(response.rpcId, 77);
  assert.equal(response.error ?? 0, 0);
  assert.equal(response.account, "tester");

  registry.register(LoginProtocol.Login.requestCode, {
    responseCode: LoginProtocol.Login.responseCode,
    decode: C2S_LoginCodec.decode,
    encode: S2C_LoginCodec.encode,
    handle: async (asyncRequest) => ({
      account: asyncRequest.account,
      service: "async-self-test",
      loginCount: 2,
      token: "async-token",
      gateName: "gate",
      gateIp: "127.0.0.1",
      gatePort: 7201,
    }),
  });

  const asyncResponseResult = registry.handle(request);
  assert.equal(isPromiseLike(asyncResponseResult), true);
  const asyncResponseFrame = await asyncResponseResult;
  assert.ok(asyncResponseFrame);
  const asyncResponse = S2C_LoginCodec.decode(asyncResponseFrame.subarray(2));
  assert.equal(asyncResponse.rpcId, 77);
  assert.equal(asyncResponse.service, "async-self-test");
}

function testMalformedLengthDelimitedField(): void {
  const malformed = new BinaryReader(new Uint8Array([0x0a, 0x05, 0x01]));
  assert.deepEqual(malformed.tag(), { fieldNo: 1, wireType: 2 });
  assert.throws(() => malformed.bytesField(), /unexpected eof/);
}
