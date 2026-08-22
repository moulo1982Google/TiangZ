import {
  type L2S_CommitPlayerLocation,
  type L2S_AllocatePlayerUnitId,
  type L2S_LockPlayerLocation,
  type L2S_RegisterPlayerLocation,
  type L2S_RecoverPlayerLocations,
  type L2S_RebindPlayerGate,
  type L2S_RemovePlayerLocation,
  type L2S_ResolvePlayerLocation,
  type L2S_ResolvePlayerLocations,
  type L2S_UnlockPlayerLocation,
  LocationComponent,
  MapInstanceDirectoryComponent,
  MapInstanceProtocol,
  LocationProtocol,
  LocationScene,
  rpcHandler,
  type S2L_CommitPlayerLocation,
  type S2L_AllocatePlayerUnitId,
  type S2L_LockPlayerLocation,
  type S2L_RegisterPlayerLocation,
  type S2L_RecoverPlayerLocations,
  type S2L_RebindPlayerGate,
  type S2L_RemovePlayerLocation,
  type S2L_ResolvePlayerLocation,
  type S2L_ResolvePlayerLocations,
  type S2L_UnlockPlayerLocation,
  type SceneRpcHandler,
  type S2L_RegisterMapInstance,
  type L2S_RegisterMapInstance,
  type S2L_RemoveMapInstance,
  type L2S_RemoveMapInstance,
  type S2L_ResolveMapInstance,
  type L2S_ResolveMapInstance,
} from "#tiangz/model";

@rpcHandler(LocationScene, LocationProtocol.AllocateUnitId)
export class AllocatePlayerUnitIdHandler implements SceneRpcHandler<LocationScene, S2L_AllocatePlayerUnitId, L2S_AllocatePlayerUnitId> {
  handle(scene: LocationScene, request: S2L_AllocatePlayerUnitId): L2S_AllocatePlayerUnitId {
    return scene.GetComponent(LocationComponent).AllocateUnitId(request);
  }
}

@rpcHandler(LocationScene, LocationProtocol.Register)
export class RegisterPlayerLocationHandler implements SceneRpcHandler<LocationScene, S2L_RegisterPlayerLocation, L2S_RegisterPlayerLocation> {
  handle(scene: LocationScene, request: S2L_RegisterPlayerLocation): L2S_RegisterPlayerLocation {
    return scene.GetComponent(LocationComponent).Register(request);
  }
}

@rpcHandler(LocationScene, LocationProtocol.Resolve)
export class ResolvePlayerLocationHandler implements SceneRpcHandler<LocationScene, S2L_ResolvePlayerLocation, L2S_ResolvePlayerLocation> {
  handle(scene: LocationScene, request: S2L_ResolvePlayerLocation): L2S_ResolvePlayerLocation {
    return scene.GetComponent(LocationComponent).Resolve(request);
  }
}

@rpcHandler(LocationScene, LocationProtocol.ResolveMany)
export class ResolvePlayerLocationsHandler implements SceneRpcHandler<LocationScene, S2L_ResolvePlayerLocations, L2S_ResolvePlayerLocations> {
  handle(scene: LocationScene, request: S2L_ResolvePlayerLocations): L2S_ResolvePlayerLocations {
    return scene.GetComponent(LocationComponent).ResolveMany(request);
  }
}

@rpcHandler(LocationScene, LocationProtocol.Lock)
export class LockPlayerLocationHandler implements SceneRpcHandler<LocationScene, S2L_LockPlayerLocation, L2S_LockPlayerLocation> {
  handle(scene: LocationScene, request: S2L_LockPlayerLocation): L2S_LockPlayerLocation {
    return scene.GetComponent(LocationComponent).Lock(request);
  }
}

@rpcHandler(LocationScene, LocationProtocol.Commit)
export class CommitPlayerLocationHandler implements SceneRpcHandler<LocationScene, S2L_CommitPlayerLocation, L2S_CommitPlayerLocation> {
  handle(scene: LocationScene, request: S2L_CommitPlayerLocation): L2S_CommitPlayerLocation {
    return scene.GetComponent(LocationComponent).Commit(request);
  }
}

@rpcHandler(LocationScene, LocationProtocol.RebindGate)
export class RebindPlayerGateHandler implements SceneRpcHandler<LocationScene, S2L_RebindPlayerGate, L2S_RebindPlayerGate> {
  handle(scene: LocationScene, request: S2L_RebindPlayerGate): L2S_RebindPlayerGate {
    return scene.GetComponent(LocationComponent).RebindGate(request);
  }
}

@rpcHandler(LocationScene, LocationProtocol.Unlock)
export class UnlockPlayerLocationHandler implements SceneRpcHandler<LocationScene, S2L_UnlockPlayerLocation, L2S_UnlockPlayerLocation> {
  handle(scene: LocationScene, request: S2L_UnlockPlayerLocation): L2S_UnlockPlayerLocation {
    return scene.GetComponent(LocationComponent).Unlock(request);
  }
}

@rpcHandler(LocationScene, LocationProtocol.Remove)
export class RemovePlayerLocationHandler implements SceneRpcHandler<LocationScene, S2L_RemovePlayerLocation, L2S_RemovePlayerLocation> {
  handle(scene: LocationScene, request: S2L_RemovePlayerLocation): L2S_RemovePlayerLocation {
    return scene.GetComponent(LocationComponent).Remove(request);
  }
}

@rpcHandler(LocationScene, LocationProtocol.RecoverOwner)
export class RecoverPlayerLocationsHandler implements SceneRpcHandler<LocationScene, S2L_RecoverPlayerLocations, L2S_RecoverPlayerLocations> {
  handle(scene: LocationScene, request: S2L_RecoverPlayerLocations): L2S_RecoverPlayerLocations {
    return scene.GetComponent(LocationComponent).RecoverOwner(request);
  }
}

@rpcHandler(LocationScene, MapInstanceProtocol.Resolve)
export class ResolveMapInstanceHandler implements SceneRpcHandler<LocationScene, S2L_ResolveMapInstance, L2S_ResolveMapInstance> {
  handle(scene: LocationScene, request: S2L_ResolveMapInstance): L2S_ResolveMapInstance {
    return scene.GetComponent(MapInstanceDirectoryComponent).Resolve(request);
  }
}

@rpcHandler(LocationScene, MapInstanceProtocol.Register)
export class RegisterMapInstanceHandler implements SceneRpcHandler<LocationScene, S2L_RegisterMapInstance, L2S_RegisterMapInstance> {
  handle(scene: LocationScene, request: S2L_RegisterMapInstance): L2S_RegisterMapInstance {
    return scene.GetComponent(MapInstanceDirectoryComponent).Register(request);
  }
}

@rpcHandler(LocationScene, MapInstanceProtocol.Remove)
export class RemoveMapInstanceHandler implements SceneRpcHandler<LocationScene, S2L_RemoveMapInstance, L2S_RemoveMapInstance> {
  handle(scene: LocationScene, request: S2L_RemoveMapInstance): L2S_RemoveMapInstance {
    return scene.GetComponent(MapInstanceDirectoryComponent).Remove(request);
  }
}
