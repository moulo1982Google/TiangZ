import {
  GameConfigs,
  ItemContentProfileComponent,
  type ItemContentDefinition,
  type PlayerUnit,
} from "#tiangz/model";

/** 优先解析模块内容，仅在地图保留冷内容时回退到演示表。 / Resolves module content first and falls back to demo tables only when the map keeps cold content. */
export function RequireItemContentDefinition(
  player: PlayerUnit,
  itemConfigId: number,
): Readonly<ItemContentDefinition> {
  if (!Number.isSafeInteger(itemConfigId) || itemConfigId <= 0) {
    throw new Error(`invalid item config id: ${itemConfigId}`);
  }
  const profile = player.DomainScene().TryGetComponent(ItemContentProfileComponent);
  const external = profile?.TryGetDefinition(itemConfigId);
  if (external) return external;
  if (profile && !profile.IncludesColdContent) {
    throw new Error(`item definition not found: ${itemConfigId}`);
  }
  const cold = GameConfigs.ItemConfig.TryGet(itemConfigId);
  if (!cold) throw new Error(`item definition not found: ${itemConfigId}`);
  return {
    id: cold.id,
    name: cold.name,
    quality: 0,
    level: 1,
    maxStack: cold.maxStack,
    useEffect: cold.useEffect,
    useParams: cold.useParams,
    cooldownMs: cold.cooldownMs,
    globalCooldownMs: cold.globalCooldownMs,
    buyPrice: cold.buyPrice,
    sellPrice: cold.sellPrice,
    maxDurability: 0,
    repairCostPerMillion: 0,
    purchaseCount: 1,
  };
}
