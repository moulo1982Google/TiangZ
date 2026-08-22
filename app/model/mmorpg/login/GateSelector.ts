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
  return SelectStickyScene(account, gates, "Gate");
}

/** 按Rendezvous得分返回全部候选，供健康感知入口依次探测而不改变稳定顺序。 / Ranks every candidate by rendezvous score so health-aware entry can probe in stable order. */
export function RankStickyScenes(
  account: string,
  scenes: readonly SceneConfig[],
  sceneLabel = "Scene",
): SceneConfig[] {
  if (scenes.length === 0) throw new Error(`cannot rank ${sceneLabel} from an empty list`);
  return [...scenes].sort((left, right) => {
    const leftScore = Hash32(`${account}\0${left.name}`);
    const rightScore = Hash32(`${account}\0${right.name}`);
    return rightScore - leftScore || left.name.localeCompare(right.name);
  });
}

/** 使用同一Rendezvous Hash策略选择稳定业务节点；用于Login等需要账号粘滞的入口。 / Selects a stable business node with the same rendezvous-hash policy for account-sticky entry points such as Login. */
export function SelectStickyScene(
  account: string,
  scenes: readonly SceneConfig[],
  sceneLabel = "Scene",
): SceneConfig {
  return RankStickyScenes(account, scenes, sceneLabel)[0];
}

/** 生成跨V8、跨平台稳定的无符号32位哈希；不可用于安全令牌。 / Produces a stable unsigned 32-bit hash across V8 instances and platforms; never use it for security tokens. */
function Hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  // FNV-1a 的原始低位对“长公共账号前缀 + 短Gate后缀”相关性较强。最终混合让
  // Rendezvous候选分数充分扩散，否则配置了多个Gate也可能形成严重热点。
  // Raw FNV-1a bits correlate for long common account prefixes and short Gate suffixes. The
  // final avalanche spreads rendezvous scores so adding Gates does not silently create hotspots.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}
