import { MapHostComponent, MapHostScene, PublicMapHostProtocol, rpcHandler,
  type SceneRpcHandler, type MM2M_PublicMapStatus, type M2MM_PublicMapStatus } from "#tiangz/model";

@rpcHandler(MapHostScene, PublicMapHostProtocol.Status)
export class PublicMapStatusHandler implements SceneRpcHandler<MapHostScene, MM2M_PublicMapStatus, M2MM_PublicMapStatus> {
  /** 查询分线及在途席位，不返回角色业务数据。 / Reports channel occupancy without exposing character business data. */
  handle(scene: MapHostScene, request: MM2M_PublicMapStatus): M2MM_PublicMapStatus {
    return { rpcId: request.rpcId, ...scene.GetComponent(MapHostComponent).PublicMapStatus(request.mapInstanceId) };
  }
}
