import { concatBytes, readU32BE, writeU16BE } from "./binary";

/** Prefixes one `[msgcode][payload]` frame with its 32-bit network length. */
export function encodeFrameWithLength(frame: Uint8Array): Uint8Array {
  const packet = new Uint8Array(4 + frame.length);
  const len = frame.length >>> 0;
  packet[0] = (len >>> 24) & 0xff;
  packet[1] = (len >>> 16) & 0xff;
  packet[2] = (len >>> 8) & 0xff;
  packet[3] = len & 0xff;
  packet.set(frame, 4);
  return packet;
}

/** Builds a complete packet; rpcId remains inside protobuf payload by design. */
export function encodePacket(msgcode: number, payload: Uint8Array): Uint8Array {
  const frame = concatBytes(writeU16BE(msgcode), payload);
  return encodeFrameWithLength(frame);
}

export class LengthPrefixedFrameDecoder {
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();

  /** Accepts arbitrary stream chunks and emits complete frames while retaining a partial tail. */
  push(chunk: Uint8Array): Uint8Array[] {
    this.buffer = concatBytes(this.buffer, chunk);
    const frames: Uint8Array[] = [];

    while (this.buffer.length >= 4) {
      const len = readU32BE(this.buffer, 0);
      if (this.buffer.length < 4 + len) break;

      frames.push(this.buffer.subarray(4, 4 + len));
      this.buffer = this.buffer.subarray(4 + len);
    }

    return frames;
  }
}
