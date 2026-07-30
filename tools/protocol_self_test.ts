import assert from "node:assert/strict";
import { isPromiseLike } from "../app/core/async";
import { BinaryReader, BinaryWriter } from "../app/core/protocol/binary";
import { ProtocolRegistry } from "../app/core/protocol/registry";
import type { ProtocolContext, ProtocolOutcome } from "../app/core/protocol/registry";
import { RpcError } from "../app/core/protocol/RpcError";
import { Logger } from "../app/core/logging/Logger";
import {
  decodeActorLocationEnvelope,
  encodeActorLocationEnvelope,
} from "../app/core/process/ActorLocation";
import {
  C2S_LoginCodec,
  G2M_EnterMapCodec,
  M2G_MapReadyCodec,
  M2G_EnterMapCodec,
  S2G_ClientBroadcastCodec,
  MapEntitySnapshotCodec,
  S2C_LoginCodec,
} from "../app/generated/model/server/demo/protocol/messages";
import { Integer64FixtureCodec } from "../app/generated/model/server/bench/protocol/messages";
import {
  GateMessages,
  MapMessages,
} from "../app/generated/model/server/demo/protocol/messageDescriptors";
import {
  LoginProtocol,
  MapProtocol,
} from "../app/generated/model/server/demo/protocol/rpcs";

void main();

async function main(): Promise<void> {
  testGeneratedScalarCodec();
  testGeneratedInteger64Codec();
  testActorLocationEnvelope();
  await testRpcMetadataRoundTrip();
  await testHandlerFailureIsolation();
  await testIllegalFrameIsolation();
  await testMissingHandlerErrorSemantics();
  await testOneWayMessageHasNoResponse();
  testMalformedLengthDelimitedField();
  console.log("protocol self-test passed");
}

function testGeneratedInteger64Codec(): void {
  const value = {
    unsignedValue: 18_446_744_073_709_551_615n,
    signedValue: -9_223_372_036_854_775_808n,
    unsignedValues: [0n, 9_007_199_254_740_993n, 18_446_744_073_709_551_615n],
    signedValues: [-9_223_372_036_854_775_808n, -1n, 9_223_372_036_854_775_807n],
  };
  assert.deepEqual(Integer64FixtureCodec.decode(Integer64FixtureCodec.encode(value)), value);

  const writer = new BinaryWriter();
  assert.throws(() => writer.uint64(1, -1n), /uint64 value/);
  assert.throws(() => writer.int64(1, 1n << 63n), /int64 value/);
  const overflow = new BinaryReader(
    new Uint8Array([0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02]),
  );
  assert.deepEqual(overflow.tag(), { fieldNo: 1, wireType: 0 });
  assert.throws(() => overflow.uint64(), /overflow/);
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
    z: 30,
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

async function testMissingHandlerErrorSemantics(): Promise<void> {
  const outcomes: ProtocolOutcome[] = [];
  const registry = new ProtocolRegistry(undefined, undefined, (outcome) => {
    outcomes.push(outcome);
  });
  registry.registerKnownRpc(LoginProtocol.Login);
  registry.registerKnownMessage(GateMessages.MapReady);

  const requestPayload = C2S_LoginCodec.encode({ account: "missing", rpcId: 88 });
  const request = new Uint8Array(2 + requestPayload.length);
  request[0] = LoginProtocol.Login.requestCode >>> 8;
  request[1] = LoginProtocol.Login.requestCode & 0xff;
  request.set(requestPayload, 2);
  const rpcFrame = await registry.handle(request);
  assert.ok(rpcFrame);
  const rpcError = S2C_LoginCodec.decode(rpcFrame.subarray(2));
  assert.equal(rpcError.rpcId, 88);
  assert.equal(rpcError.error, 1003);
  assert.equal(outcomes.at(-1)?.kind, "handler-not-found");

  registry.registerKnownRpc(MapProtocol.EnterMap);
  const mapRequestPayload = G2M_EnterMapCodec.encode({
    account: "missing",
    token: "token",
    gateName: "gate_1",
    mapId: 1,
    rpcId: 89,
  });
  const mapErrorFrame = await registry.handle(
    frame(MapProtocol.EnterMap.requestCode, mapRequestPayload),
  );
  assert.ok(mapErrorFrame);
  const mapError = M2G_EnterMapCodec.decode(mapErrorFrame.subarray(2));
  assert.equal(mapError.rpcId, 89);
  assert.equal(mapError.error, 1003);
  assert.deepEqual(mapError.entities, []);
  assert.deepEqual(mapError.items, []);

  const messagePayload = M2G_MapReadyCodec.encode({
    account: "missing",
    mapId: 1,
    unitId: 1,
    x: 0,
    y: 0,
    z: 0,
  });
  const message = new Uint8Array(2 + messagePayload.length);
  message[0] = GateMessages.MapReady.msgcode >>> 8;
  message[1] = GateMessages.MapReady.msgcode & 0xff;
  message.set(messagePayload, 2);
  assert.equal(await registry.handle(message), undefined);
  assert.equal(outcomes.at(-1)?.kind, "handler-not-found");
}

function testGeneratedScalarCodec(): void {
  const encoded = MapEntitySnapshotCodec.encode({
    unitId: 42,
    x: -12345,
    y: 67890,
    z: 23456,
    yaw: 1.25,
    alive: true,
    state: new Uint8Array([0, 1, 127, 128, 255]),
    account: "tester",
    cellX: -1,
    cellZ: 2,
    numerics: [{ unitId: 42, numericType: 1, value: 100 }],
    speedCellsPerSecond: 10,
    facing: 2,
  });
  const decoded = MapEntitySnapshotCodec.decode(encoded);

  assert.equal(decoded.unitId, 42);
  assert.equal(decoded.x, -12345);
  assert.equal(decoded.y, 67890);
  assert.equal(decoded.z, 23456);
  assert.ok(Math.abs(decoded.yaw - 1.25) < 0.0001);
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
      z: 23456,
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
    inputZ: -1,
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
  assert.throws(
    () => decodeActorLocationEnvelope(Uint8Array.of(0, 1)),
    /invalid actor location envelope header/,
  );
}

async function testHandlerFailureIsolation(): Promise<void> {
  const outcomes: ProtocolOutcome[] = [];
  const registry = new ProtocolRegistry(undefined, undefined, (outcome) => {
    outcomes.push(outcome);
  });
  const requestPayload = C2S_LoginCodec.encode({ account: "fault", rpcId: 91 });
  const request = frame(LoginProtocol.Login.requestCode, requestPayload);

  registry.register(LoginProtocol.Login.requestCode, {
    responseCode: LoginProtocol.Login.responseCode,
    decode: C2S_LoginCodec.decode,
    encode: S2C_LoginCodec.encode,
    handle: async () => {
      throw new Error("injected async handler failure");
    },
  });
  const failedFrame = await registry.handle(request);
  assert.ok(failedFrame);
  const failed = S2C_LoginCodec.decode(failedFrame.subarray(2));
  assert.equal(failed.rpcId, 91);
  assert.equal(failed.error, 1005);
  assert.match(failed.message ?? "", /injected async handler failure/);
  assert.equal(outcomes.at(-1)?.kind, "system-error");

  registry.register(LoginProtocol.Login.requestCode, {
    responseCode: LoginProtocol.Login.responseCode,
    decode: C2S_LoginCodec.decode,
    encode: S2C_LoginCodec.encode,
    handle: (value) => ({
      account: value.account,
      service: "recovered",
      loginCount: 1,
      token: "token",
      gateName: "gate",
      gateIp: "127.0.0.1",
      gatePort: 7201,
    }),
  });
  const recoveredFrame = await registry.handle(request);
  assert.ok(recoveredFrame);
  assert.equal(S2C_LoginCodec.decode(recoveredFrame.subarray(2)).service, "recovered");

  registry.registerMessage(GateMessages.MapReady.msgcode, {
    decode: M2G_MapReadyCodec.decode,
    handle: () => {
      throw new Error("injected message handler failure");
    },
  });
  const messagePayload = M2G_MapReadyCodec.encode({
    account: "fault",
    mapId: 1,
    unitId: 1,
    x: 0,
    y: 0,
    z: 0,
  });
  assert.equal(
    await registry.handle(frame(GateMessages.MapReady.msgcode, messagePayload)),
    undefined,
  );
  assert.equal(outcomes.at(-1)?.kind, "message-handler-failed");
}

async function testIllegalFrameIsolation(): Promise<void> {
  const outcomes: ProtocolOutcome[] = [];
  const registry = new ProtocolRegistry(undefined, undefined, (outcome) => {
    outcomes.push(outcome);
  });
  registry.registerKnownRpc(LoginProtocol.Login);

  assert.equal(await registry.handle(Uint8Array.of(1)), undefined);
  assert.equal(outcomes.at(-1)?.kind, "system-error");
  assert.equal(outcomes.at(-1)?.code, 1001);

  const malformed = frame(
    LoginProtocol.Login.requestCode,
    Uint8Array.of(0x0a, 0x05, 0x01),
  );
  const responseFrame = await registry.handle(malformed);
  assert.ok(responseFrame);
  const response = S2C_LoginCodec.decode(responseFrame.subarray(2));
  assert.equal(response.error, 1004);
  assert.equal(outcomes.at(-1)?.kind, "decode-error");

  const validPayload = C2S_LoginCodec.encode({ account: "after-malformed", rpcId: 92 });
  registry.register(LoginProtocol.Login.requestCode, {
    responseCode: LoginProtocol.Login.responseCode,
    decode: C2S_LoginCodec.decode,
    encode: S2C_LoginCodec.encode,
    handle: (value) => ({
      account: value.account,
      service: "still-alive",
      loginCount: 1,
      token: "token",
      gateName: "gate",
      gateIp: "127.0.0.1",
      gatePort: 7201,
    }),
  });
  const validFrame = await registry.handle(
    frame(LoginProtocol.Login.requestCode, validPayload),
  );
  assert.ok(validFrame);
  assert.equal(S2C_LoginCodec.decode(validFrame.subarray(2)).service, "still-alive");
}

async function testRpcMetadataRoundTrip(): Promise<void> {
  const outcomes: ProtocolOutcome[] = [];
  const requestLogs: string[] = [];
  (globalThis as typeof globalThis & { __hostLogMinLevel: number }).__hostLogMinLevel = 0;
  (globalThis as typeof globalThis & {
    __hostLog: (
      level: number,
      target: string,
      category: string,
      message: string,
      attributes: string,
    ) => void;
  }).__hostLog = (_level, _target, _category, message, attributes) => {
    if (message === "request context probe") requestLogs.push(attributes);
  };
  let receivedContext: ProtocolContext | undefined;
  const registry = new ProtocolRegistry(undefined, undefined, (outcome) => {
    outcomes.push(outcome);
  });
  registry.register(LoginProtocol.Login.requestCode, {
    responseCode: LoginProtocol.Login.responseCode,
    decode: C2S_LoginCodec.decode,
    encode: S2C_LoginCodec.encode,
    handle: (request, context) => {
      receivedContext = context;
      context.logger?.info("request context probe");
      return {
        account: request.account,
        service: "self-test",
        loginCount: 1,
        token: "token",
        gateName: "gate",
        gateIp: "127.0.0.1",
        gatePort: 7201,
      };
    },
  });

  const requestPayload = C2S_LoginCodec.encode({
    account: "tester",
    rpcId: 77,
  });
  const request = new Uint8Array(2 + requestPayload.length);
  request[0] = LoginProtocol.Login.requestCode >>> 8;
  request[1] = LoginProtocol.Login.requestCode & 0xff;
  request.set(requestPayload, 2);

  const responseResult = registry.handle(request, {
    connectionId: 9,
    logger: new Logger("protocol-self-test"),
  });
  assert.equal(isPromiseLike(responseResult), false);
  const responseFrame = await responseResult;
  assert.ok(responseFrame);
  const response = S2C_LoginCodec.decode(responseFrame.subarray(2));
  assert.equal(response.rpcId, 77);
  assert.equal(response.error ?? 0, 0);
  assert.equal(response.account, "tester");
  assert.equal(receivedContext?.connectionId, 9);
  assert.equal(receivedContext?.msgcode, LoginProtocol.Login.requestCode);
  assert.equal(receivedContext?.rpcId, 77);
  assert.ok(receivedContext?.requestId);
  const requestLog = JSON.parse(requestLogs[0]) as Record<string, unknown>;
  assert.equal(requestLog.connectionId, 9);
  assert.equal(requestLog.msgcode, LoginProtocol.Login.requestCode);
  assert.equal(requestLog.rpcId, 77);
  assert.equal(requestLog.requestId, receivedContext?.requestId);
  assert.equal(outcomes.at(-1)?.kind, "success");

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

  registry.register(LoginProtocol.Login.requestCode, {
    responseCode: LoginProtocol.Login.responseCode,
    decode: C2S_LoginCodec.decode,
    encode: S2C_LoginCodec.encode,
    handle: () => {
      throw new RpcError(10001, "business rejected");
    },
  });
  const rejectedFrame = await registry.handle(request);
  assert.ok(rejectedFrame);
  const rejected = S2C_LoginCodec.decode(rejectedFrame.subarray(2));
  assert.equal(rejected.error, 10001);
  assert.equal(rejected.rpcId, 77);
  assert.equal(outcomes.at(-1)?.kind, "business-error");
}

function testMalformedLengthDelimitedField(): void {
  const malformed = new BinaryReader(new Uint8Array([0x0a, 0x05, 0x01]));
  assert.deepEqual(malformed.tag(), { fieldNo: 1, wireType: 2 });
  assert.throws(() => malformed.bytesField(), /unexpected eof/);
}

function frame(msgcode: number, payload: Uint8Array): Uint8Array {
  const result = new Uint8Array(2 + payload.length);
  result[0] = msgcode >>> 8;
  result[1] = msgcode & 0xff;
  result.set(payload, 2);
  return result;
}
