import { BinaryReader, BinaryWriter } from "../protocol/binary";
import { packFrame } from "../protocol/registry";
import type { SceneConfig } from "./types";

export const ActorLocationEnvelopeMsgCode = 29_999;

export interface ActorLocationTarget {
  instanceId: number;
  scene: SceneConfig;
}

export interface ActorLocationEnvelope {
  instanceId: number;
  frame: Uint8Array;
  rpcId?: number;
}

export class ActorLocationDirectory {
  private readonly targetsByConnection = new Map<number, ActorLocationTarget>();

  bindConnection(connectionId: number, target: ActorLocationTarget): void {
    if (!Number.isSafeInteger(target.instanceId) || target.instanceId <= 0) {
      throw new Error(`invalid actor instance id: ${target.instanceId}`);
    }
    this.targetsByConnection.set(connectionId, target);
  }

  unbindConnection(connectionId: number): void {
    this.targetsByConnection.delete(connectionId);
  }

  resolveConnection(connectionId: number): ActorLocationTarget | undefined {
    return this.targetsByConnection.get(connectionId);
  }
}

export function encodeActorLocationEnvelope(
  envelope: ActorLocationEnvelope,
): Uint8Array {
  const writer = new BinaryWriter(envelope.frame.length + 32);
  writer.uint32(1, envelope.instanceId);
  writer.bytes(2, envelope.frame);
  writer.uint32(90, envelope.rpcId);
  return packFrame(ActorLocationEnvelopeMsgCode, writer.finish());
}

export function decodeActorLocationEnvelope(frame: Uint8Array): ActorLocationEnvelope {
  const reader = new BinaryReader(frame.subarray(2));
  let instanceId = 0;
  let innerFrame: Uint8Array = new Uint8Array(0);
  let rpcId: number | undefined;
  while (!reader.eof()) {
    const tag = reader.tag();
    if (tag.fieldNo === 1 && tag.wireType === 0) instanceId = reader.uint32();
    else if (tag.fieldNo === 2 && tag.wireType === 2) innerFrame = reader.bytesField();
    else if (tag.fieldNo === 90 && tag.wireType === 0) rpcId = reader.uint32();
    else reader.skip(tag.wireType);
  }
  if (instanceId <= 0) throw new Error("actor location envelope has no instanceId");
  if (innerFrame.length < 2) throw new Error("actor location envelope has no inner frame");
  return { instanceId, frame: innerFrame, rpcId };
}

export function extractFrameRpcId(frame: Uint8Array): number | undefined {
  try {
    const reader = new BinaryReader(frame.subarray(2));
    while (!reader.eof()) {
      const tag = reader.tag();
      if (tag.fieldNo === 90 && tag.wireType === 0) return reader.uint32();
      reader.skip(tag.wireType);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function rewriteFrameRpcId(frame: Uint8Array, rpcId: number): Uint8Array {
  if (frame.length < 2 || !Number.isSafeInteger(rpcId) || rpcId <= 0 || rpcId > 0xffff_ffff) {
    throw new Error(`invalid RPC frame or rpcId: ${rpcId}`);
  }

  let offset = 2;
  while (offset < frame.length) {
    const tag = readVarint(frame, offset);
    offset = tag.end;
    const fieldNo = tag.value >>> 3;
    const wireType = tag.value & 0x7;
    if (fieldNo === 90 && wireType === 0) {
      const current = readVarint(frame, offset);
      const encoded = encodeVarint(rpcId);
      const rewritten = new Uint8Array(
        frame.length - (current.end - offset) + encoded.length,
      );
      rewritten.set(frame.subarray(0, offset));
      rewritten.set(encoded, offset);
      rewritten.set(frame.subarray(current.end), offset + encoded.length);
      return rewritten;
    }
    offset = skipField(frame, offset, wireType);
  }
  throw new Error("RPC frame has no rpcId field");
}

function readVarint(bytes: Uint8Array, start: number): { value: number; end: number } {
  let value = 0;
  let shift = 0;
  for (let offset = start; offset < bytes.length && offset < start + 10; offset += 1) {
    const byte = bytes[offset];
    if (shift < 32) value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, end: offset + 1 };
    shift += 7;
  }
  throw new Error("invalid protobuf varint");
}

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let current = value >>> 0;
  while (current >= 0x80) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current);
  return Uint8Array.from(bytes);
}

function skipField(bytes: Uint8Array, offset: number, wireType: number): number {
  if (wireType === 0) return readVarint(bytes, offset).end;
  if (wireType === 1) return checkedEnd(bytes, offset, 8);
  if (wireType === 2) {
    const length = readVarint(bytes, offset);
    return checkedEnd(bytes, length.end, length.value);
  }
  if (wireType === 5) return checkedEnd(bytes, offset, 4);
  throw new Error(`unsupported protobuf wire type: ${wireType}`);
}

function checkedEnd(bytes: Uint8Array, offset: number, length: number): number {
  const end = offset + length;
  if (!Number.isSafeInteger(end) || end > bytes.length) {
    throw new Error("unexpected eof while scanning protobuf field");
  }
  return end;
}
