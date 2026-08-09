let operationSequence = 0;

/**
 * 为一次可重试业务操作生成客户端稳定ID。调用方必须为新操作生成一次并保存，网络重试时复用原值。
 * Generates a stable client ID for one retryable operation. Callers create it
 * once for a new operation, retain it, and reuse the same value for retries.
 */
export function CreateOperationId(prefix: string = "op"): string {
  const normalized = prefix.trim().replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 24) || "op";
  operationSequence = (operationSequence + 1) >>> 0;
  const random = randomUint32().toString(36).padStart(7, "0");
  return `${normalized}-${Date.now().toString(36)}-${operationSequence.toString(36)}-${random}`;
}

function randomUint32(): number {
  const crypto = globalThis.crypto;
  if (crypto?.getRandomValues) {
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    return values[0] ?? 0;
  }
  return Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
}
