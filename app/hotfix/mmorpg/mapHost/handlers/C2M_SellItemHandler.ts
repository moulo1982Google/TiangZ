import {
  MapProtocol,
  NpcShopComponent,
  PlayerUnit,
  type C2M_SellItem,
  type M2C_SellItem,
  type UnitRpcHandler,
  unitRpcHandler,
} from "#tiangz/model";

/** 出售同样走玩家有序mailbox和DBProxy事务，不能只在客户端减少数量。 / Selling uses the ordered PlayerUnit mailbox and DBProxy transaction; the client must never reduce inventory locally. */
@unitRpcHandler(PlayerUnit, MapProtocol.SellItem)
export class C2M_SellItemHandler implements UnitRpcHandler<PlayerUnit, C2M_SellItem, M2C_SellItem> {
  handle(unit: PlayerUnit, request: C2M_SellItem): Promise<M2C_SellItem> {
    return unit.DomainScene().GetComponent(NpcShopComponent).Sell(unit, request);
  }
}
