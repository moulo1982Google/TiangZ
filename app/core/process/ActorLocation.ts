import { BinaryReader, readU16BE } from "../protocol/binary";
import type { SceneConfig } from "./types";

export const ActorLocationEnvelopeMsgCode = 29_999;
export const ActorLocationEnvelopeHeaderBytes = 14;
export const ActorLocationBatchEnvelopeMsgCode = 29_997;
const ActorLocationBatchEnvelopeHeaderBytes = 6;
const ActorLocationBatchEntryHeaderBytes = 12;
const MaxActorLocationBatchEntries = 4096;
const MaxActorLocationBatchBytes = 1024 * 1024;

export interface ActorLocationTarget {
  instanceId: number;
  scene: SceneConfig;
}

export interface ActorLocationEnvelope {
  instanceId: number;
  frame: Uint8Array;
  rpcId?: number;
}

export interface ActorLocationBatchEntry {
  readonly instanceId: number;
  readonly frame: Uint8Array;
}

export class ActorLocationDirectory {
  private readonly targetsByConnection = new Map<number, ActorLocationTarget>();

  /** 将客户端连接绑定到权威 Actor，并拒绝无提示地改绑。 / Binds a client connection to its authoritative Actor and rejects silent reassignment. */
  bindConnection(connectionId: number, target: ActorLocationTarget): void {
    if (!Number.isSafeInteger(target.instanceId) || target.instanceId <= 0) {
      throw new Error(`invalid actor instance id: ${target.instanceId}`);
    }
    const previous = this.targetsByConnection.get(connectionId);
    if (previous && !sameTarget(previous, target)) {
      throw new Error(
        `connection ${connectionId} is already bound to actor ${previous.instanceId}; unbind before rebind`,
      );
    }
    this.targetsByConnection.set(connectionId, target);
  }

  /** 连接断开时移除路由，但不销毁目标 Actor。 / Removes routing on disconnect; it does not dispose the target Actor. */
  unbindConnection(connectionId: number): void {
    this.targetsByConnection.delete(connectionId);
  }

  /** 仅查询当前本地路由，不发起网络或目录服务调用。 / Resolves current routing without network or directory calls. */
  resolveConnection(connectionId: number): ActorLocationTarget | undefined {
    return this.targetsByConnection.get(connectionId);
  }
}

function sameTarget(left: ActorLocationTarget, right: ActorLocationTarget): boolean {
  return left.instanceId === right.instanceId &&
    left.scene.name === right.scene.name &&
    left.scene.sceneType === right.scene.sceneType &&
    left.scene.innerIp === right.scene.innerIp &&
    left.scene.port === right.scene.port;
}

/** 使用固定 Actor InstanceId 路由元数据包装内部帧。 / Wraps an inner frame with fixed Actor InstanceId routing metadata. */
export function encodeActorLocationEnvelope(
  envelope: ActorLocationEnvelope,
): Uint8Array {
  if (!Number.isSafeInteger(envelope.instanceId) || envelope.instanceId <= 0) {
    throw new Error(`invalid actor instanceId: ${envelope.instanceId}`);
  }
  if (envelope.frame.length < 2) throw new Error("actor inner frame is too short");
  const rpcId = envelope.rpcId ?? 0;
  if (!Number.isSafeInteger(rpcId) || rpcId < 0 || rpcId > 0xffff_ffff) {
    throw new Error(`invalid actor rpcId: ${rpcId}`);
  }

  const result = new Uint8Array(ActorLocationEnvelopeHeaderBytes + envelope.frame.length);
  const view = new DataView(result.buffer);
  view.setUint16(0, ActorLocationEnvelopeMsgCode, false);
  view.setBigUint64(2, BigInt(envelope.instanceId), true);
  view.setUint32(10, rpcId, true);
  result.set(envelope.frame, ActorLocationEnvelopeHeaderBytes);
  return result;
}

/** 在进入 mailbox 路由前校验并拆出 ActorLocation 信封。 / Validates and unwraps an ActorLocation envelope before mailbox routing. */
export function decodeActorLocationEnvelope(frame: Uint8Array): ActorLocationEnvelope {
  const instanceId = readActorLocationInstanceId(frame);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const rpcId = view.getUint32(10, true);
  return {
    instanceId,
    frame: frame.subarray(ActorLocationEnvelopeHeaderBytes),
    rpcId: rpcId === 0 ? undefined : rpcId,
  };
}

/** 只读取 InstanceId 以执行快速路由，不复制内嵌帧。 / Reads only InstanceId for fast routing without copying the embedded frame. */
export function readActorLocationInstanceId(frame: Uint8Array): number {
  if (
    frame.length < ActorLocationEnvelopeHeaderBytes + 2 ||
    readU16BE(frame, 0) !== ActorLocationEnvelopeMsgCode
  ) {
    throw new Error("invalid actor location envelope header");
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const rawInstanceId = view.getBigUint64(2, true);
  if (rawInstanceId === 0n || rawInstanceId > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`invalid actor instanceId: ${rawInstanceId}`);
  }
  return Number(rawInstanceId);
}

/** 把同一目标Scene的一组可覆盖Actor消息编码成单个内部帧；每个内帧在目标端仍进入原Actor mailbox。 / Encodes replaceable Actor messages for one target Scene into one inner frame; every nested frame still enters its original Actor mailbox on the target. */
export function encodeActorLocationBatchEnvelope(
  entries: readonly ActorLocationBatchEntry[],
): Uint8Array {
  if (entries.length === 0 || entries.length > MaxActorLocationBatchEntries) {
    throw new Error(`invalid actor location batch entry count: ${entries.length}`);
  }
  let byteLength = ActorLocationBatchEnvelopeHeaderBytes;
  for (const entry of entries) {
    requireActorLocationBatchEntry(entry);
    byteLength += ActorLocationBatchEntryHeaderBytes + entry.frame.byteLength;
    if (byteLength > MaxActorLocationBatchBytes) {
      throw new Error(`actor location batch exceeds ${MaxActorLocationBatchBytes} bytes`);
    }
  }

  const result = new Uint8Array(byteLength);
  const view = new DataView(result.buffer);
  view.setUint16(0, ActorLocationBatchEnvelopeMsgCode, false);
  view.setUint32(2, entries.length, true);
  let offset = ActorLocationBatchEnvelopeHeaderBytes;
  for (const entry of entries) {
    view.setBigUint64(offset, BigInt(entry.instanceId), true);
    view.setUint32(offset + 8, entry.frame.byteLength, true);
    offset += ActorLocationBatchEntryHeaderBytes;
    result.set(entry.frame, offset);
    offset += entry.frame.byteLength;
  }
  return result;
}

/** 零复制遍历批量Actor信封；回调得到的frame只在当前宿主帧生命周期内有效。 / Iterates an Actor batch without copying; callback frame views are valid only for the current host frame lifetime. */
export function forEachActorLocationBatchEntry(
  batch: Uint8Array,
  visit: (entry: ActorLocationBatchEntry) => void,
): void {
  if (
    batch.byteLength < ActorLocationBatchEnvelopeHeaderBytes ||
    readU16BE(batch, 0) !== ActorLocationBatchEnvelopeMsgCode
  ) {
    throw new Error("invalid actor location batch envelope header");
  }
  if (batch.byteLength > MaxActorLocationBatchBytes) {
    throw new Error(`actor location batch exceeds ${MaxActorLocationBatchBytes} bytes`);
  }
  const view = new DataView(batch.buffer, batch.byteOffset, batch.byteLength);
  const count = view.getUint32(2, true);
  if (count === 0 || count > MaxActorLocationBatchEntries) {
    throw new Error(`invalid actor location batch entry count: ${count}`);
  }
  let offset = ActorLocationBatchEnvelopeHeaderBytes;
  for (let index = 0; index < count; index += 1) {
    if (offset + ActorLocationBatchEntryHeaderBytes > batch.byteLength) {
      throw new Error(`actor location batch entry ${index} header is truncated`);
    }
    const rawInstanceId = view.getBigUint64(offset, true);
    const frameLength = view.getUint32(offset + 8, true);
    offset += ActorLocationBatchEntryHeaderBytes;
    if (rawInstanceId === 0n || rawInstanceId > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`invalid actor location batch instanceId: ${rawInstanceId}`);
    }
    if (frameLength < 2 || offset + frameLength > batch.byteLength) {
      throw new Error(`actor location batch entry ${index} frame is truncated`);
    }
    visit({
      instanceId: Number(rawInstanceId),
      frame: batch.subarray(offset, offset + frameLength),
    });
    offset += frameLength;
  }
  if (offset !== batch.byteLength) throw new Error("actor location batch has trailing bytes");
}

function requireActorLocationBatchEntry(entry: ActorLocationBatchEntry): void {
  if (!Number.isSafeInteger(entry.instanceId) || entry.instanceId <= 0) {
    throw new Error(`invalid actor location batch instanceId: ${entry.instanceId}`);
  }
  if (entry.frame.byteLength < 2) throw new Error("actor location batch frame is too short");
}

/** 不解码业务请求，仅扫描 protobuf payload 的 90 号字段。 / Scans protobuf payload field 90 without decoding the business request. */
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

/** 替换 payload 中的 rpcId，同时保持不透明业务字段不变，供 Gate 转发。 / Replaces payload rpcId while preserving opaque business fields for Gate forwarding. */
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
