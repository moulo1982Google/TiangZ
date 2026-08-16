import { Component, component, lifecycle } from "../../../core/public";
import type {
  C2M_BuyNpcShopItem,
  C2M_SellItem,
  M2C_BuyNpcShopItem,
  M2C_OpenNpcShop,
  M2C_SellItem,
} from "../../../generated/model/server/demo/protocol/messages";
import type { NpcComponent } from "../npc/NpcComponent";
import type { PlayerUnit } from "../map/PlayerUnit";

export interface NpcShopComponent {
  Open(player: PlayerUnit, npcUnitId: number): M2C_OpenNpcShop;
  Buy(player: PlayerUnit, request: C2M_BuyNpcShopItem): Promise<M2C_BuyNpcShopItem>;
  Sell(player: PlayerUnit, request: C2M_SellItem): Promise<M2C_SellItem>;
}

/**
 * 地图级商店边界只持有NPC索引；金币、背包和事务仍归PlayerUnit组件。
 * The map-level shop boundary only holds the NPC index; currency, inventory,
 * and transactions remain owned by PlayerUnit components.
 */
@component()
@lifecycle({ awake: true, destroy: true })
export class NpcShopComponent extends Component<[npc: NpcComponent]> {
  protected npc!: NpcComponent;
}
