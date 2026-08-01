import {
  DynamicMapLifecycleComponent,
  DynamicMapProtocol,
  MapManagerComponent,
  MapManagerScene,
  MapHostScene,
  type M2S_CreateDynamicMap,
  type M2S_DisposeDynamicMap,
  rpcHandler,
  type S2M_CreateDynamicMap,
  type S2M_DisposeDynamicMap,
  type SceneRpcHandler,
} from "#tiangz/model";

@rpcHandler(MapManagerScene, DynamicMapProtocol.Create)
export class CreateDynamicMapHandler implements SceneRpcHandler<MapManagerScene, S2M_CreateDynamicMap, M2S_CreateDynamicMap> {
  /** 把幂等创建交给中央MapManager，Handler不保存调度状态。 / Delegates idempotent creation to central MapManager without storing scheduler state. */
  handle(scene: MapManagerScene, request: S2M_CreateDynamicMap): Promise<M2S_CreateDynamicMap> {
    return scene.GetComponent(MapManagerComponent).Create(request);
  }
}

@rpcHandler(MapHostScene, DynamicMapProtocol.Dispose)
export class DisposeDynamicMapHandler implements SceneRpcHandler<MapHostScene, S2M_DisposeDynamicMap, M2S_DisposeDynamicMap> {
  /** 只销毁业务已清空的动态实例；不会暗中传送或踢出玩家。 / Disposes only a business-emptied dynamic instance and never silently transfers or kicks players. */
  handle(scene: MapHostScene, request: S2M_DisposeDynamicMap): Promise<M2S_DisposeDynamicMap> {
    return scene.GetComponent(DynamicMapLifecycleComponent).Dispose(request);
  }
}
