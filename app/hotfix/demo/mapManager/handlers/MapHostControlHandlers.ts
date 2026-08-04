import {
  MapHostComponent,
  MapHostControlProtocol,
  MapHostScene,
  MapManagerComponent,
  MapManagerScene,
  type M2MM_CreateAssignedDynamicMap,
  type MM2M_CreateAssignedDynamicMap,
  type MM2S_DynamicMapDisposed,
  type MM2S_MapHostHeartbeat,
  type MM2S_RegisterMapHost,
  rpcHandler,
  type S2MM_DynamicMapDisposed,
  type S2MM_MapHostHeartbeat,
  type S2MM_RegisterMapHost,
  type SceneRpcHandler,
} from "#tiangz/model";

@rpcHandler(MapManagerScene, MapHostControlProtocol.Register)
export class RegisterMapHostHandler implements SceneRpcHandler<MapManagerScene, S2MM_RegisterMapHost, MM2S_RegisterMapHost> {
  /** 接收MapHost完整注册与恢复快照。 / Accepts a full MapHost registration and recovery snapshot. */
  handle(scene: MapManagerScene, request: S2MM_RegisterMapHost): MM2S_RegisterMapHost {
    return scene.GetComponent(MapManagerComponent).Register(request);
  }
}

@rpcHandler(MapManagerScene, MapHostControlProtocol.Heartbeat)
export class MapHostHeartbeatHandler implements SceneRpcHandler<MapManagerScene, S2MM_MapHostHeartbeat, MM2S_MapHostHeartbeat> {
  /** 刷新已注册MapHost的低频负载与租约。 / Refreshes low-frequency load and lease state for a registered MapHost. */
  handle(scene: MapManagerScene, request: S2MM_MapHostHeartbeat): MM2S_MapHostHeartbeat {
    return scene.GetComponent(MapManagerComponent).Heartbeat(request);
  }
}

@rpcHandler(MapManagerScene, MapHostControlProtocol.DynamicMapDisposed)
export class DynamicMapDisposedHandler implements SceneRpcHandler<MapManagerScene, S2MM_DynamicMapDisposed, MM2S_DynamicMapDisposed> {
  /** 接收MapHost本地销毁完成通知，幂等更新Manager负载。 / Accepts idempotent local-disposal notifications and updates Manager load. */
  handle(scene: MapManagerScene, request: S2MM_DynamicMapDisposed): MM2S_DynamicMapDisposed {
    return scene.GetComponent(MapManagerComponent).DynamicMapDisposed(request);
  }
}

@rpcHandler(MapHostScene, MapHostControlProtocol.CreateAssigned)
export class CreateAssignedDynamicMapHandler implements SceneRpcHandler<MapHostScene, MM2M_CreateAssignedDynamicMap, M2MM_CreateAssignedDynamicMap> {
  /** 仅执行Manager已经分配好的实例，不在MapHost生成新ID或重新选择宿主。 / Executes the Manager assignment without generating another ID or selecting a host. */
  handle(scene: MapHostScene, request: MM2M_CreateAssignedDynamicMap): Promise<M2MM_CreateAssignedDynamicMap> {
    return scene.GetComponent(MapHostComponent).CreateAssignedDynamicMap(request);
  }
}
