import {
  MapProtocol,
  PlayerTradeComponent,
  PlayerUnit,
  type C2M_RequestPlayerTrade,
  type M2C_RequestPlayerTrade,
  type UnitRpcHandler,
  unitRpcHandler,
} from "#tiangz/model";

/** 邀请只做PlayerUnit到地图交易协调器的一层胶水；目标查找、距离和忙碌状态由组件统一校验。 / Invitation handler is one layer of glue from PlayerUnit to the map trade coordinator, which owns target, range, and busy validation. */
@unitRpcHandler(PlayerUnit, MapProtocol.RequestPlayerTrade)
export class C2M_RequestPlayerTradeHandler implements UnitRpcHandler<PlayerUnit, C2M_RequestPlayerTrade, M2C_RequestPlayerTrade> {
  async handle(unit: PlayerUnit, request: C2M_RequestPlayerTrade): Promise<M2C_RequestPlayerTrade> {
    return { trade: await unit.DomainScene().GetComponent(PlayerTradeComponent).Request(unit, request.targetUnitId) };
  }
}
