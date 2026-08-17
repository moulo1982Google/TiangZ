import {
  MapProtocol,
  PlayerTradeComponent,
  PlayerUnit,
  type C2M_ConfirmPlayerTrade,
  type M2C_ConfirmPlayerTrade,
  type UnitRpcHandler,
  unitRpcHandler,
} from "#tiangz/model";

/** 最终确认仍从PlayerUnit有序mailbox进入，但双角色原子提交由地图交易组件和Repository共同完成。 / Final confirmation enters through the PlayerUnit ordered mailbox while the map coordinator and Repository own the two-character atomic commit. */
@unitRpcHandler(PlayerUnit, MapProtocol.ConfirmPlayerTrade)
export class C2M_ConfirmPlayerTradeHandler implements UnitRpcHandler<PlayerUnit, C2M_ConfirmPlayerTrade, M2C_ConfirmPlayerTrade> {
  handle(unit: PlayerUnit, request: C2M_ConfirmPlayerTrade): Promise<M2C_ConfirmPlayerTrade> {
    return unit.DomainScene().GetComponent(PlayerTradeComponent).Confirm(unit, request.tradeId);
  }
}
