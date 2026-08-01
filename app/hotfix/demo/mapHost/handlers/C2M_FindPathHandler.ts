import {
  type C2M_FindPath,
  type M2C_FindPath,
  MapProtocol,
  PlayerUnit,
  unitRpcHandler,
  type UnitRpcHandler,
} from "#tiangz/model";

@unitRpcHandler(PlayerUnit, MapProtocol.FindPath)
export class C2M_FindPathHandler implements UnitRpcHandler<
  PlayerUnit,
  C2M_FindPath,
  M2C_FindPath
> {
  /** 把寻路查询交给玩家所属地图，不在Handler中持有空间状态。 / Delegates path queries to the player's map without retaining spatial state in the handler. */
  handle(unit: PlayerUnit, request: C2M_FindPath): M2C_FindPath {
    return { points: unit.FindPath(request) };
  }
}
