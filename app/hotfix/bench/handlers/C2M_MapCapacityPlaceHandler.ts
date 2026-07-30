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
import { MapCapacityPlacementOf } from "../MapCapacityLayout";

@unitRpcHandler(PlayerUnit, MapCapacityBenchProtocol.Place)
export class C2M_MapCapacityPlaceHandler implements UnitRpcHandler<
  PlayerUnit,
  C2M_MapCapacityPlace,
  M2C_MapCapacityPlace
> {
  /**
   * 仅在Bench Bundle中把虚拟玩家放到指定压测布局。
   * `layout=1`均匀轮询全部AOI Grid并落在中央Cell；`layout=2`固定在单个Grid的四个内侧起点。
   * 两种布局都把测试速度限制为1 Cell/s，配合默认四方向方形轨迹验证稳定Grid密度。
   * 该入口不能进入Demo Bundle；正式客户端无权指定服务端权威坐标。
   *
   * Places virtual players in a benchmark-only layout. Layout 1 spreads them
   * across all AOI grids at their center cells; layout 2 uses four direction-safe anchors.
   * Both cap benchmark speed at 1 cell/s for a stable-grid baseline. Production clients
   * must never choose positions.
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
    position.SpeedCellsPerSecond = Math.min(position.SpeedCellsPerSecond, 1);
    return {
      playerIndex: request.playerIndex,
      cellX: placement.cellX,
      cellZ: placement.cellZ,
    };
  }
}
