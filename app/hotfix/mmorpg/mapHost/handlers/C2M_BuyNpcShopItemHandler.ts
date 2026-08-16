import {
  MapProtocol,
  NpcShopComponent,
  PlayerUnit,
  type C2M_BuyNpcShopItem,
  type M2C_BuyNpcShopItem,
  type UnitRpcHandler,
  unitRpcHandler,
} from "#tiangz/model";

/** 商店购买必须在PlayerUnit有序mailbox中执行，避免同一金币和背包被并发消费。 / Shop purchases run in the ordered PlayerUnit mailbox so gold and inventory cannot be spent concurrently. */
@unitRpcHandler(PlayerUnit, MapProtocol.BuyNpcShopItem)
export class C2M_BuyNpcShopItemHandler implements UnitRpcHandler<PlayerUnit, C2M_BuyNpcShopItem, M2C_BuyNpcShopItem> {
  handle(unit: PlayerUnit, request: C2M_BuyNpcShopItem): Promise<M2C_BuyNpcShopItem> {
    return unit.DomainScene().GetComponent(NpcShopComponent).Buy(unit, request);
  }
}
