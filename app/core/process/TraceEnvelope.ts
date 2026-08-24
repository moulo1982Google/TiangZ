import { readU16BE } from "../protocol/binary";
import type { TraceContextValue } from "../telemetry/TraceContext";
import { TraceContextFromCarrier } from "../telemetry/TraceContext";

export const TraceEnvelopeMsgCode = 29_996;
export const TraceEnvelopeHeaderBytes = 27;

export interface TraceEnvelope {
  readonly context: TraceContextValue;
  readonly frame: Uint8Array;
}

/** 用固定W3C宽度ID包装Core内部帧；业务协议与客户端SDK看不到该外壳。 / Wraps a Core inner frame with fixed-width W3C IDs; business protocols and client SDKs never see it. */
export function encodeTraceEnvelope(
  frame: Uint8Array,
  context: TraceContextValue,
): Uint8Array {
  if (frame.byteLength < 2) throw new Error("trace inner frame is too short");
  const traceId = decodeHex(context.traceId, 16, "traceId");
  const spanId = decodeHex(context.spanId, 8, "spanId");
  const result = new Uint8Array(TraceEnvelopeHeaderBytes + frame.byteLength);
  const view = new DataView(result.buffer);
  view.setUint16(0, TraceEnvelopeMsgCode, false);
  result.set(traceId, 2);
  result.set(spanId, 18);
  result[26] = context.sampled ? 1 : 0;
  result.set(frame, TraceEnvelopeHeaderBytes);
  return result;
}

/** 校验并拆出Trace外壳，不复制内层业务帧。 / Validates and unwraps a trace carrier without copying its business frame. */
export function decodeTraceEnvelope(frame: Uint8Array): TraceEnvelope {
  if (
    frame.byteLength < TraceEnvelopeHeaderBytes + 2 ||
    readU16BE(frame, 0) !== TraceEnvelopeMsgCode
  ) {
    throw new Error("invalid trace envelope header");
  }
  if ((frame[26] & 0xfe) !== 0) throw new Error("invalid trace envelope flags");
  const traceId = encodeHex(frame.subarray(2, 18));
  const spanId = encodeHex(frame.subarray(18, 26));
  return {
    context: TraceContextFromCarrier(traceId, spanId, frame[26] === 1),
    frame: frame.subarray(TraceEnvelopeHeaderBytes),
  };
}

function decodeHex(value: string, byteLength: number, name: string): Uint8Array {
  if (value.length !== byteLength * 2 || !/^[0-9a-f]+$/.test(value) || /^0+$/.test(value)) {
    throw new Error(`${name} must be a non-zero lowercase hex id`);
  }
  const result = new Uint8Array(byteLength);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function encodeHex(value: Uint8Array): string {
  let result = "";
  for (const byte of value) result += byte.toString(16).padStart(2, "0");
  return result;
}
