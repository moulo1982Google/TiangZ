import {
  MapProtocol, PlayerUnit, UnitActionComponent, RpcError, SystemErrCode,
  type C2M_InvokeUnitAction, type M2C_InvokeUnitAction, type UnitRpcHandler, unitRpcHandler,
} from "#tiangz/model";

/** 玩家路由已确定拥有者；操作只能进入此玩家的登记组件。 / Player routing establishes ownership; actions reach only this player's registered component. */
@unitRpcHandler(PlayerUnit, MapProtocol.InvokeUnitAction)
export class C2M_InvokeUnitActionHandler implements UnitRpcHandler<PlayerUnit, C2M_InvokeUnitAction, M2C_InvokeUnitAction> {
  async handle(unit: PlayerUnit, request: C2M_InvokeUnitAction): Promise<M2C_InvokeUnitAction> {
    const actions = unit.TryGetComponent(UnitActionComponent);
    if (!actions) throw new RpcError(SystemErrCode.HandlerNotFound, "unit has no registered actions");
    return { payload: await actions.Invoke(request.namespace, request.action, request.version, request.operationId, request.payload) };
  }
}
