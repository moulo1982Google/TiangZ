import {
  type G2M_QueryPlayerOffline,
  type M2G_QueryPlayerOffline,
  MapHostLifecycleProtocol,
  MapHostScene,
  rpcHandler,
  type SceneRpcHandler,
} from "#tiangz/model";

@rpcHandler(MapHostScene, MapHostLifecycleProtocol.QueryPlayerOffline)
export class G2M_QueryPlayerOfflineHandler implements SceneRpcHandler<MapHostScene, G2M_QueryPlayerOffline, M2G_QueryPlayerOffline> {
  /** 查询完整身份匹配的离线证据，不查询或修改当前玩家Actor。 / Queries full-identity offline evidence without accessing or mutating the current player Actor. */
  handle(scene: MapHostScene, request: G2M_QueryPlayerOffline): M2G_QueryPlayerOffline {
    return scene.QueryPlayerOffline(request);
  }
}
