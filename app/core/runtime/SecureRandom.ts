/** 单次最多生成的字节数，与宿主和 Web Crypto `getRandomValues` 上限一致。 / Per-call limit, matching the host and Web Crypto `getRandomValues`. */
export const MAX_SECURE_RANDOM_BYTES = 65_536;

interface SecureRandomSource {
  fill(target: Uint8Array): void;
}

/**
 * 操作系统安全随机数（CSPRNG）。登录凭证、重连凭证、邀请码等交给客户端、用于证明身份的值
 * 必须从这里生成；`Math.random`、GlobalId、时间戳都可预测，不得替代。
 * TiangZ 宿主中由 Rust `getrandom` 提供；在 Node 等测试宿主中使用其 Web Crypto。
 * 两者都不可用时抛错，绝不退化为弱随机。
 *
 * OS-backed secure randomness (CSPRNG). Values handed to clients to prove identity, such as
 * login credentials, reconnect credentials and invite codes, must come from here;
 * `Math.random`, GlobalIds and timestamps are predictable and must not substitute.
 * The TiangZ host provides it through Rust `getrandom`; test hosts such as Node use their
 * Web Crypto. It throws when neither is available and never degrades to weak randomness.
 */
export class SecureRandom {
  private constructor() {}

  /** 当前宿主是否提供安全随机源。 / Whether the current host provides a secure source. */
  static IsAvailable(): boolean {
    return resolveSource() !== undefined;
  }

  /** 原地填充并返回同一个缓冲。 / Fills the buffer in place and returns it. */
  static Fill(target: Uint8Array): Uint8Array {
    if (!(target instanceof Uint8Array)) throw new TypeError("secure random target must be a Uint8Array");
    if (target.length > MAX_SECURE_RANDOM_BYTES) {
      throw new RangeError(`secure random request of ${target.length} bytes exceeds ${MAX_SECURE_RANDOM_BYTES}`);
    }
    const source = resolveSource();
    if (!source) throw new Error("secure random source is unavailable in this host");
    source.fill(target);
    return target;
  }

  /** 返回指定长度的新随机字节。 / Returns fresh random bytes of the given length. */
  static Bytes(length: number): Uint8Array {
    if (!Number.isInteger(length) || length < 0 || length > MAX_SECURE_RANDOM_BYTES) {
      throw new RangeError(`secure random length must be an integer in 0..${MAX_SECURE_RANDOM_BYTES}`);
    }
    return SecureRandom.Fill(new Uint8Array(length));
  }

  /** 返回 `byteLength` 个随机字节的小写十六进制文本，适合做不可猜测的凭证；默认 32 字节。 / Lower-case hex of `byteLength` random bytes, suitable for unguessable credentials; 32 bytes by default. */
  static Hex(byteLength = 32): string {
    const bytes = SecureRandom.Bytes(byteLength);
    let text = "";
    for (const value of bytes) text += value.toString(16).padStart(2, "0");
    return text;
  }
}

function resolveSource(): SecureRandomSource | undefined {
  const host = (globalThis as { __hostSecureRandom?: SecureRandomSource }).__hostSecureRandom;
  if (host && typeof host.fill === "function") return host;
  const webCrypto = (globalThis as { crypto?: { getRandomValues?(target: Uint8Array): Uint8Array } }).crypto;
  if (webCrypto && typeof webCrypto.getRandomValues === "function") {
    return { fill: (target) => void webCrypto.getRandomValues!(target) };
  }
  return undefined;
}
