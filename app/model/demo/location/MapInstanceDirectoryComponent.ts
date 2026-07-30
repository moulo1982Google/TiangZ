import { Component, RpcError, SystemErrCode } from "../../../core/public";
import { GameErrCode } from "../../game/protocol/GameErrCode";
import type {
  L2S_RegisterMapInstance,
  L2S_RemoveMapInstance,
  L2S_ResolveMapInstance,
  MapInstanceSnapshot,
  S2L_RegisterMapInstance,
  S2L_RemoveMapInstance,
  S2L_ResolveMapInstance,
} from "../../../generated/model/server/demo/protocol/messages";

/**
 * 保存地图实例到MapHost的低频路由，不保存玩家或地图业务状态。
 * 静态实例由启动配置预注册；动态实例由DynamicMapManager创建和删除。
 *
 * Stores low-frequency map-instance routes to MapHosts, never player or map
 * business state. Startup config registers static instances while
 * DynamicMapManager owns dynamic registration and removal.
 */
export class MapInstanceDirectoryComponent extends Component {
  private readonly instances = new Map<bigint, MapInstanceSnapshot>();

  /** 解析一次地图实例路由；普通玩家消息不走这里。 / Resolves a map-instance route; ordinary player messages never use this path. */
  Resolve(request: S2L_ResolveMapInstance): L2S_ResolveMapInstance {
    const instance = this.instances.get(request.mapInstanceId);
    return response(request.rpcId, {
      found: instance !== undefined,
      instance: instance ?? emptyInstance(),
    });
  }

  /** 幂等注册动态实例；同一ID指向不同模板或Host时拒绝覆盖。 / Idempotently registers a dynamic instance and rejects conflicting reuse. */
  Register(request: S2L_RegisterMapInstance): L2S_RegisterMapInstance {
    const existing = this.instances.get(request.instance.mapInstanceId);
    if (existing) {
      if (!sameInstance(existing, request.instance)) this.conflict(request.instance.mapInstanceId);
      return response(request.rpcId, { instance: existing, created: false });
    }
    this.Add(request.instance);
    return response(request.rpcId, { instance: request.instance, created: true });
  }

  /** 仅允许所属MapHost移除动态实例；静态实例只随部署配置变化。 / Removes only a dynamic instance owned by the expected MapHost; static routes follow deployment config. */
  Remove(request: S2L_RemoveMapInstance): L2S_RemoveMapInstance {
    const existing = this.instances.get(request.mapInstanceId);
    if (!existing) return response(request.rpcId, { removed: false });
    if (!existing.dynamic) {
      throw new RpcError(GameErrCode.StaticMapCannotDispose, "static map instances cannot be removed");
    }
    if (existing.mapHostName !== request.expectedMapHostName) {
      this.conflict(request.mapInstanceId);
    }
    this.instances.delete(request.mapInstanceId);
    return response(request.rpcId, { removed: true });
  }

  private Add(instance: MapInstanceSnapshot): void {
    if (instance.mapInstanceId <= 0n || instance.mapConfigId <= 0 || !instance.mapHostName) {
      throw new RpcError(SystemErrCode.MalformedFrame, "invalid map instance route");
    }
    const existing = this.instances.get(instance.mapInstanceId);
    if (existing && !sameInstance(existing, instance)) this.conflict(instance.mapInstanceId);
    this.instances.set(instance.mapInstanceId, instance);
  }

  private conflict(mapInstanceId: bigint): never {
    throw new RpcError(
      SystemErrCode.LocationConflict,
      `map instance route conflicts: ${mapInstanceId}`,
    );
  }

}

function response<T extends object>(rpcId: number | undefined, value: T): T & { rpcId?: number; error: number; message: string } {
  return { rpcId, error: 0, message: "", ...value };
}

function emptyInstance(): MapInstanceSnapshot {
  return { mapInstanceId: 0n, mapConfigId: 0, mapHostName: "", dynamic: false };
}

function sameInstance(left: MapInstanceSnapshot, right: MapInstanceSnapshot): boolean {
  return left.mapInstanceId === right.mapInstanceId &&
    left.mapConfigId === right.mapConfigId &&
    left.mapHostName === right.mapHostName &&
    left.dynamic === right.dynamic;
}
