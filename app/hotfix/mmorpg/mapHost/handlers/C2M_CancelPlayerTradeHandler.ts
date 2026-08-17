import {
  MapProtocol,
  PlayerTradeComponent,
  PlayerUnit,
  type C2M_CancelPlayerTrade,
  type M2C_CancelPlayerTrade,
  type UnitRpcHandler,
  unitRpcHandler,
} from "#tiangz/model";

/** 取消只关闭临时会话；提交阶段拒绝取消，避免把已持久化事务对客户端表现成失败。 / Cancellation closes only ephemeral state and is rejected during commit so a durable transaction is never presented as failed. */
@unitRpcHandler(PlayerUnit, MapProtocol.CancelPlayerTrade)
export class C2M_CancelPlayerTradeHandler implements UnitRpcHandler<PlayerUnit, C2M_CancelPlayerTrade, M2C_CancelPlayerTrade> {
  async handle(unit: PlayerUnit, request: C2M_CancelPlayerTrade): Promise<M2C_CancelPlayerTrade> {
    await unit.DomainScene().GetComponent(PlayerTradeComponent).Cancel(unit, request.tradeId);
    return { tradeId: request.tradeId };
  }
}
