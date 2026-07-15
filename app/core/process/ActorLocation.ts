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
