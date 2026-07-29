import type { SceneMessageHelper } from "../../../core/public";
import type {
  L2S_CommitPlayerLocation,
  L2S_AllocatePlayerUnitId,
  L2S_LockPlayerLocation,
  L2S_RegisterPlayerLocation,
  L2S_RecoverPlayerLocations,
  L2S_RemovePlayerLocation,
  L2S_ResolvePlayerLocation,
  L2S_ResolvePlayerLocations,
  L2S_UnlockPlayerLocation,
  S2L_CommitPlayerLocation,
  S2L_AllocatePlayerUnitId,
  S2L_LockPlayerLocation,
  S2L_RegisterPlayerLocation,
  S2L_RecoverPlayerLocations,
  S2L_RemovePlayerLocation,
  S2L_ResolvePlayerLocation,
  S2L_ResolvePlayerLocations,
  S2L_UnlockPlayerLocation,
} from "../../../generated/model/server/demo/protocol/messages";
import { LocationProtocol } from "../../../generated/model/server/demo/protocol/rpcs";

/**
 * 隐藏Location Scene名称和RPC细节，业务只表达“注册、解析、切换、删除位置”。
 * 该Proxy不缓存记录；Gate的连接路由缓存由GatePlayerRoute单独负责。
 *
 * Hides Location Scene names and RPC details behind location operations.
 * It keeps no cache; GatePlayerRoute separately owns connection-route caching.
 */
export class LocationProxy {
  constructor(private readonly scenes: SceneMessageHelper) {}

  AllocateUnitId(request: S2L_AllocatePlayerUnitId): Promise<L2S_AllocatePlayerUnitId> {
    return this.scenes.callOne("Location", LocationProtocol.AllocateUnitId, request);
  }

  Register(request: S2L_RegisterPlayerLocation): Promise<L2S_RegisterPlayerLocation> {
    return this.scenes.callOne("Location", LocationProtocol.Register, request);
  }

  Resolve(request: S2L_ResolvePlayerLocation): Promise<L2S_ResolvePlayerLocation> {
    return this.scenes.callOne("Location", LocationProtocol.Resolve, request);
  }

  ResolveMany(request: S2L_ResolvePlayerLocations): Promise<L2S_ResolvePlayerLocations> {
    return this.scenes.callOne("Location", LocationProtocol.ResolveMany, request);
  }

  Lock(request: S2L_LockPlayerLocation): Promise<L2S_LockPlayerLocation> {
    return this.scenes.callOne("Location", LocationProtocol.Lock, request);
  }

  Commit(request: S2L_CommitPlayerLocation): Promise<L2S_CommitPlayerLocation> {
    return this.scenes.callOne("Location", LocationProtocol.Commit, request);
  }

  Unlock(request: S2L_UnlockPlayerLocation): Promise<L2S_UnlockPlayerLocation> {
    return this.scenes.callOne("Location", LocationProtocol.Unlock, request);
  }

  Remove(request: S2L_RemovePlayerLocation): Promise<L2S_RemovePlayerLocation> {
    return this.scenes.callOne("Location", LocationProtocol.Remove, request);
  }

  /** MapHost批量重报自己仍持有的权威Unit，仅用于Location内存目录恢复。 / Re-publishes authoritative Units owned by one MapHost solely for Location recovery. */
  RecoverOwner(request: S2L_RecoverPlayerLocations): Promise<L2S_RecoverPlayerLocations> {
    return this.scenes.callOne("Location", LocationProtocol.RecoverOwner, request);
  }
}
