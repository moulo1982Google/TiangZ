import {
  DynamicMapManagerComponent,
  DynamicMapProtocol,
  MapHostScene,
  type M2S_CreateDynamicMap,
  type M2S_DisposeDynamicMap,
  rpcHandler,
  type S2M_CreateDynamicMap,
  type S2M_DisposeDynamicMap,
  type SceneRpcHandler,
} from "#tiangz/model";

@rpcHandler(MapHostScene, DynamicMapProtocol.Create)
export class CreateDynamicMapHandler implements SceneRpcHandler<MapHostScene, S2M_CreateDynamicMap, M2S_CreateDynamicMap> {
  /** 把动态地图创建交给业务Manager，Handler不选择MapHost也不维护实例表。 / Delegates dynamic-map creation to the business manager; the Handler owns neither placement nor instance state. */
  handle(scene: MapHostScene, request: S2M_CreateDynamicMap): Promise<M2S_CreateDynamicMap> {
    return scene.GetComponent(DynamicMapManagerComponent).Create(request);
  }
}

@rpcHandler(MapHostScene, DynamicMapProtocol.Dispose)
export class DisposeDynamicMapHandler implements SceneRpcHandler<MapHostScene, S2M_DisposeDynamicMap, M2S_DisposeDynamicMap> {
  /** 只销毁业务已清空的动态实例；不会暗中传送或踢出玩家。 / Disposes only a business-emptied dynamic instance and never silently transfers or kicks players. */
  handle(scene: MapHostScene, request: S2M_DisposeDynamicMap): Promise<M2S_DisposeDynamicMap> {
    return scene.GetComponent(DynamicMapManagerComponent).Dispose(request);
  }
}
