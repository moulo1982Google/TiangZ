import {
  type C2M_NavigateTo,
  type M2C_NavigateTo,
  MapProtocol,
  PlayerUnit,
  unitRpcHandler,
  type UnitRpcHandler,
} from "#tiangz/model";

@unitRpcHandler(PlayerUnit, MapProtocol.NavigateTo)
export class C2M_NavigateToHandler implements UnitRpcHandler<
  PlayerUnit,
  C2M_NavigateTo,
  M2C_NavigateTo
> {
  /** 把目标交给PlayerUnit，避免Handler保存路径、坐标或NavMesh句柄。 / Delegates the target to PlayerUnit so the handler owns no path, position, or NavMesh handle. */
  handle(unit: PlayerUnit, request: C2M_NavigateTo): M2C_NavigateTo {
    return unit.NavigateTo(request);
  }
}
