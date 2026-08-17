import {
  MapProtocol,
  PlayerTradeComponent,
  PlayerUnit,
  type C2M_UpdatePlayerTradeOffer,
  type M2C_UpdatePlayerTradeOffer,
  type UnitRpcHandler,
  unitRpcHandler,
} from "#tiangz/model";

/** 报价修改在玩家有序mailbox内完成，并由交易组件同步清除双方确认。 / Offer changes run in the player's ordered mailbox and synchronously clear both confirmations in the trade component. */
@unitRpcHandler(PlayerUnit, MapProtocol.UpdatePlayerTradeOffer)
export class C2M_UpdatePlayerTradeOfferHandler implements UnitRpcHandler<PlayerUnit, C2M_UpdatePlayerTradeOffer, M2C_UpdatePlayerTradeOffer> {
  async handle(unit: PlayerUnit, request: C2M_UpdatePlayerTradeOffer): Promise<M2C_UpdatePlayerTradeOffer> {
    return { trade: await unit.DomainScene().GetComponent(PlayerTradeComponent).UpdateOffer(unit, request) };
  }
}
