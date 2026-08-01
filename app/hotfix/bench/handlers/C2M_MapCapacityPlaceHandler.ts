import {
  type C2M_MapCapacityPlace,
  MapCapacityBenchProtocol,
  NumericComponent,
  type M2C_MapCapacityPlace,
  PlayerUnit,
  PositionComponent,
  unitRpcHandler,
  type UnitRpcHandler,
} from "#tiangz/model";
import {
  MapCapacityPlacementOf,
  MapCapacitySpeedCellsPerSecond,
} from "../MapCapacityLayout";

@unitRpcHandler(PlayerUnit, MapCapacityBenchProtocol.Place)
export class C2M_MapCapacityPlaceHandler implements UnitRpcHandler<
  PlayerUnit,
  C2M_MapCapacityPlace,
  M2C_MapCapacityPlace
> {
  /**
   * 仅在Bench Bundle中把虚拟玩家放到指定压测布局。
   * `layout=1`均匀轮询全部AOI Grid并落在中央Cell；`layout=2`固定在单个Grid的四个内侧起点。
   * 均匀布局中80%玩家保持1 Cell/s在Grid内闭环，20%玩家以Grid边长/2 Cell/s
   * 每两秒跨越一次Grid；单Grid布局仍保持1 Cell/s安全闭环。
   * 该入口不能进入Demo Bundle；正式客户端无权指定服务端权威坐标。
   *
   * Places virtual players in a benchmark-only layout. Layout 1 spreads them
   * across all AOI grids at their center cells; layout 2 uses four direction-safe anchors.
   * Uniform layout keeps 80% local and moves 20% across one grid every two seconds.
   * Single-grid layout stays at one cell per second. Production clients must never choose positions.
   */
  handle(unit: PlayerUnit, request: C2M_MapCapacityPlace): M2C_MapCapacityPlace {
    const placement = MapCapacityPlacementOf(unit.MapId, request.playerIndex, request.layout);

    const position = unit.GetComponent(PositionComponent);
    unit.GetComponent(NumericComponent).StopRegeneration();
    position.SetGridCell(
      placement.cellX,
      placement.cellZ,
      placement.y,
      placement.yaw,
    );
    position.SpeedCellsPerSecond = MapCapacitySpeedCellsPerSecond(
      unit.MapId,
      request.playerIndex,
      request.layout,
    );
    return {
      playerIndex: request.playerIndex,
      cellX: placement.cellX,
      cellZ: placement.cellZ,
    };
  }
}
