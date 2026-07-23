import { concatBytes, readU16BE, writeU16BE } from "./Binary";

export function packFrame(msgcode: number, payload: Uint8Array): Uint8Array {
  return concatBytes(writeU16BE(msgcode), payload);
}

export function readFrameMsgCode(frame: Uint8Array): number {
  if (frame.length < 2) {
    throw new Error("消息帧长度不足，无法读取 msgcode");
  }
  return readU16BE(frame, 0);
}
