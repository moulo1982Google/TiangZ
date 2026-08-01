import {
  Component,
  GlobalIdSystem,
  RpcError,
} from "../../../core/public";
import type {
  DynamicMapAssignmentSnapshot,
  M2MM_CreateAssignedDynamicMap,
  M2S_CreateDynamicMap,
  MM2S_MapHostHeartbeat,
  MM2S_RegisterMapHost,
  S2M_CreateDynamicMap,
  S2MM_MapHostHeartbeat,
  S2MM_RegisterMapHost,
} from "../../../generated/model/server/demo/protocol/messages";
import { MapHostControlProtocol } from "../../../generated/model/server/demo/protocol/rpcs";
import { GameErrCode } from "../../game/protocol/GameErrCode";
import {
  MapHostEndpointFromScene,
  SceneConfigFromMapHostEndpoint,
  SceneConfigFromMapInstance,
} from "../mapHost/MapHostEndpoint";
import type { SceneConfig } from "../../../core/public";

const MAP_HOST_LEASE_TIMEOUT_MS = 15_000;

interface MapHostRecord {
  endpoint: SceneConfig;
  generation: bigint;
  staticMapCount: number;
  dynamicMapCount: number;
  creatingCount: number;
  playerCount: number;
  lastHeartbeatAt: number;
}

interface CreationRecord {
  requestId: string;
  mapConfigId: number;
  mapInstanceId: bigint;
  mapHostName: string;
  active: boolean;
  inFlight?: Promise<void>;
}

/**
 * 动态地图的中央调度器：维护MapHost租约、选择宿主，并以业务requestId保证创建幂等。
 * 它不保存副本玩法数据，也不参与玩家传送；创建完成后业务仍只使用MapInstanceId。
 *
 * Central dynamic-map scheduler. It owns host leases, placement, and idempotent
 * creation by business request ID, but owns neither dungeon gameplay data nor
 * player transfer. Business code uses only the returned MapInstanceId.
 */
export class MapManagerComponent extends Component {
  private readonly hosts = new Map<string, MapHostRecord>();
  private readonly creations = new Map<string, CreationRecord>();

  /** 注册或刷新MapHost，并从仍存活的宿主恢复创建幂等关系。 / Registers a MapHost and recovers idempotency records from its live assignments. */
  Register(request: S2MM_RegisterMapHost): MM2S_RegisterMapHost {
    const endpoint = SceneConfigFromMapHostEndpoint(request.endpoint);
    const now = Date.now();
    const current = this.hosts.get(endpoint.name);
    if (
      current &&
      current.generation !== request.generation &&
      now - current.lastHeartbeatAt <= MAP_HOST_LEASE_TIMEOUT_MS
    ) {
      return response(request.rpcId, {
        accepted: false,
        leaseTimeoutMs: MAP_HOST_LEASE_TIMEOUT_MS,
      });
    }

    this.restoreAssignments(endpoint.name, request.assignments);
    this.hosts.set(endpoint.name, {
      endpoint,
      generation: request.generation,
      staticMapCount: request.staticMapCount,
      dynamicMapCount: request.dynamicMapCount,
      creatingCount: current?.generation === request.generation ? current.creatingCount : 0,
      playerCount: request.playerCount,
      lastHeartbeatAt: now,
    });
    this.owner.logger.info("map host registered", {
      mapHostName: endpoint.name,
      generation: request.generation.toString(),
      dynamicMapCount: request.dynamicMapCount,
      playerCount: request.playerCount,
    });
    return response(request.rpcId, {
      accepted: true,
      leaseTimeoutMs: MAP_HOST_LEASE_TIMEOUT_MS,
    });
  }

  /** 仅接受当前generation的心跳；旧进程不能覆盖已替换的MapHost。 / Accepts heartbeats only from the registered generation so stale processes cannot overwrite replacements. */
  Heartbeat(request: S2MM_MapHostHeartbeat): MM2S_MapHostHeartbeat {
    const host = this.hosts.get(request.mapHostName);
    if (!host || host.generation !== request.generation) {
      return response(request.rpcId, { registered: false });
    }
    host.staticMapCount = request.staticMapCount;
    host.dynamicMapCount = request.dynamicMapCount;
    host.playerCount = request.playerCount;
    host.lastHeartbeatAt = Date.now();
    return response(request.rpcId, { registered: true });
  }

  /**
   * 同一requestId并发或重试只创建一个实例；相同ID改用其他模板会明确报冲突。
   * 创建结果不因响应丢失而改变，失败重试仍向原宿主提交同一个MapInstanceId。
   *
   * Coalesces concurrent/retried requests into one instance. A reused request
   * ID with another config is rejected, and retries keep the assigned host and ID.
   */
  async Create(request: S2M_CreateDynamicMap): Promise<M2S_CreateDynamicMap> {
    const requestId = request.requestId.trim();
    if (!requestId) {
      throw new RpcError(GameErrCode.DynamicMapRequestRequired, "dynamic map requestId is required");
    }
    let creation = this.creations.get(requestId);
    if (creation && creation.mapConfigId !== request.mapConfigId) {
      throw new RpcError(
        GameErrCode.DynamicMapRequestConflict,
        `dynamic map requestId conflicts with map config: ${requestId}`,
      );
    }
    if (!creation) {
      const host = this.selectHost();
      creation = {
        requestId,
        mapConfigId: request.mapConfigId,
        mapInstanceId: GlobalIdSystem.Instance.Next(),
        mapHostName: host.endpoint.name,
        active: false,
      };
      this.creations.set(requestId, creation);
    }
    if (creation.active) return this.creationResponse(request.rpcId, creation);
    if (!creation.inFlight) {
      creation.inFlight = this.createOnAssignedHost(creation).finally(() => {
        creation!.inFlight = undefined;
      });
    }
    await creation.inFlight;
    return this.creationResponse(request.rpcId, creation);
  }

  private async createOnAssignedHost(
    creation: CreationRecord,
  ): Promise<void> {
    const host = this.requireActiveHost(creation.mapHostName);
    host.creatingCount += 1;
    try {
      const created: M2MM_CreateAssignedDynamicMap = await this.owner.scenes.call(
        host.endpoint,
        MapHostControlProtocol.CreateAssigned,
        {
          requestId: creation.requestId,
          mapConfigId: creation.mapConfigId,
          mapInstanceId: creation.mapInstanceId,
        },
      );
      if (
        created.instance.mapInstanceId !== creation.mapInstanceId ||
        created.instance.mapConfigId !== creation.mapConfigId ||
        created.instance.mapHostName !== creation.mapHostName
      ) {
        throw new RpcError(
          GameErrCode.DynamicMapRequestConflict,
          `MapHost returned a conflicting assignment: ${creation.requestId}`,
        );
      }
      const returnedHost = SceneConfigFromMapInstance(created.instance);
      if (
        returnedHost.ip !== host.endpoint.ip ||
        returnedHost.port !== host.endpoint.port ||
        returnedHost.protocol !== host.endpoint.protocol ||
        returnedHost.audience !== host.endpoint.audience
      ) {
        throw new RpcError(
          GameErrCode.DynamicMapRequestConflict,
          `MapHost returned a conflicting endpoint: ${creation.requestId}`,
        );
      }
      creation.active = true;
      host.dynamicMapCount += 1;
    } finally {
      host.creatingCount -= 1;
    }
  }

  private selectHost(): MapHostRecord {
    const now = Date.now();
    const candidates = [...this.hosts.values()]
      .filter((host) => now - host.lastHeartbeatAt <= MAP_HOST_LEASE_TIMEOUT_MS)
      .sort(
        (left, right) =>
          left.dynamicMapCount + left.creatingCount - right.dynamicMapCount - right.creatingCount ||
          left.playerCount - right.playerCount ||
          left.endpoint.name.localeCompare(right.endpoint.name),
      );
    if (candidates.length === 0) {
      throw new RpcError(GameErrCode.MapHostUnavailable, "no live MapHost is registered");
    }
    return candidates[0];
  }

  private requireActiveHost(name: string): MapHostRecord {
    const host = this.hosts.get(name);
    if (!host || Date.now() - host.lastHeartbeatAt > MAP_HOST_LEASE_TIMEOUT_MS) {
      throw new RpcError(GameErrCode.MapHostUnavailable, `assigned MapHost is unavailable: ${name}`);
    }
    return host;
  }

  private restoreAssignments(
    mapHostName: string,
    assignments: readonly DynamicMapAssignmentSnapshot[],
  ): void {
    for (const assignment of assignments) {
      const existing = this.creations.get(assignment.requestId);
      if (
        existing &&
        (existing.mapConfigId !== assignment.mapConfigId ||
          existing.mapInstanceId !== assignment.mapInstanceId ||
          existing.mapHostName !== mapHostName)
      ) {
        throw new RpcError(
          GameErrCode.DynamicMapRequestConflict,
          `recovered dynamic map assignment conflicts: ${assignment.requestId}`,
        );
      }
    }
    for (const assignment of assignments) {
      const existing = this.creations.get(assignment.requestId);
      if (existing) {
        existing.active = true;
        continue;
      }
      this.creations.set(assignment.requestId, {
        requestId: assignment.requestId,
        mapConfigId: assignment.mapConfigId,
        mapInstanceId: assignment.mapInstanceId,
        mapHostName,
        active: true,
      });
    }
  }

  private creationResponse(rpcId: number | undefined, creation: CreationRecord): M2S_CreateDynamicMap {
    const host = this.hosts.get(creation.mapHostName);
    if (!host) {
      throw new RpcError(
        GameErrCode.MapHostUnavailable,
        `assigned MapHost route is missing: ${creation.mapHostName}`,
      );
    }
    return response(rpcId, {
      instance: {
        mapInstanceId: creation.mapInstanceId,
        mapConfigId: creation.mapConfigId,
        mapHostName: creation.mapHostName,
        dynamic: true,
        mapHost: MapHostEndpointFromScene(host.endpoint),
      },
    });
  }

  private get owner() {
    return this.GetParent<import("../../../core/public").EntryScene>();
  }
}

function response<T extends object>(
  rpcId: number | undefined,
  value: T,
): T & { rpcId?: number; error: number; message: string } {
  return { rpcId, error: 0, message: "", ...value };
}
