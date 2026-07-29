import type { SceneConfig } from "../../../core/public";

/**
 * 使用Rendezvous Hash选择Gate；增加或删除Gate时只迁移一部分账号。
 * 该Demo策略保证Gate存活且拓扑一致时账号粘滞，后续LocationService仍是运行时位置权威。
 *
 * Selects a Gate with rendezvous hashing so topology changes remap only part of
 * the accounts. This Demo policy provides stickiness while Gates live; the
 * future LocationService remains authoritative for runtime location.
 */
export function SelectStickyGate(
  account: string,
  gates: readonly SceneConfig[],
): SceneConfig {
  if (gates.length === 0) throw new Error("cannot select Gate from an empty list");
  let selected = gates[0];
  let selectedScore = Hash32(`${account}\0${selected.name}`);
  for (let index = 1; index < gates.length; index += 1) {
    const candidate = gates[index];
    const score = Hash32(`${account}\0${candidate.name}`);
    if (score > selectedScore || (score === selectedScore && candidate.name < selected.name)) {
      selected = candidate;
      selectedScore = score;
    }
  }
  return selected;
}

/** 生成跨V8、跨平台稳定的无符号32位哈希；不可用于安全令牌。 / Produces a stable unsigned 32-bit hash across V8 instances and platforms; never use it for security tokens. */
function Hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
