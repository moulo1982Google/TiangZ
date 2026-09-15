import { MapManagerComponent,MapManagerScene,DynamicMapProtocol,rpcHandler,type SceneRpcHandler,type S2M_InspectDynamicMap,type M2S_InspectDynamicMap } from "#tiangz/model";
@rpcHandler(MapManagerScene,DynamicMapProtocol.Inspect)
export class InspectDynamicMapHandler implements SceneRpcHandler<MapManagerScene,S2M_InspectDynamicMap,M2S_InspectDynamicMap>{
  /** 查询账本不创建地图，也不延长宿主租约。 / Inspection never creates a map or extends a host lease. */
  handle(scene:MapManagerScene,request:S2M_InspectDynamicMap):M2S_InspectDynamicMap{
    return {rpcId:request.rpcId,...scene.GetComponent(MapManagerComponent).Inspect(request.requestId)};
  }
}
