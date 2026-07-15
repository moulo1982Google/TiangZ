export class BinaryWriter {
  private buffer: Uint8Array;
  private length = 0;

  constructor(initialCapacity = 512) {
    this.buffer = new Uint8Array(initialCapacity);
  }

  string(fieldNo: number, value: string): void {
    if (!value) return;
    this.tag(fieldNo, 2);
    const encoded = utf8Encode(value);
    this.varint(encoded.length);
    this.rawBytes(encoded);
  }

  uint32(fieldNo: number, value: number | undefined): void {
    if (value === undefined || value === 0) return;
    this.tag(fieldNo, 0);
    this.varint(value);
  }

  int32(fieldNo: number, value: number | undefined): void {
    if (value === undefined || value === 0) return;
    this.tag(fieldNo, 0);
    if (value >= 0) {
      this.varint(value);
    } else {
      this.varint64(value >>> 0, 0xffff_ffff);
    }
  }

  sint32(fieldNo: number, value: number | undefined): void {
    if (value === undefined || value === 0) return;
    this.tag(fieldNo, 0);
    this.varint(((value << 1) ^ (value >> 31)) >>> 0);
  }

  bool(fieldNo: number, value: boolean | undefined): void {
    if (!value) return;
    this.tag(fieldNo, 0);
    this.byte(1);
  }

  float(fieldNo: number, value: number | undefined): void {
    if (value === undefined || value === 0) return;
    this.tag(fieldNo, 5);
    this.fixed(4, (view) => view.setFloat32(0, value, true));
  }

  double(fieldNo: number, value: number | undefined): void {
    if (value === undefined || value === 0) return;
    this.tag(fieldNo, 1);
    this.fixed(8, (view) => view.setFloat64(0, value, true));
  }

  bytes(fieldNo: number, value: Uint8Array | undefined): void {
    if (value === undefined || value.length === 0) return;
    this.tag(fieldNo, 2);
    this.varint(value.length);
    this.rawBytes(value);
  }

  finish(): Uint8Array {
    return this.buffer.subarray(0, this.length);
  }

  private tag(fieldNo: number, wireType: number): void {
    this.varint((fieldNo << 3) | wireType);
  }

  private varint(value: number): void {
    let current = value >>> 0;
    while (current >= 0x80) {
      this.byte((current & 0x7f) | 0x80);
      current >>>= 7;
    }
    this.byte(current);
  }

  private varint64(low: number, high: number): void {
    let currentLow = low >>> 0;
    let currentHigh = high >>> 0;
    while (currentHigh !== 0 || currentLow >= 0x80) {
      this.byte((currentLow & 0x7f) | 0x80);
      currentLow = ((currentLow >>> 7) | (currentHigh << 25)) >>> 0;
      currentHigh >>>= 7;
    }
    this.byte(currentLow);
  }

  private fixed(
    size: number,
    write: (view: DataView) => void,
  ): void {
    this.ensure(size);
    const view = new DataView(
      this.buffer.buffer,
      this.buffer.byteOffset + this.length,
      size,
    );
    write(view);
    this.length += size;
  }

  private rawBytes(value: Uint8Array): void {
    this.ensure(value.length);
    this.buffer.set(value, this.length);
    this.length += value.length;
  }

  private byte(value: number): void {
    this.ensure(1);
    this.buffer[this.length] = value;
    this.length += 1;
  }

  private ensure(extra: number): void {
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

export class BinaryReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  eof(): boolean {
    return this.offset >= this.bytes.length;
  }

  tag(): { fieldNo: number; wireType: number } {
    const tag = this.varint();
    return {
      fieldNo: tag >>> 3,
      wireType: tag & 0x7,
    };
  }

  string(): string {
    const len = this.varint();
    const start = this.offset;
    this.advance(len);
    return utf8Decode(this.bytes.subarray(start, start + len));
  }

  bytesField(): Uint8Array {
    const len = this.varint();
    const start = this.offset;
    this.advance(len);
    return this.bytes.subarray(start, start + len);
  }

  uint32(): number {
    return this.varint();
  }

  int32(): number {
    return this.varint() | 0;
  }

  sint32(): number {
    const value = this.varint();
    return (value >>> 1) ^ -(value & 1);
  }

  bool(): boolean {
    return this.varint() !== 0;
  }

  float(): number {
    return this.fixed(4).getFloat32(0, true);
  }

  double(): number {
    return this.fixed(8).getFloat64(0, true);
  }

  skip(wireType: number): void {
    if (wireType === 0) {
      this.varint();
      return;
    }
    if (wireType === 2) {
      const len = this.varint();
      this.advance(len);
      return;
    }
    if (wireType === 1) {
      this.advance(8);
      return;
    }
    if (wireType === 5) {
      this.advance(4);
      return;
    }
    throw new Error(`unsupported protobuf wire type: ${wireType}`);
  }

  private varint(): number {
    let shift = 0;
    let result = 0;
    for (let index = 0; index < 10; index += 1) {
      if (this.offset >= this.bytes.length) {
        throw new Error("unexpected eof while reading varint");
      }
      const byte = this.bytes[this.offset++];
      if (shift < 32) result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
    throw new Error("varint too long");
  }

  private fixed(size: number): DataView {
    const start = this.offset;
    this.advance(size);
    return new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + start,
      size,
    );
  }

  private advance(length: number): void {
    if (length < 0 || this.offset + length > this.bytes.length) {
      throw new Error("unexpected eof while reading protobuf field");
    }
    this.offset += length;
  }
}

function utf8Encode(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length * 3);
  let offset = 0;
  for (let i = 0; i < value.length; i += 1) {
    let codePoint = value.charCodeAt(i);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      }
    }

    if (codePoint <= 0x7f) {
      bytes[offset] = codePoint;
      offset += 1;
    } else if (codePoint <= 0x7ff) {
      bytes[offset] = 0xc0 | (codePoint >> 6);
      bytes[offset + 1] = 0x80 | (codePoint & 0x3f);
      offset += 2;
    } else if (codePoint <= 0xffff) {
      bytes[offset] = 0xe0 | (codePoint >> 12);
      bytes[offset + 1] = 0x80 | ((codePoint >> 6) & 0x3f);
      bytes[offset + 2] = 0x80 | (codePoint & 0x3f);
      offset += 3;
    } else {
      bytes[offset] = 0xf0 | (codePoint >> 18);
      bytes[offset + 1] = 0x80 | ((codePoint >> 12) & 0x3f);
      bytes[offset + 2] = 0x80 | ((codePoint >> 6) & 0x3f);
      bytes[offset + 3] = 0x80 | (codePoint & 0x3f);
      offset += 4;
    }
  }
  return bytes.slice(0, offset);
}

function utf8Decode(value: Uint8Array): string {
  let result = "";
  for (let i = 0; i < value.length;) {
    const b1 = value[i++];
    if (b1 < 0x80) {
      result += String.fromCharCode(b1);
    } else if (b1 < 0xe0) {
      const b2 = value[i++];
      result += String.fromCharCode(((b1 & 0x1f) << 6) | (b2 & 0x3f));
    } else if (b1 < 0xf0) {
      const b2 = value[i++];
      const b3 = value[i++];
      result += String.fromCharCode(
        ((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f),
      );
    } else {
      const b2 = value[i++];
      const b3 = value[i++];
      const b4 = value[i++];
      let codePoint = ((b1 & 0x07) << 18) |
        ((b2 & 0x3f) << 12) |
        ((b3 & 0x3f) << 6) |
        (b4 & 0x3f);
      codePoint -= 0x10000;
      result += String.fromCharCode(
        0xd800 + (codePoint >> 10),
        0xdc00 + (codePoint & 0x3ff),
      );
    }
  }
  return result;
}

export function writeU16BE(value: number): Uint8Array {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

export function readU16BE(bytes: Uint8Array, offset = 0): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

export function writeU32BE(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

export function readU32BE(bytes: Uint8Array, offset = 0): number {
  return (
    ((bytes[offset] << 24) >>> 0) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  ) >>> 0;
}

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let result = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    result += BASE64_ALPHABET[(n >>> 18) & 63];
    result += BASE64_ALPHABET[(n >>> 12) & 63];
    result += BASE64_ALPHABET[(n >>> 6) & 63];
    result += BASE64_ALPHABET[n & 63];
  }

  const remaining = bytes.length - i;
  if (remaining === 1) {
    const n = bytes[i] << 16;
    result += BASE64_ALPHABET[(n >>> 18) & 63];
    result += BASE64_ALPHABET[(n >>> 12) & 63];
    result += "==";
  } else if (remaining === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    result += BASE64_ALPHABET[(n >>> 18) & 63];
    result += BASE64_ALPHABET[(n >>> 12) & 63];
    result += BASE64_ALPHABET[(n >>> 6) & 63];
    result += "=";
  }

  return result;
}

export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/=+$/, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const ch of clean) {
    const value = BASE64_LOOKUP[ch];
    if (value === undefined) {
      throw new Error(`invalid base64 character: ${ch}`);
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
  }

  return new Uint8Array(bytes);
}

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_LOOKUP: Record<string, number> = Object.fromEntries(
  [...BASE64_ALPHABET].map((ch, index) => [ch, index]),
);
