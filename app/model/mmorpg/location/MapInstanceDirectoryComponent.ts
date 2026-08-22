import { Component, RpcError, SystemErrCode, type CustomMetricSnapshot } from "../../../core/public";
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
import { SceneConfigFromMapInstance } from "../mapHost/MapHostEndpoint";
import { MAP_ROUTE_RECOVERY_GRACE_MS } from "../mapHost/MapHostLease";

const MIN_DYNAMIC_ROUTE_LEASE_MS = 1_000;
const MAX_DYNAMIC_ROUTE_LEASE_MS = 120_000;

interface MapInstanceRoute {
  readonly instance: MapInstanceSnapshot;
  ownerGeneration: bigint;
  leaseExpiresAtMs: number;
}

/**
 * 保存地图实例到MapHost的低频路由，不保存玩家或地图业务状态。
 * 静态实例由启动配置预注册；动态实例由MapManager分配、MapHost创建和删除。
 *
 * Stores low-frequency map-instance routes to MapHosts, never player or map
 * business state. Startup config registers static instances while
 * MapManager assigns dynamic instances while MapHost registers and removes them.
 */
export class MapInstanceDirectoryComponent extends Component {
  private readonly instances = new Map<bigint, MapInstanceRoute>();
  private readonly recoveryGraceEndsAtMs = Date.now() + MAP_ROUTE_RECOVERY_GRACE_MS;
  private leaseRefreshes = 0;
  private expiredDynamic = 0;
  private conflicts = 0;

  /** 解析一次地图实例路由；普通玩家消息不走这里。 / Resolves a map-instance route; ordinary player messages never use this path. */
  Resolve(request: S2L_ResolveMapInstance): L2S_ResolveMapInstance {
    const instance = this.Get(request.mapInstanceId);
    return response(request.rpcId, {
      found: instance !== undefined,
      instance: instance ?? emptyInstance(),
    });
  }

  /** 幂等注册动态实例；同一ID指向不同模板或Host时拒绝覆盖。 / Idempotently registers a dynamic instance and rejects conflicting reuse. */
  Register(request: S2L_RegisterMapInstance): L2S_RegisterMapInstance {
    this.validateRegistration(request);
    const now = Date.now();
    const existing = this.instances.get(request.instance.mapInstanceId);
    if (existing) {
      if (!sameInstance(existing.instance, request.instance)) this.conflict(request.instance.mapInstanceId);
      if (request.ownerGeneration < existing.ownerGeneration) this.conflict(request.instance.mapInstanceId);
      if (request.instance.dynamic && request.ownerGeneration > existing.ownerGeneration && existing.leaseExpiresAtMs > now) {
        this.conflict(request.instance.mapInstanceId);
      }
      existing.leaseExpiresAtMs = request.instance.dynamic
        ? now + request.leaseTimeoutMs
        : Number.POSITIVE_INFINITY;
      existing.ownerGeneration = request.ownerGeneration;
      this.leaseRefreshes += 1;
      return response(request.rpcId, { instance: existing.instance, created: false });
    }
    this.Add(request.instance, request.ownerGeneration, request.leaseTimeoutMs, now);
    return response(request.rpcId, { instance: request.instance, created: true });
  }

  /** 仅允许所属MapHost移除动态实例；静态实例只随部署配置变化。 / Removes only a dynamic instance owned by the expected MapHost; static routes follow deployment config. */
  Remove(request: S2L_RemoveMapInstance): L2S_RemoveMapInstance {
    const existing = this.instances.get(request.mapInstanceId);
    if (!existing) return response(request.rpcId, { removed: false });
    if (!existing.instance.dynamic) {
      throw new RpcError(GameErrCode.StaticMapCannotDispose, "static map instances cannot be removed");
    }
    if (
      existing.instance.mapHostName !== request.expectedMapHostName ||
      existing.ownerGeneration !== request.expectedOwnerGeneration
    ) {
      this.conflict(request.mapInstanceId);
    }
    this.instances.delete(request.mapInstanceId);
    return response(request.rpcId, { removed: true });
  }

  private Add(
    instance: MapInstanceSnapshot,
    ownerGeneration: bigint,
    leaseTimeoutMs: number,
    now: number,
  ): void {
    if (instance.mapInstanceId <= 0n || instance.mapConfigId <= 0 || !instance.mapHostName) {
      throw new RpcError(SystemErrCode.MalformedFrame, "invalid map instance route");
    }
    SceneConfigFromMapInstance(instance);
    this.instances.set(instance.mapInstanceId, {
      instance,
      ownerGeneration,
      leaseExpiresAtMs: instance.dynamic ? now + leaseTimeoutMs : Number.POSITIVE_INFINITY,
    });
  }

  /** 返回Location内部使用的地图路由，不执行网络调用。 / Returns a map route for Location-internal composition without network I/O. */
  Get(mapInstanceId: bigint): MapInstanceSnapshot | undefined {
    const route = this.instances.get(mapInstanceId);
    if (!route) return undefined;
    if (route.instance.dynamic && route.leaseExpiresAtMs <= Date.now()) {
      this.instances.delete(mapInstanceId);
      this.expiredDynamic += 1;
      return undefined;
    }
    return route.instance;
  }

  /** Location刚启动时给MapHost一次完整恢复窗口，避免把尚未重报的有效玩家误判为副本丢失。 / Gives MapHosts one startup recovery window before a missing route is treated as lost. */
  IsRecovering(now = Date.now()): boolean {
    return now < this.recoveryGraceEndsAtMs;
  }

  /** 低频回收失去续租的动态路由；静态路由没有租约。 / Reclaims dynamic routes that stopped renewing; static routes do not expire. */
  SweepExpired(now = Date.now()): number {
    let removed = 0;
    for (const [mapInstanceId, route] of this.instances) {
      if (!route.instance.dynamic || route.leaseExpiresAtMs > now) continue;
      this.instances.delete(mapInstanceId);
      removed += 1;
    }
    this.expiredDynamic += removed;
    return removed;
  }

  /** 导出低基数路由租约指标。 / Exports low-cardinality route lease metrics. */
  Metrics(): CustomMetricSnapshot {
    let staticRoutes = 0;
    let dynamicRoutes = 0;
    for (const route of this.instances.values()) {
      if (route.instance.dynamic) dynamicRoutes += 1;
      else staticRoutes += 1;
    }
    return {
      name: "map_instance_directory",
      values: {
        static_routes: staticRoutes,
        dynamic_routes: dynamicRoutes,
        lease_refreshes_total: this.leaseRefreshes,
        expired_dynamic_total: this.expiredDynamic,
        conflicts_total: this.conflicts,
      },
      kinds: {
        lease_refreshes_total: "counter",
        expired_dynamic_total: "counter",
        conflicts_total: "counter",
      },
    };
  }

  private validateRegistration(request: S2L_RegisterMapInstance): void {
    if (request.ownerGeneration <= 0n) {
      throw new RpcError(SystemErrCode.MalformedFrame, "MapHost generation is required");
    }
    if (
      request.instance.dynamic &&
      (request.leaseTimeoutMs < MIN_DYNAMIC_ROUTE_LEASE_MS || request.leaseTimeoutMs > MAX_DYNAMIC_ROUTE_LEASE_MS)
    ) {
      throw new RpcError(SystemErrCode.MalformedFrame, "dynamic map route lease is out of range");
    }
    if (!request.instance.dynamic && request.leaseTimeoutMs !== 0) {
      throw new RpcError(SystemErrCode.MalformedFrame, "static map route must not use a lease");
    }
  }

  private conflict(mapInstanceId: bigint): never {
    this.conflicts += 1;
    throw new RpcError(
      SystemErrCode.LocationConflict,
      `map instance route conflicts: ${mapInstanceId}`,
    );
  }

  protected override Awake(): void {
    this.NewRepeatedTimer(5_000, "SweepExpired");
  }

  protected override OnDestroy(): void {
    this.instances.clear();
  }

}

function response<T extends object>(rpcId: number | undefined, value: T): T & { rpcId?: number; error: number; message: string } {
  return { rpcId, error: 0, message: "", ...value };
}

function emptyInstance(): MapInstanceSnapshot {
  return {
    mapInstanceId: 0n,
    mapConfigId: 0,
    mapHostName: "",
    dynamic: false,
    mapHost: emptyEndpoint(),
  };
}

function sameInstance(left: MapInstanceSnapshot, right: MapInstanceSnapshot): boolean {
  return left.mapInstanceId === right.mapInstanceId &&
    left.mapConfigId === right.mapConfigId &&
    left.mapHostName === right.mapHostName &&
    left.dynamic === right.dynamic &&
    left.mapHost.name === right.mapHost.name &&
    left.mapHost.ip === right.mapHost.ip &&
    left.mapHost.port === right.mapHost.port &&
    left.mapHost.protocol === right.mapHost.protocol &&
    left.mapHost.audience === right.mapHost.audience;
}

function emptyEndpoint() {
  return { name: "", ip: "", port: 0, protocol: "", audience: "" };
}
