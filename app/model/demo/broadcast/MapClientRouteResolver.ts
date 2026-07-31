import type {
  BroadcastRoute,
  ClientRouteResolver,
  MaybePromise,
} from "../../../core/public";
import type { PlayerLocationSnapshot } from "../../../generated/model/server/demo/protocol/messages";
import type { LocationProxy } from "../location/LocationProxy";

const DEFAULT_REMOTE_ROUTE_TTL_MS = 30_000;
const DEFAULT_MAX_REMOTE_ROUTES = 4_096;

interface CachedRoute {
  readonly gateName: string;
  readonly expiresAt: number;
}

/**
 * 优先同步解析本Map的Unit；跨地图关系成员只在缓存未命中时批量查询Location。
 * Gate在一次在线生命周期内稳定，因此短期缓存不会随地图传送失效；缓存有TTL和容量上限。
 *
 * Resolves map-local Units synchronously and batch-queries Location only for
 * uncached remote relationship members. Gate affinity stays stable during an
 * online lifetime, while TTL and capacity bounds prevent stale growth.
 */
export class MapClientRouteResolver implements ClientRouteResolver {
  private readonly remoteRoutes = new Map<number, CachedRoute>();

  constructor(
    private readonly localGate: (unitId: number) => string | undefined,
    private readonly location: LocationProxy,
    private readonly remoteRouteTtlMs = DEFAULT_REMOTE_ROUTE_TTL_MS,
    private readonly maxRemoteRoutes = DEFAULT_MAX_REMOTE_ROUTES,
  ) {
    if (!Number.isSafeInteger(remoteRouteTtlMs) || remoteRouteTtlMs <= 0) {
      throw new Error(`invalid remote route TTL: ${remoteRouteTtlMs}`);
    }
    if (!Number.isSafeInteger(maxRemoteRoutes) || maxRemoteRoutes <= 0) {
      throw new Error(`invalid remote route cache capacity: ${maxRemoteRoutes}`);
    }
  }

  Resolve(unitIds: readonly number[]): MaybePromise<readonly BroadcastRoute[]> {
    const now = Date.now();
    const routes: BroadcastRoute[] = [];
    const missing: number[] = [];
    for (const unitId of unitIds) {
      const local = this.localGate(unitId);
      if (local) {
        routes.push({ route: local, recipientId: unitId });
        continue;
      }
      const cached = this.remoteRoutes.get(unitId);
      if (cached && cached.expiresAt > now) {
        routes.push({ route: cached.gateName, recipientId: unitId });
      } else {
        if (cached) this.remoteRoutes.delete(unitId);
        missing.push(unitId);
      }
    }
    if (missing.length === 0) return routes;

    return this.location.ResolveMany({ unitIds: missing }).then((response) => {
      const locations = new Map(
        response.locations
          .filter(isActiveLocation)
          .map((location) => [location.unitId, location]),
      );
      for (const unitId of missing) {
        const location = locations.get(unitId);
        if (!location) continue;
        this.remember(unitId, location.gateName, now);
        routes.push({ route: location.gateName, recipientId: unitId });
      }
      routes.sort((left, right) => left.recipientId - right.recipientId);
      return routes;
    });
  }

  /** 主动丢弃已知下线成员；未知远端项仍会由TTL自动淘汰。 / Explicitly forgets a known offline member; other remote entries expire by TTL. */
  Forget(unitId: number): void {
    this.remoteRoutes.delete(unitId);
  }

  private remember(unitId: number, gateName: string, now: number): void {
    if (this.remoteRoutes.size >= this.maxRemoteRoutes && !this.remoteRoutes.has(unitId)) {
      this.prune(now);
      if (this.remoteRoutes.size >= this.maxRemoteRoutes) {
        const oldest = this.remoteRoutes.keys().next().value as number | undefined;
        if (oldest !== undefined) this.remoteRoutes.delete(oldest);
      }
    }
    this.remoteRoutes.set(unitId, {
      gateName,
      expiresAt: now + this.remoteRouteTtlMs,
    });
  }

  private prune(now: number): void {
    for (const [unitId, route] of this.remoteRoutes) {
      if (route.expiresAt <= now) this.remoteRoutes.delete(unitId);
    }
  }
}

function isActiveLocation(location: PlayerLocationSnapshot): boolean {
  return location.state === "active" && location.gateName.length > 0;
}
