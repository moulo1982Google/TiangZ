const core = globalThis.Deno.core;
const iterations = __ITERATIONS__;
const payloadSizes = [__PAYLOAD_SIZES__];
const warmup = __WARMUP__;

const REQUEST_CODE = 30001;
const RESPONSE_CODE = 30002;

let guard = 0;

class BinaryWriter {
  constructor(initialCapacity = 128) {
    this.buffer = new Uint8Array(initialCapacity);
    this.length = 0;
  }

  uint32(fieldNo, value) {
    if (value === undefined || value === 0) return;
    this.tag(fieldNo, 0);
    this.varint(value);
  }

  bytesField(fieldNo, value) {
    if (!value || value.length === 0) return;
    this.tag(fieldNo, 2);
    this.varint(value.length);
    this.rawBytes(value);
  }

  finish() {
    return this.buffer.subarray(0, this.length);
  }

  tag(fieldNo, wireType) {
    this.varint((fieldNo << 3) | wireType);
  }

  varint(value) {
    let current = value >>> 0;
    while (current >= 0x80) {
      this.byte((current & 0x7f) | 0x80);
      current >>>= 7;
    }
    this.byte(current);
  }

  rawBytes(value) {
    this.ensure(value.length);
    this.buffer.set(value, this.length);
    this.length += value.length;
  }

  byte(value) {
    this.ensure(1);
    this.buffer[this.length] = value;
    this.length += 1;
  }

  ensure(extra) {
    const required = this.length + extra;
    if (required <= this.buffer.length) return;

    let capacity = this.buffer.length;
    if (required > capacity * 2) {
      capacity = required;
    } else {
      while (capacity < required) capacity *= 2;
    }

    const next = new Uint8Array(capacity);
    next.set(this.buffer);
    this.buffer = next;
  }
}

class BinaryReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  eof() {
    return this.offset >= this.bytes.length;
  }

  tag() {
    const tag = this.varint();
    return {
      fieldNo: tag >>> 3,
      wireType: tag & 0x7,
    };
  }

  uint32() {
    return this.varint();
  }

  bytesField() {
    const len = this.varint();
    const start = this.offset;
    this.offset += len;
    return this.bytes.subarray(start, start + len);
  }

  skip(wireType) {
    if (wireType === 0) {
      this.varint();
      return;
    }
    if (wireType === 2) {
      const len = this.varint();
      this.offset += len;
      return;
    }
    throw new Error(`unsupported protobuf wire type: ${wireType}`);
  }

  varint() {
    let shift = 0;
    let result = 0;
    while (true) {
      if (this.offset >= this.bytes.length) {
        throw new Error("unexpected eof while reading varint");
      }
      const byte = this.bytes[this.offset++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
      if (shift > 35) throw new Error("varint too long");
    }
  }
}

function writeU16BE(value) {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

function readU16BE(bytes, offset = 0) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function packFrame(msgcode, payload) {
  return concatBytes(writeU16BE(msgcode), payload);
}

function makePayload(payloadSize) {
  const payload = new Uint8Array(payloadSize);
  for (let i = 0; i < payload.length; i += 1) {
    payload[i] = (i * 31 + 7) & 0xff;
  }
  return payload;
}

function encodePingRequest(value) {
  const writer = new BinaryWriter();
  writer.uint32(90, value.rpcId);
  writer.uint32(1, value.seq);
  writer.bytesField(2, value.payload);
  return writer.finish();
}

function decodePingRequest(payload) {
  const reader = new BinaryReader(payload);
  const value = {
    seq: 0,
    payload: new Uint8Array(),
  };
  while (!reader.eof()) {
    const tag = reader.tag();
    if (tag.fieldNo === 90 && tag.wireType === 0) {
      value.rpcId = reader.uint32();
    } else if (tag.fieldNo === 1 && tag.wireType === 0) {
      value.seq = reader.uint32();
    } else if (tag.fieldNo === 2 && tag.wireType === 2) {
      value.payload = reader.bytesField();
    } else {
      reader.skip(tag.wireType);
    }
  }
  return value;
}

function encodePingResponse(value) {
  const writer = new BinaryWriter();
  writer.uint32(90, value.rpcId);
  writer.uint32(91, value.error);
  writer.uint32(1, value.seq);
  writer.bytesField(2, value.payload);
  return writer.finish();
}

const pingDescriptor = {
  name: "Perf.Ping",
  requestCode: REQUEST_CODE,
  responseCode: RESPONSE_CODE,
  requestCodec: {
    encode: encodePingRequest,
    decode: decodePingRequest,
  },
  responseCodec: {
    encode: encodePingResponse,
  },
};

const routes = new Map();
routes.set(pingDescriptor.requestCode, {
  responseCode: pingDescriptor.responseCode,
  decode: pingDescriptor.requestCodec.decode,
  encode: pingDescriptor.responseCodec.encode,
  handle(request) {
    return {
      rpcId: request.rpcId,
      seq: request.seq + 1,
      payload: request.payload,
    };
  },
  handlePooled(request, response) {
    response.rpcId = request.rpcId;
    response.seq = request.seq + 1;
    response.payload = request.payload;
    return response;
  },
});

function handlePingPong(frame) {
  const msgcode = readU16BE(frame, 0);
  const route = routes.get(msgcode);
  if (!route) throw new Error(`unknown msgcode: ${msgcode}`);
  const request = route.decode(frame.subarray(2));
  const response = route.handle(request);
  return packFrame(route.responseCode, route.encode(response));
}

function createPooledPingPongHandler() {
  const response = {
    rpcId: 0,
    seq: 0,
    payload: new Uint8Array(),
  };

  return (frame) => {
    const msgcode = readU16BE(frame, 0);
    const route = routes.get(msgcode);
    if (!route) throw new Error(`unknown msgcode: ${msgcode}`);
    const request = route.decode(frame.subarray(2));
    return packFrame(
      route.responseCode,
      route.encode(route.handlePooled(request, response)),
    );
  };
}

function touch(value) {
  if (value instanceof Uint8Array) {
    guard ^= value.length;
    guard ^= value[0] || 0;
    guard ^= value[value.length - 1] || 0;
    return;
  }
  if (value && value.payload instanceof Uint8Array) {
    guard ^= value.seq || 0;
    guard ^= value.rpcId || 0;
    guard ^= value.payload.length;
    guard ^= value.payload[0] || 0;
    return;
  }
  if (value && typeof value.responseCode === "number") {
    guard ^= value.responseCode;
    return;
  }
  guard ^= Number(value) || 0;
}

function bench(payloadSize, requestFrameLength, responseFrameLength, name, bytesPerIter, fn) {
  for (let i = 0; i < warmup; i += 1) touch(fn());
  const start = core.ops.op_now_ns();
  for (let i = 0; i < iterations; i += 1) touch(fn());
  const elapsedNs = core.ops.op_now_ns() - start;
  const reqPerSec = iterations * 1e9 / elapsedNs;
  const mibPerSec = bytesPerIter * iterations * 1e9 / elapsedNs / 1024 / 1024;
  return {
    payloadSize,
    requestFrameLength,
    responseFrameLength,
    name,
    elapsedMs: elapsedNs / 1e6,
    nsPerOp: elapsedNs / iterations,
    reqPerSec,
    mibPerSec,
  };
}

const results = [];

for (const payloadSize of payloadSizes) {
  const payload = makePayload(payloadSize);
  const requestObject = {
    rpcId: 1001,
    seq: 7,
    payload,
  };
  const requestPayload = encodePingRequest(requestObject);
  const requestFrame = packFrame(REQUEST_CODE, requestPayload);
  const responseObject = {
    rpcId: requestObject.rpcId,
    seq: requestObject.seq + 1,
    payload,
  };
  const responsePayload = encodePingResponse(responseObject);
  const responseFrame = packFrame(RESPONSE_CODE, responsePayload);
  const handlePingPongPooled = createPooledPingPongHandler();

  results.push(
    bench(
      payloadSize,
      requestFrame.length,
      responseFrame.length,
      "msgcode lookup",
      requestFrame.length,
      () => routes.get(readU16BE(requestFrame, 0)),
    ),
    bench(
      payloadSize,
      requestFrame.length,
      responseFrame.length,
      "protobuf decode",
      requestPayload.length,
      () => decodePingRequest(requestPayload),
    ),
    bench(
      payloadSize,
      requestFrame.length,
      responseFrame.length,
      "response encode",
      responsePayload.length,
      () => encodePingResponse(responseObject),
    ),
    bench(
      payloadSize,
      requestFrame.length,
      responseFrame.length,
      "pingpong full",
      requestFrame.length + responseFrame.length,
      () => handlePingPong(requestFrame),
    ),
    bench(
      payloadSize,
      requestFrame.length,
      responseFrame.length,
      "pingpong pooled resp",
      requestFrame.length + responseFrame.length,
      () => handlePingPongPooled(requestFrame),
    ),
  );
}

core.ops.op_report_result(JSON.stringify({
  iterations,
  payloadSizes,
  warmup,
  guard,
  results,
}));
