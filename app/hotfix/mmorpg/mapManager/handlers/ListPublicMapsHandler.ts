import { MapManagerComponent, MapManagerScene, PublicMapProtocol, rpcHandler,
  type SceneRpcHandler, type S2MM_ListPublicMaps, type MM2S_ListPublicMaps } from "#tiangz/model";

@rpcHandler(MapManagerScene, PublicMapProtocol.List)
export class ListPublicMapsHandler implements SceneRpcHandler<MapManagerScene, S2MM_ListPublicMaps, MM2S_ListPublicMaps> {
  /** 获取仍存活并已就绪的分线目录。 / Lists live and ready public channels. */
  async handle(scene: MapManagerScene, request: S2MM_ListPublicMaps): Promise<MM2S_ListPublicMaps> {
    return { rpcId: request.rpcId, channels: await scene.GetComponent(MapManagerComponent).ListPublicMaps(request.mapConfigId) };
  }
}
