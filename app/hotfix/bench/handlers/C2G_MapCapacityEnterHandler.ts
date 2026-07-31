import {
  type C2G_MapCapacityEnter,
  type G2C_MapCapacityEnter,
  GateScene,
  GateSession,
  MapCapacityBenchProtocol,
  sessionRpcHandler,
  type SessionRpcHandler,
} from "#tiangz/model";
import { MapCapacityPlacementOf } from "../MapCapacityLayout";

@sessionRpcHandler(GateScene, MapCapacityBenchProtocol.Enter)
export class C2G_MapCapacityEnterHandler implements SessionRpcHandler<
  GateScene,
  GateSession,
  C2G_MapCapacityEnter,
  G2C_MapCapacityEnter
> {
  /** 创建时预定位Bench玩家，避免先在公共出生点Attach再搬运。 / Pre-positions a benchmark player before AOI attach. */
  async handle(
    scene: GateScene,
    session: GateSession,
    request: C2G_MapCapacityEnter,
  ): Promise<G2C_MapCapacityEnter> {
    const placement = MapCapacityPlacementOf(request.mapId, request.playerIndex, request.layout);
    const entered = await scene.EnterMapForBenchmark(
      session,
      { mapId: request.mapId },
      placement,
      request.entrySyncMode,
    );
    return { unitId: entered.unitId, cellX: placement.cellX, cellZ: placement.cellZ };
  }
}
