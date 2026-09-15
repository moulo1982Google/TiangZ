import { MapManagerComponent, MapManagerScene, PublicMapProtocol, rpcHandler,
  type SceneRpcHandler, type S2MM_AcquirePublicMap, type MM2S_AcquirePublicMap } from "#tiangz/model";

@rpcHandler(MapManagerScene, PublicMapProtocol.Acquire)
export class AcquirePublicMapHandler implements SceneRpcHandler<MapManagerScene, S2MM_AcquirePublicMap, MM2S_AcquirePublicMap> {
  /** 由公共地图调度器完成分线选择与席位预留。 / Delegates channel selection and admission to the public-map scheduler. */
  handle(scene: MapManagerScene, request: S2MM_AcquirePublicMap): Promise<MM2S_AcquirePublicMap> {
    return scene.GetComponent(MapManagerComponent).AcquirePublicMap(request);
  }
}
