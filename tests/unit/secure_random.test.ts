import { afterEach, expect, test, vi } from "vitest";
import { MAX_SECURE_RANDOM_BYTES, SecureRandom } from "../../app/core/runtime/SecureRandom";

type RandomGlobals = typeof globalThis & { __hostSecureRandom?: { fill(target: Uint8Array): void } };
const globals = globalThis as RandomGlobals;

afterEach(() => {
  delete globals.__hostSecureRandom;
  vi.unstubAllGlobals();
});

test("prefers the TiangZ host bridge over any other source", () => {
  const fill = vi.fn((target: Uint8Array) => target.fill(7));
  globals.__hostSecureRandom = { fill };
  expect([...SecureRandom.Bytes(4)]).toEqual([7, 7, 7, 7]);
  expect(SecureRandom.Hex(2)).toBe("0707");
  expect(fill).toHaveBeenCalledTimes(2);
});

test("falls back to Web Crypto in test hosts and produces distinct unguessable values", () => {
  expect(SecureRandom.IsAvailable()).toBe(true);
  const first = SecureRandom.Hex();
  const second = SecureRandom.Hex();
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  expect(first).not.toBe(second);
  expect(SecureRandom.Bytes(0).length).toBe(0);
  expect(SecureRandom.Bytes(MAX_SECURE_RANDOM_BYTES).length).toBe(MAX_SECURE_RANDOM_BYTES);
});

test("validates lengths and targets", () => {
  for (const length of [-1, 1.5, Number.NaN, MAX_SECURE_RANDOM_BYTES + 1]) {
    expect(() => SecureRandom.Bytes(length)).toThrow(RangeError);
  }
  expect(() => SecureRandom.Fill(new Uint8Array(MAX_SECURE_RANDOM_BYTES + 1))).toThrow(RangeError);
  expect(() => SecureRandom.Fill([1, 2] as unknown as Uint8Array)).toThrow(TypeError);
});

test("throws instead of degrading to Math.random when no secure source exists", () => {
  vi.stubGlobal("crypto", undefined);
  const weak = vi.spyOn(Math, "random");
  expect(SecureRandom.IsAvailable()).toBe(false);
  expect(() => SecureRandom.Bytes(16)).toThrow("secure random source is unavailable");
  expect(weak).not.toHaveBeenCalled();
});
