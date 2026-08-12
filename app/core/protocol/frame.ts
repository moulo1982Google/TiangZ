import { concatBytes, readU32BE, writeU16BE } from "./binary";

/** 为 `[msgcode][payload]` 帧添加 32 位网络序长度前缀。 / Prefixes one `[msgcode][payload]` frame with its 32-bit network length. */
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

/** 构造完整数据包；按设计 rpcId 始终保留在 protobuf payload 内。 / Builds a complete packet; rpcId remains inside protobuf payload by design. */
export function encodePacket(msgcode: number, payload: Uint8Array): Uint8Array {
  const frame = concatBytes(writeU16BE(msgcode), payload);
  return encodeFrameWithLength(frame);
}

export class LengthPrefixedFrameDecoder {
  private readonly chunks: Uint8Array[] = [];
  private chunkHead = 0;
  private chunkOffset = 0;
  private bufferedBytes = 0;

  /**
   * 接收任意流分片，产出完整帧并保留末尾残包。
   * 只有跨分片的完整帧才会复制；完整帧直接返回输入分片的视图。
   * 返回的视图由调用方持有，下一次 push 不会修改输入分片。
   *
   * Accepts arbitrary stream chunks and emits complete frames while retaining
   * a partial tail. Only a frame spanning chunks is copied; a frame contained
   * in one chunk is returned as a view. Returned views reference input chunks,
   * which are never mutated by a later push.
   */
  push(chunk: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    this.pushEach(chunk, (frame) => frames.push(frame));
    return frames;
  }

  /**
   * 以回调方式消费完整帧，避免为“本次产出的帧列表”额外创建数组。
   * 回调应同步消费 frame；frame 本身仍然是稳定的输入分片视图或独立副本。
   *
   * Consumes complete frames through a callback, avoiding a result array for
   * the current push. The callback should consume the frame synchronously;
   * the frame is either a stable input-chunk view or an independent copy.
   */
  pushEach(chunk: Uint8Array, consume: (frame: Uint8Array) => void): void {
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.bufferedBytes += chunk.length;
    }

    while (this.bufferedBytes >= 4) {
      const length = this.peekU32BE();
      const frameBytes = 4 + length;
      if (this.bufferedBytes < frameBytes) break;

      const current = this.chunks[this.chunkHead];
      if (!current) throw new Error("frame decoder chunk state is empty");
      const remaining = current.length - this.chunkOffset;
      if (remaining >= frameBytes) {
        const frame = current.subarray(
          this.chunkOffset + 4,
          this.chunkOffset + frameBytes,
        );
        this.advance(frameBytes);
        consume(frame);
        continue;
      }

      this.advance(4);
      const frame = new Uint8Array(length);
      this.copyInto(frame);
      consume(frame);
    }
  }

  private peekU32BE(): number {
    const current = this.chunks[this.chunkHead];
    if (!current) throw new Error("frame decoder chunk state is empty");
    if (current.length - this.chunkOffset >= 4) {
      return readU32BE(current, this.chunkOffset);
    }
    return (
      (this.byteAt(0) << 24) |
      (this.byteAt(1) << 16) |
      (this.byteAt(2) << 8) |
      this.byteAt(3)
    ) >>> 0;
  }

  private byteAt(relativeOffset: number): number {
    let index = this.chunkHead;
    let offset = this.chunkOffset + relativeOffset;
    while (true) {
      const chunk = this.chunks[index];
      if (!chunk) throw new Error("frame decoder byte is out of range");
      if (offset < chunk.length) return chunk[offset]!;
      offset -= chunk.length;
      index += 1;
    }
  }

  private copyInto(target: Uint8Array): void {
    let targetOffset = 0;
    while (targetOffset < target.length) {
      const chunk = this.chunks[this.chunkHead];
      if (!chunk) throw new Error("frame decoder copy state is empty");
      const available = chunk.length - this.chunkOffset;
      const count = Math.min(available, target.length - targetOffset);
      target.set(
        chunk.subarray(this.chunkOffset, this.chunkOffset + count),
        targetOffset,
      );
      this.advance(count);
      targetOffset += count;
    }
  }

  private advance(count: number): void {
    let remaining = count;
    this.bufferedBytes -= count;
    while (remaining > 0) {
      const chunk = this.chunks[this.chunkHead];
      if (!chunk) throw new Error("frame decoder advance state is empty");
      const available = chunk.length - this.chunkOffset;
      const consumed = Math.min(available, remaining);
      this.chunkOffset += consumed;
      remaining -= consumed;
      if (this.chunkOffset === chunk.length) {
        this.chunkHead += 1;
        this.chunkOffset = 0;
      }
    }

    if (this.chunkHead >= 32 && this.chunkHead * 2 >= this.chunks.length) {
      this.chunks.splice(0, this.chunkHead);
      this.chunkHead = 0;
    }
  }
}
