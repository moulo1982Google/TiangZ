import {
  type G2M_EnterMap,
  type M2G_EnterMap,
  MapHostComponent,
  MapHostScene,
  MapProtocol,
  rpcHandler,
  type SceneRpcHandler,
} from "#tiangz/model";

@rpcHandler(MapHostScene, MapProtocol.EnterMap)
export class G2M_EnterMapHandler implements SceneRpcHandler<
  MapHostScene,
  G2M_EnterMap,
  M2G_EnterMap
> {
  /** 将进入地图组合交给 MapHostComponent，避免传输代码拥有 Unit 生命周期。 / Delegates entry composition to MapHostComponent so transport code owns no Unit lifecycle. */
  handle(scene: MapHostScene, request: G2M_EnterMap): Promise<M2G_EnterMap> {
    return scene.GetComponent(MapHostComponent).enterMap(request);
  }
}
