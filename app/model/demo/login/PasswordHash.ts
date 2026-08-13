/**
 * Demo账号密码凭据；只保存盐值和摘要，绝不把明文密码放进快照或Token。
 * Demo account credentials contain only a salt and digest; plaintext passwords
 * never enter a snapshot or login token.
 */
export interface PasswordCredential {
  readonly salt: string;
  readonly hash: string;
}

/** 创建带独立盐值的密码凭据；这是Demo账号存储边界，不是生产密码服务。 / Creates a salted credential at the Demo account-storage boundary. */
export function CreatePasswordCredential(account: string, password: string): PasswordCredential {
  const salt = CreateSalt(account);
  return { salt, hash: HashPassword(account, password, salt) };
}

/** 校验密码摘要；返回值只表示匹配，不暴露原始密码。 / Verifies a password digest without exposing the original password. */
export function VerifyPassword(
  account: string,
  password: string,
  credential: PasswordCredential,
): boolean {
  if (credential.salt.length === 0 || credential.hash.length === 0) return false;
  return ConstantTimeEqual(
    credential.hash,
    HashPassword(account, password, credential.salt),
  );
}

function CreateSalt(account: string): string {
  const bytes = new Uint8Array(16);
  const cryptoSource = (globalThis as {
    readonly crypto?: {
      readonly getRandomValues?: (target: Uint8Array) => Uint8Array;
    };
  }).crypto;
  if (cryptoSource?.getRandomValues) {
    cryptoSource.getRandomValues(bytes);
  } else {
    // 这里只是没有宿主随机源时的Demo回退；生产账号必须使用密码服务和系统安全随机数。
    // This is only a Demo fallback without a host random source; production accounts need a password service and CSPRNG.
    const fallback = utf8Encode(`${account}:${Date.now()}:${Math.random()}`);
    const digest = Sha256Hex(fallback);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16);
    }
  }
  return BytesToHex(bytes);
}

function HashPassword(account: string, password: string, salt: string): string {
  return Sha256Hex(utf8Encode(`${salt}:${account}:${password}`));
}

function ConstantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function BytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

function Sha256Hex(input: Uint8Array): string {
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const bitLength = input.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = RotateRight(words[index - 15], 7) ^
        RotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = RotateRight(words[index - 2], 17) ^
        RotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }

    let a = state[0];
    let b = state[1];
    let c = state[2];
    let d = state[3];
    let e = state[4];
    let f = state[5];
    let g = state[6];
    let h = state[7];
    for (let index = 0; index < 64; index += 1) {
      const sum1 = RotateRight(e, 6) ^ RotateRight(e, 11) ^ RotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + ROUND_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 = RotateRight(a, 2) ^ RotateRight(a, 13) ^ RotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  return Array.from(state, (value) => value.toString(16).padStart(8, "0")).join("");
}

function RotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
import { utf8Encode } from "../../../core/public";
