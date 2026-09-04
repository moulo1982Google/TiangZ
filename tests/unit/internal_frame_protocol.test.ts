import { describe, expect, test } from "vitest";

import {
  decodeActorLocationEnvelope,
  encodeActorLocationBatchEnvelope,
  encodeActorLocationEnvelope,
  forEachActorLocationBatchEntry,
} from "../../app/core/process/ActorLocation";
import {
  ActorLocationBatchEnvelopeLayout,
  ActorLocationEnvelopeLayout,
  InternalFrameMsgCode,
  TraceEnvelopeLayout,
} from "../../app/core/process/InternalFrameProtocol";
import {
  decodeTraceEnvelope,
  encodeTraceEnvelope,
} from "../../app/core/process/TraceEnvelope";

describe("Core internal frame protocol", () => {
  test("uses stable unique msgcodes and fixed layouts", () => {
    expect(new Set(Object.values(InternalFrameMsgCode)).size).toBe(3);
    expect(ActorLocationEnvelopeLayout).toEqual({
      msgCodeOffset: 0,
      instanceIdOffset: 2,
      rpcIdOffset: 10,
      fenceTokenOffset: 14,
      headerBytes: 22,
    });
    expect(ActorLocationBatchEnvelopeLayout.entry.headerBytes).toBe(20);
    expect(TraceEnvelopeLayout.headerBytes).toBe(27);
  });

  test("matches the ActorLocation golden byte vector", () => {
    const encoded = encodeActorLocationEnvelope({
      instanceId: 1,
      rpcId: 0x0102_0304,
      fenceToken: 0x0102_0304_0506_0708n,
      frame: Uint8Array.of(0x27, 0x10),
    });
    expect([...encoded]).toEqual([
      0x75, 0x2f,
      1, 0, 0, 0, 0, 0, 0, 0,
      4, 3, 2, 1,
      8, 7, 6, 5, 4, 3, 2, 1,
      0x27, 0x10,
    ]);
  });

  test("round-trips randomized ActorLocation values", () => {
    let state = 0x6d2b_79f5;
    const next = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return state >>> 0;
    };
    for (let index = 0; index < 500; index += 1) {
      const instanceId = next() + 1;
      const rpcId = next();
      const fenceToken = (BigInt(next()) << 32n) | BigInt(next());
      const frame = Uint8Array.from({ length: 2 + (next() % 64) }, () => next() & 0xff);
      const decoded = decodeActorLocationEnvelope(encodeActorLocationEnvelope({
        instanceId,
        rpcId,
        fenceToken,
        frame,
      }));
      expect(decoded.instanceId).toBe(instanceId);
      expect(decoded.rpcId).toBe(rpcId === 0 ? undefined : rpcId);
      expect(decoded.fenceToken).toBe(fenceToken === 0n ? undefined : fenceToken);
      expect(decoded.frame).toEqual(frame);
    }
  });

  test("round-trips batches and rejects truncation", () => {
    const entries = [
      { instanceId: 7, fenceToken: 9n, frame: Uint8Array.of(1, 2, 3) },
      { instanceId: 8, frame: Uint8Array.of(4, 5) },
    ];
    const batch = encodeActorLocationBatchEnvelope(entries);
    const decoded: typeof entries = [];
    forEachActorLocationBatchEntry(batch, (entry) => decoded.push({
      instanceId: entry.instanceId,
      fenceToken: entry.fenceToken,
      frame: Uint8Array.from(entry.frame),
    }));
    expect(decoded).toEqual(entries);
    expect(() => forEachActorLocationBatchEntry(batch.subarray(0, batch.length - 1), () => undefined))
      .toThrow(/truncated/);
  });

  test("round-trips Trace envelopes and rejects invalid flags", () => {
    const encoded = encodeTraceEnvelope(Uint8Array.of(0x27, 0x10), {
      traceId: "00112233445566778899aabbccddeeff",
      spanId: "0123456789abcdef",
      sampled: true,
    });
    expect(decodeTraceEnvelope(encoded)).toEqual({
      context: {
        traceId: "00112233445566778899aabbccddeeff",
        spanId: "0123456789abcdef",
        sampled: true,
      },
      frame: Uint8Array.of(0x27, 0x10),
    });
    const invalid = Uint8Array.from(encoded);
    invalid[TraceEnvelopeLayout.flagsOffset] = 2;
    expect(() => decodeTraceEnvelope(invalid)).toThrow(/flags/);
  });
});
