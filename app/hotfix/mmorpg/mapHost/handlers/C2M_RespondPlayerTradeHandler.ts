import {
  MapProtocol,
  PlayerTradeComponent,
  PlayerUnit,
  type C2M_RespondPlayerTrade,
  type M2C_RespondPlayerTrade,
  type UnitRpcHandler,
  unitRpcHandler,
} from "#tiangz/model";

/** 接受或拒绝都进入被邀请者有序mailbox，避免同一个角色同时响应两个会话。 / Accept and reject run in the invited player's ordered mailbox so one character cannot respond to two sessions concurrently. */
@unitRpcHandler(PlayerUnit, MapProtocol.RespondPlayerTrade)
export class C2M_RespondPlayerTradeHandler implements UnitRpcHandler<PlayerUnit, C2M_RespondPlayerTrade, M2C_RespondPlayerTrade> {
  async handle(unit: PlayerUnit, request: C2M_RespondPlayerTrade): Promise<M2C_RespondPlayerTrade> {
    return { trade: await unit.DomainScene().GetComponent(PlayerTradeComponent).Respond(unit, request.tradeId, request.accept) };
  }
}
