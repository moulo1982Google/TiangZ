import { expect, test } from "vitest";
import { base64ToBytes, BinaryReader, BinaryWriter, bytesToBase64, concatBytes, readU16BE, readU32BE, utf8Decode,
  utf8Encode, writeU16BE, writeU32BE } from "../../app/core/protocol/binary";

test("every scalar type round-trips, and unknown fields of each wire type are skipped", () => {
  const writer = new BinaryWriter(1);
  writer.uint32(1, 300);
  writer.double(2, 1.25);
  writer.float(3, -2.5);
  writer.string(4, "跳过");
  writer.int64(5, -2n);
  writer.uint64(6, 0xffff_ffff_ffff_ffffn);
  writer.sint32(7, -3);
  writer.int32(8, -1);
  writer.bool(9, true);
  writer.bytes(10, Uint8Array.of(1, 2, 3));
  const reader = new BinaryReader(writer.finish());
  const read: Record<number, unknown> = {};
  while (!reader.eof()) {
    const { fieldNo, wireType } = reader.tag();
    if (fieldNo === 2 || fieldNo === 3 || fieldNo === 4) reader.skip(wireType);
    else if (fieldNo === 1) read[1] = reader.uint32();
    else if (fieldNo === 5) read[5] = reader.int64();
    else if (fieldNo === 6) read[6] = reader.uint64();
    else if (fieldNo === 7) read[7] = reader.sint32();
    else if (fieldNo === 8) read[8] = reader.int32();
    else if (fieldNo === 9) read[9] = reader.bool();
    else read[fieldNo] = [...reader.bytesField()];
  }
  expect(read).toEqual({ 1: 300, 5: -2n, 6: 0xffff_ffff_ffff_ffffn, 7: -3, 8: -1, 9: true, 10: [1, 2, 3] });

  const floats = new BinaryWriter();
  floats.double(1, 1.25);
  floats.float(2, -2.5);
  const floatReader = new BinaryReader(floats.finish());
  floatReader.tag();
  expect(floatReader.double()).toBe(1.25);
  floatReader.tag();
  expect(floatReader.float()).toBe(-2.5);
});

test("malformed input throws instead of reading past the frame", () => {
  expect(() => new BinaryReader(Uint8Array.of(0x80)).uint32()).toThrow("unexpected eof while reading varint");
  expect(() => new BinaryReader(new Uint8Array(11).fill(0x80)).uint32()).toThrow("varint too long");
  expect(() => new BinaryReader(new Uint8Array(11).fill(0x80)).uint64()).toThrow("uint64 varint overflow");
  expect(() => new BinaryReader(Uint8Array.of(0x80)).uint64()).toThrow("unexpected eof while reading varint");
  expect(() => new BinaryReader(Uint8Array.of(...new Array(9).fill(0xff), 0x02)).uint64()).toThrow("uint64 varint overflow");
  expect(() => new BinaryReader(Uint8Array.of(5, 1)).string()).toThrow("unexpected eof while reading protobuf field");
  expect(() => new BinaryReader(Uint8Array.of(1, 2)).double()).toThrow("unexpected eof");
  expect(() => new BinaryReader(new Uint8Array()).skip(3)).toThrow("unsupported protobuf wire type: 3");
});

test("UTF-8 covers one to four byte characters and surrogate pairs", () => {
  const text = "aé中😀";
  const encoded = utf8Encode(text);
  expect([...encoded]).toEqual([0x61, 0xc3, 0xa9, 0xe4, 0xb8, 0xad, 0xf0, 0x9f, 0x98, 0x80]);
  expect(utf8Decode(encoded)).toBe(text);
  // A lone high surrogate is encoded as a three-byte unit rather than dropped.
  expect(utf8Encode("\ud83d").length).toBe(3);
  expect(utf8Encode("\ud83dx").length).toBe(4);
});

test("network-order integers, concatenation and base64 helpers", () => {
  expect(readU16BE(writeU16BE(0xabcd))).toBe(0xabcd);
  expect(readU32BE(writeU32BE(0xfedc_ba98))).toBe(0xfedc_ba98);
  expect(readU32BE(concatBytes(Uint8Array.of(9), writeU32BE(7)), 1)).toBe(7);
  for (const length of [0, 1, 2, 3, 4, 5]) {
    const bytes = Uint8Array.from({ length }, (_, index) => index * 61 + 7);
    const encoded = bytesToBase64(bytes);
    expect(encoded).toBe(Buffer.from(bytes).toString("base64"));
    expect(base64ToBytes(encoded)).toEqual(bytes);
  }
  expect(() => base64ToBytes("ab$d")).toThrow("invalid base64 character: $");
});
