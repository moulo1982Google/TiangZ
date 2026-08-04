export class BinaryWriter {
  private buffer: Uint8Array;
  private length = 0;

  constructor(initialCapacity = 128) {
    this.buffer = new Uint8Array(initialCapacity);
  }

  string(fieldNo: number, value: string | undefined, writeDefault = false): void {
    if (value === undefined || (!writeDefault && !value)) return;
    const encoded = utf8Encode(value);
    this.tag(fieldNo, 2);
    this.varint(encoded.length);
    this.rawBytes(encoded);
  }

  uint32(fieldNo: number, value: number | undefined, writeDefault = false): void {
    if (value === undefined || (!writeDefault && value === 0)) return;
    this.tag(fieldNo, 0);
    this.varint(value);
  }

  int32(fieldNo: number, value: number | undefined, writeDefault = false): void {
    if (value === undefined || (!writeDefault && value === 0)) return;
    this.tag(fieldNo, 0);
    if (value >= 0) {
      this.varint(value);
    } else {
      this.varint64(value >>> 0, 0xffff_ffff);
    }
  }

  /** Writes an unsigned protobuf integer without losing bits to JavaScript number coercion. */
  uint64(fieldNo: number, value: bigint | undefined, writeDefault = false): void {
    if (value === undefined || (!writeDefault && value === 0n)) return;
    assertBigIntRange(value, 0n, UINT64_MAX, "uint64");
    this.tag(fieldNo, 0);
    this.varintBigInt(value);
  }

  /** Writes a signed two's-complement protobuf integer represented as a bigint. */
  int64(fieldNo: number, value: bigint | undefined, writeDefault = false): void {
    if (value === undefined || (!writeDefault && value === 0n)) return;
    assertBigIntRange(value, INT64_MIN, INT64_MAX, "int64");
    this.tag(fieldNo, 0);
    this.varintBigInt(BigInt.asUintN(64, value));
  }

  sint32(fieldNo: number, value: number | undefined, writeDefault = false): void {
    if (value === undefined || (!writeDefault && value === 0)) return;
    this.tag(fieldNo, 0);
    this.varint(((value << 1) ^ (value >> 31)) >>> 0);
  }

  bool(fieldNo: number, value: boolean | undefined, writeDefault = false): void {
    if (value === undefined || (!writeDefault && !value)) return;
    this.tag(fieldNo, 0);
    this.byte(1);
  }

  float(fieldNo: number, value: number | undefined, writeDefault = false): void {
    if (value === undefined || (!writeDefault && value === 0)) return;
    this.tag(fieldNo, 5);
    this.fixed(4, (view) => view.setFloat32(0, value, true));
  }

  double(fieldNo: number, value: number | undefined, writeDefault = false): void {
    if (value === undefined || (!writeDefault && value === 0)) return;
    this.tag(fieldNo, 1);
    this.fixed(8, (view) => view.setFloat64(0, value, true));
  }

  bytes(fieldNo: number, value: Uint8Array | undefined, writeDefault = false): void {
    if (value === undefined || (!writeDefault && value.length === 0)) return;
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

  private varintBigInt(value: bigint): void {
    let current = value;
    while (current >= 0x80n) {
      this.byte(Number(current & 0x7fn) | 0x80);
      current >>= 7n;
    }
    this.byte(Number(current));
  }

  private fixed(size: number, write: (view: DataView) => void): void {
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

  uint32(): number {
    return this.varint();
  }

  int32(): number {
    return this.varint() | 0;
  }

  /** Reads all 64 bits and returns bigint because number cannot represent every uint64. */
  uint64(): bigint {
    return this.varintBigInt();
  }

  /** Reads a protobuf two's-complement int64 without precision loss. */
  int64(): bigint {
    return BigInt.asIntN(64, this.varintBigInt());
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

  bytesField(): Uint8Array {
    const length = this.varint();
    const start = this.offset;
    this.advance(length);
    return this.bytes.subarray(start, start + length);
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

  private varintBigInt(): bigint {
    let result = 0n;
    for (let index = 0; index < 10; index += 1) {
      if (this.offset >= this.bytes.length) {
        throw new Error("unexpected eof while reading varint");
      }
      const byte = this.bytes[this.offset++];
      if (index === 9 && byte > 1) throw new Error("uint64 varint overflow");
      result |= BigInt(byte & 0x7f) << BigInt(index * 7);
      if ((byte & 0x80) === 0) return result;
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

export function writeU16BE(value: number): Uint8Array {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

export function readU16BE(bytes: Uint8Array, offset = 0): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function utf8Encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function utf8Decode(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

const UINT64_MAX = (1n << 64n) - 1n;
const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;

function assertBigIntRange(
  value: bigint,
  min: bigint,
  max: bigint,
  type: string,
): void {
  if (value < min || value > max) {
    throw new RangeError(`${type} value is outside its 64-bit range: ${value}`);
  }
}
