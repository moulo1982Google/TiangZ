/** 服务端与 SDK 生成 Codec 共用的精简 protobuf Writer，设计时关注分配次数。 / Minimal allocation-aware protobuf writer used by generated codecs on server and SDK. */
export class BinaryWriter {
  private buffer: Uint8Array;
  private length = 0;

  constructor(initialCapacity = 64) {
    this.buffer = new Uint8Array(initialCapacity);
  }

  /** 写入 UTF-8 文本；`writeDefault` 仅用于空值也有意义的 repeated 元素。 / Writes UTF-8 text; `writeDefault` is reserved for repeated elements whose empty value is significant. */
  string(fieldNo: number, value: string, writeDefault = false): void {
    if (!writeDefault && !value) return;
    this.tag(fieldNo, 2);
    const encoded = utf8Encode(value);
    this.varint(encoded.length);
    this.rawBytes(encoded);
  }

  /** 写入 uint32 varint；除 repeated 元素外，标量零值会省略。 / Writes a uint32 varint and omits scalar zero unless encoding a repeated element. */
  uint32(fieldNo: number, value: number | undefined, writeDefault = false): void {
    if (value === undefined || (!writeDefault && value === 0)) return;
    this.tag(fieldNo, 0);
    this.varint(value);
  }

  /** 写入 protobuf int32，负数使用规范要求的十字节表示。 / Writes protobuf int32, including the required ten-byte representation for negatives. */
  int32(fieldNo: number, value: number | undefined, writeDefault = false): void {
    if (value === undefined || (!writeDefault && value === 0)) return;
    this.tag(fieldNo, 0);
    if (value >= 0) {
      this.varint(value);
    } else {
      this.varint64(value >>> 0, 0xffff_ffff);
    }
  }

  /** 写入无符号 protobuf 整数，避免 JavaScript number 转换造成位丢失。 / Writes an unsigned protobuf integer without losing bits to JavaScript number coercion. */
  uint64(fieldNo: number, value: bigint | undefined, writeDefault = false): void {
    if (value === undefined || (!writeDefault && value === 0n)) return;
    assertBigIntRange(value, 0n, UINT64_MAX, "uint64");
    this.tag(fieldNo, 0);
    this.varintBigInt(value);
  }

  /** 写入由 bigint 表示的有符号二补码 protobuf 整数。 / Writes a signed two's-complement protobuf integer represented as a bigint. */
  int64(fieldNo: number, value: bigint | undefined, writeDefault = false): void {
    if (value === undefined || (!writeDefault && value === 0n)) return;
    assertBigIntRange(value, INT64_MIN, INT64_MAX, "int64");
    this.tag(fieldNo, 0);
    this.varintBigInt(BigInt.asUintN(64, value));
  }

  /** 写入 ZigZag 编码的 32 位有符号值。 / Writes a ZigZag encoded signed 32-bit value. */
  sint32(fieldNo: number, value: number | undefined, writeDefault = false): void {
    if (value === undefined || (!writeDefault && value === 0)) return;
    this.tag(fieldNo, 0);
    this.varint(((value << 1) ^ (value >> 31)) >>> 0);
  }

  /** 写入 protobuf bool，并保留 repeated 字段中的 false 元素。 / Writes a protobuf bool while preserving false elements inside repeated fields. */
  bool(fieldNo: number, value: boolean | undefined, writeDefault = false): void {
    if (value === undefined || (!writeDefault && !value)) return;
    this.tag(fieldNo, 0);
    this.byte(1);
  }

  /** 写入一个小端 fixed32 浮点字段。 / Writes one little-endian fixed32 floating-point field. */
  float(fieldNo: number, value: number | undefined, writeDefault = false): void {
    if (value === undefined || (!writeDefault && value === 0)) return;
    this.tag(fieldNo, 5);
    this.fixed(4, (view) => view.setFloat32(0, value, true));
  }

  /** 写入一个小端 fixed64 浮点字段。 / Writes one little-endian fixed64 floating-point field. */
  double(fieldNo: number, value: number | undefined, writeDefault = false): void {
    if (value === undefined || (!writeDefault && value === 0)) return;
    this.tag(fieldNo, 1);
    this.fixed(8, (view) => view.setFloat64(0, value, true));
  }

  /** 写入长度限定字节字段，不预先复制调用方源缓冲区。 / Writes a length-delimited byte field without copying the caller's source buffer first. */
  bytes(fieldNo: number, value: Uint8Array | undefined, writeDefault = false): void {
    if (value === undefined || (!writeDefault && value.length === 0)) return;
    this.tag(fieldNo, 2);
    this.varint(value.length);
    this.rawBytes(value);
  }

  /** 返回已写字节的视图；继续写入后，旧视图不可再假定为不可变。 / Returns a view over written bytes; do not continue writing and assume an older view is immutable. */
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

/** 带边界检查的 protobuf Reader；畸形输入会在进入 Handler 前抛错。 / Bounds-checked protobuf reader; malformed input throws before a handler receives it. */
export class BinaryReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  /** 判断当前消息切片的全部字节是否已消费。 / Reports whether every byte in this message slice has been consumed. */
  eof(): boolean {
    return this.offset >= this.bytes.length;
  }

  /** 读取字段 tag，并拆分字段号与 protobuf wire type。 / Reads one field tag and separates its number from protobuf wire type. */
  tag(): { fieldNo: number; wireType: number } {
    const tag = this.varint();
    return {
      fieldNo: tag >>> 3,
      wireType: tag & 0x7,
    };
  }

  /** 读取一个经过边界检查的 UTF-8 长度限定字段。 / Reads one bounds-checked UTF-8 length-delimited field. */
  string(): string {
    const len = this.varint();
    const start = this.offset;
    this.advance(len);
    return utf8Decode(this.bytes.subarray(start, start + len));
  }

  /** 返回长度限定字段的零拷贝视图；只能在原始帧存活期间持有。 / Returns a zero-copy view of a length-delimited field; retain it only while the frame remains alive. */
  bytesField(): Uint8Array {
    const len = this.varint();
    const start = this.offset;
    this.advance(len);
    return this.bytes.subarray(start, start + len);
  }

  /** 将 uint32 varint 精确读取为 JavaScript number。 / Reads a uint32 varint into an exact JavaScript number. */
  uint32(): number {
    return this.varint();
  }

  /** 读取 protobuf int32 的低 32 位并恢复符号。 / Reads the low 32 bits of protobuf int32 and restores its sign. */
  int32(): number {
    return this.varint() | 0;
  }

  /** 读取完整 64 位并返回 bigint，因为 number 无法表示所有 uint64。 / Reads all 64 bits and returns bigint because number cannot represent every uint64. */
  uint64(): bigint {
    return this.varintBigInt();
  }

  /** 无精度损失地读取 protobuf 二补码 int64。 / Reads a protobuf two's-complement int64 without precision loss. */
  int64(): bigint {
    return BigInt.asIntN(64, this.varintBigInt());
  }

  /** 读取并 ZigZag 解码一个 32 位有符号整数。 / Reads and ZigZag-decodes a signed 32-bit integer. */
  sint32(): number {
    const value = this.varint();
    return (value >>> 1) ^ -(value & 1);
  }

  /** 按 protobuf 语义将任意非零 varint 读取为 true。 / Reads any nonzero varint as true, following protobuf semantics. */
  bool(): boolean {
    return this.varint() !== 0;
  }

  /** 读取一个小端 fixed32 浮点数。 / Reads one little-endian fixed32 float. */
  float(): number {
    return this.fixed(4).getFloat32(0, true);
  }

  /** 读取一个小端 fixed64 双精度数。 / Reads one little-endian fixed64 double. */
  double(): number {
    return this.fixed(8).getFloat64(0, true);
  }

  /** 按 wire type 跳过未知字段，以保持向前兼容。 / Skips an unknown field by wire type to preserve forward compatibility. */
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

/** 在 neutral V8 bundle 中不依赖 TextDecoder 解码 UTF-8。 / Decodes UTF-8 without requiring TextDecoder inside the neutral V8 bundle. */
export function utf8Decode(value: Uint8Array): string {
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

/** 编码 msgcode 使用的两字节网络序整数。 / Encodes a two-byte network-order integer used for msgcode. */
export function writeU16BE(value: number): Uint8Array {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

/** 读取两字节网络序整数，不推进外部状态。 / Reads a two-byte network-order integer without advancing external state. */
export function readU16BE(bytes: Uint8Array, offset = 0): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

/** 编码帧长度使用的四字节网络序整数。 / Encodes a four-byte network-order integer used for frame lengths. */
export function writeU32BE(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

/** 读取无符号四字节网络序整数。 / Reads an unsigned four-byte network-order integer. */
export function readU32BE(bytes: Uint8Array, offset = 0): number {
  return (
    ((bytes[offset] << 24) >>> 0) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  ) >>> 0;
}

/** 将两段字节范围拼接为一个独占缓冲区。 / Concatenates two byte ranges into one owned buffer. */
export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** 为仅支持 JSON 的宿主路径编码字节；游戏帧应始终保持二进制。 / Encodes bytes for JSON-only host paths; gameplay frames should remain binary. */
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

/** 解码兼容工具使用的已校验 base64，不得用于运行时热路径。 / Decodes validated base64 used by compatibility tooling, not the runtime hot path. */
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
