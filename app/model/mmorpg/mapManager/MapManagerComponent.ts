import { NormalizePrivateRoster, SamePrivateRoster } from "../mapHost/MapAdmission";
import {
  Component,
  GlobalIdSystem,
  RpcError,
  type CustomMetricSnapshot,
} from "../../../core/public";
import type {
  DynamicMapAssignmentSnapshot,
  M2MM_CreateAssignedDynamicMap,
  M2S_CreateDynamicMap,
  MM2S_DynamicMapDisposed,
  MM2S_MapHostHeartbeat,
  MM2S_RegisterMapHost,
  S2M_CreateDynamicMap,
  S2MM_DynamicMapDisposed,
  S2MM_MapHostHeartbeat,
  S2MM_RegisterMapHost,
} from "../../../generated/model/server/demo/protocol/messages";
import { MapHostControlProtocol, PublicMapHostProtocol, DynamicMapProtocol } from "../../../generated/model/server/demo/protocol/rpcs";
import type { MM2S_AcquirePublicMap, PublicMapChannelSnapshot, S2MM_AcquirePublicMap } from "../../../generated/model/server/demo/protocol/messages";
import type { PublicMapPolicy } from "../mapHost/MapAdmission";
import { GameErrCode } from "../../game/protocol/GameErrCode";
import {
  MapHostEndpointFromScene,
  SceneConfigFromMapHostEndpoint,
  SceneConfigFromMapInstance,
} from "../mapHost/MapHostEndpoint";
import type { SceneConfig } from "../../../core/public";
import { MAP_HOST_LEASE_TIMEOUT_MS, MAP_HOST_REPORT_INTERVAL_MS } from "../mapHost/MapHostLease";

interface MapHostRecord {
  maxMaps: number;
  maxPlayers: number;
  mapConfigIds: readonly number[];
  endpoint: SceneConfig;
  generation: bigint;
  staticMapCount: number;
  dynamicMapCount: number;
  creatingCount: number;
  playerCount: number;
  lastHeartbeatAt: number;
}

interface CreationRecord {
  privateRoster?: { characterIds: bigint[] };
  channelId?: number;
  maxPlayers?: number;
  requestId: string;
  mapConfigId: number;
  mapInstanceId: bigint;
  mapHostName: string;
  mapHostGeneration: bigint;
  active: boolean;
  disposed: boolean;
  lost: boolean;
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
  private readonly publicRecoveryReadyAt = Date.now() + MAP_HOST_LEASE_TIMEOUT_MS;
  private readonly publicPolicies = new Map<number, PublicMapPolicy>();
  private readonly publicQueues = new Map<number, Promise<unknown>>();
  private readonly publicEmptySince = new Map<bigint, number>();
  private publicMaintenanceRunning = false;
  private readonly hosts = new Map<string, MapHostRecord>();
  private readonly creations = new Map<string, CreationRecord>();
  private readonly leaseMetrics = {
    registrations: 0,
    restoredAssignments: 0,
    expiredHosts: 0,
    lostMaps: 0,
  };

  protected override Awake(): void {
    this.NewRepeatedTimer(MAP_HOST_REPORT_INTERVAL_MS, "SweepExpiredMapHosts");
    this.NewRepeatedTimer(MAP_HOST_REPORT_INTERVAL_MS, "MaintainPublicMaps");
  }

  /** 注册或刷新MapHost，并从仍存活的宿主恢复创建幂等关系。 / Registers a MapHost and recovers idempotency records from its live assignments. */
  Register(request: S2MM_RegisterMapHost): MM2S_RegisterMapHost {
    const endpoint = SceneConfigFromMapHostEndpoint(request.endpoint);
    const now = Date.now();
    this.SweepExpiredMapHosts(now);
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

    this.restoreAssignments(endpoint.name, request.generation, request.assignments);
    const record: MapHostRecord = {
      endpoint,
      maxMaps: request.maxMaps ?? 0,
      maxPlayers: request.maxPlayers ?? 0,
      mapConfigIds: request.mapConfigIds ?? [],
      generation: request.generation,
      staticMapCount: request.staticMapCount,
      dynamicMapCount: request.dynamicMapCount,
      creatingCount: current?.generation === request.generation ? current.creatingCount : 0,
      playerCount: request.playerCount,
      lastHeartbeatAt: now,
    };
    if (current?.generation === request.generation) Object.assign(current, record);
    else this.hosts.set(endpoint.name, record);
    this.leaseMetrics.registrations += 1;
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
    host.maxMaps = request.maxMaps ?? 0;
    host.maxPlayers = request.maxPlayers ?? 0;
    host.mapConfigIds = request.mapConfigIds ?? [];
    host.lastHeartbeatAt = Date.now();
    return response(request.rpcId, { registered: true });
  }

  /**
   * 接收MapHost在本地Scene销毁成功后的通知，并减少宿主动态实例负载。
   * 同一通知可重复发送；未知实例视为已处理，方便Manager重启后的补偿上报。
   *
   * Accepts a notification after the MapHost has locally destroyed the Scene
   * and reduces the host's dynamic-instance load. Repeated notifications are
   * idempotent; an unknown instance is treated as acknowledged for recovery
   * after a Manager restart.
   */
  DynamicMapDisposed(request: S2MM_DynamicMapDisposed): MM2S_DynamicMapDisposed {
    const host = this.hosts.get(request.mapHostName);
    if (!host || host.generation !== request.generation) {
      return response(request.rpcId, { accepted: false });
    }
    const creation = this.creations.get(request.requestId);
    if (!creation) return response(request.rpcId, { accepted: true });
    if (
      creation.mapConfigId !== request.mapConfigId ||
      creation.mapInstanceId !== request.mapInstanceId ||
      creation.mapHostName !== request.mapHostName
    ) {
      throw new RpcError(
        GameErrCode.DynamicMapRequestConflict,
        `dynamic map disposal conflicts: ${request.requestId}`,
      );
    }
    if (!creation.disposed) {
      creation.active = false;
      creation.disposed = true;
      host.dynamicMapCount = Math.max(0, host.dynamicMapCount - 1);
      this.owner.logger.info("dynamic map disposed", {
        mapHostName: request.mapHostName,
        mapInstanceId: request.mapInstanceId.toString(),
        requestId: request.requestId,
      });
    }
    return response(request.rpcId, { accepted: true });
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
    const privateRoster = NormalizePrivateRoster(request.privateRoster);
    let creation = this.creations.get(requestId);
    if(privateRoster && !creation && Date.now()<this.publicRecoveryReadyAt) {
      throw new RpcError(GameErrCode.MapHostUnavailable,"private map directory is recovering; retry after host registration");
    }
    if (creation?.lost) {
      throw new RpcError(
        GameErrCode.DynamicMapLost,
        `dynamic map was lost with its MapHost; use a new operationId: ${requestId}`,
      );
    }
    if (creation?.disposed) {
      throw new RpcError(
        GameErrCode.DynamicMapRequestConflict,
        `dynamic map requestId was already disposed: ${requestId}`,
      );
    }
    if (creation && (creation.mapConfigId !== request.mapConfigId || !SamePrivateRoster(creation.privateRoster, privateRoster))) {
      throw new RpcError(
        GameErrCode.DynamicMapRequestConflict,
        `dynamic map requestId conflicts with map config: ${requestId}`,
      );
    }
    if (!creation) {
      const host = this.selectHost(request.mapConfigId);
      creation = {
        privateRoster,
        requestId,
        mapConfigId: request.mapConfigId,
        mapInstanceId: GlobalIdSystem.Instance.Next(),
        mapHostName: host.endpoint.name,
        mapHostGeneration: host.generation,
        active: false,
        disposed: false,
        lost: false,
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

  /** 只读查看幂等账本；启动恢复窗口中的未知请求不能推断为丢失。 / Inspects the idempotency ledger without treating unknown requests during recovery as lost. */
  Inspect(requestId:string): { state:string; mapInstanceId:bigint } {
    if(!requestId.trim())throw new RpcError(GameErrCode.DynamicMapRequestRequired,"dynamic map requestId is required");
    this.SweepExpiredMapHosts(Date.now());
    const creation=this.creations.get(requestId.trim());
    if(!creation)return {state:Date.now()<this.publicRecoveryReadyAt?"recovering":"unknown",mapInstanceId:0n};
    return {state:creation.disposed?"disposed":creation.lost?"lost":creation.active?"active":"creating",mapInstanceId:creation.mapInstanceId};
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
          channelId: creation.channelId,
          maxPlayers: creation.maxPlayers,
          privateRoster: NormalizePrivateRoster(creation.privateRoster),
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
        returnedHost.innerIp !== host.endpoint.innerIp ||
        returnedHost.port !== host.endpoint.port ||
        returnedHost.protocol !== host.endpoint.protocol ||
        returnedHost.audience !== host.endpoint.audience
      ) {
        throw new RpcError(
          GameErrCode.DynamicMapRequestConflict,
          `MapHost returned a conflicting endpoint: ${creation.requestId}`,
        );
      }
      if (
        this.hosts.get(creation.mapHostName) !== host ||
        host.generation !== creation.mapHostGeneration ||
        creation.lost
      ) {
        throw new RpcError(
          GameErrCode.DynamicMapLost,
          `assigned MapHost lease expired while creating: ${creation.mapHostName}`,
        );
      }
      if (!creation.active) host.dynamicMapCount += 1;
      creation.active = true;
    } finally {
      host.creatingCount -= 1;
    }
  }

  private selectHost(mapConfigId: number, packing = false, excluded = new Set<string>()): MapHostRecord {
    const now = Date.now();
    this.SweepExpiredMapHosts(now);
    const live=[...this.hosts.values()].filter(host=>now-host.lastHeartbeatAt<=MAP_HOST_LEASE_TIMEOUT_MS);
    const eligible=live.filter(host=>!excluded.has(host.endpoint.name)&&(!host.mapConfigIds.length||host.mapConfigIds.includes(mapConfigId)));
    const candidates=eligible
      .filter(host=>(!host.maxMaps||host.staticMapCount+host.dynamicMapCount+host.creatingCount<host.maxMaps)
        &&(!host.maxPlayers||host.playerCount<host.maxPlayers))
      .sort((left,right)=>(packing?-1:1)*(left.dynamicMapCount+left.creatingCount-right.dynamicMapCount-right.creatingCount)
        ||left.playerCount-right.playerCount||left.endpoint.name.localeCompare(right.endpoint.name));
    if(!candidates.length){
      if(eligible.length)throw new RpcError(GameErrCode.MapHostCapacity,`eligible MapHost capacity exhausted for map ${mapConfigId}`);
      throw new RpcError(GameErrCode.MapHostUnavailable,live.length?`no eligible MapHost for map ${mapConfigId}`:"no live MapHost is registered");
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
    generation: bigint,
    assignments: readonly DynamicMapAssignmentSnapshot[],
  ): void {
    for (const assignment of assignments) {
      NormalizePrivateRoster(assignment.privateRoster);
      if (assignment.privateRoster && assignment.channelId) throw new Error("public channel cannot have a private roster");
      const existing = this.creations.get(assignment.requestId);
      if (
        existing &&
        (existing.mapConfigId !== assignment.mapConfigId ||
          existing.mapInstanceId !== assignment.mapInstanceId ||
          existing.mapHostName !== mapHostName ||
          (existing.channelId ?? 0) !== (assignment.channelId ?? 0) ||
          (existing.maxPlayers ?? 0) !== (assignment.maxPlayers ?? 0) ||
          !SamePrivateRoster(existing.privateRoster, assignment.privateRoster))
      ) {
        throw new RpcError(
          GameErrCode.DynamicMapRequestConflict,
          `recovered dynamic map assignment conflicts: ${assignment.requestId}`,
        );
      }
      if (existing?.disposed) {
        throw new RpcError(
          GameErrCode.DynamicMapRequestConflict,
          `recovered disposed dynamic map assignment: ${assignment.requestId}`,
        );
      }
    }
    for (const assignment of assignments) {
      const existing = this.creations.get(assignment.requestId);
      if (existing) {
        existing.active = true;
        existing.lost = false;
        existing.mapHostGeneration = generation;
        this.leaseMetrics.restoredAssignments += 1;
        continue;
      }
      this.creations.set(assignment.requestId, {
        requestId: assignment.requestId,
        mapConfigId: assignment.mapConfigId,
        mapInstanceId: assignment.mapInstanceId,
        mapHostName,
        mapHostGeneration: generation,
        channelId: assignment.channelId,
        maxPlayers: assignment.maxPlayers,
        privateRoster: NormalizePrivateRoster(assignment.privateRoster),
        active: true,
        disposed: false,
        lost: false,
      });
      this.leaseMetrics.restoredAssignments += 1;
    }
  }

  private creationResponse(rpcId: number | undefined, creation: CreationRecord): M2S_CreateDynamicMap {
    const host = this.hosts.get(creation.mapHostName);
    if (!host || host.generation !== creation.mapHostGeneration || creation.lost) {
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

  /** 启动时由游戏登记公共地图规则；规则不允许在在线实例上隐式变更。 / Registers game-owned public-map policy at startup without mutating live instance rules. */
  ConfigurePublicMaps(policies: readonly PublicMapPolicy[]): void {
    const ids = new Set<number>();
    for (const policy of policies) {
      if (!Number.isSafeInteger(policy.mapConfigId) || policy.mapConfigId <= 0
        || !Number.isSafeInteger(policy.maxPlayers) || policy.maxPlayers <= 0
        || !Number.isSafeInteger(policy.minChannels) || policy.minChannels < 1
        || !Number.isSafeInteger(policy.idleTimeoutMs) || policy.idleTimeoutMs < 30_000
        || ids.has(policy.mapConfigId) || this.publicPolicies.has(policy.mapConfigId)) throw new Error("invalid or duplicate public map policy");
      ids.add(policy.mapConfigId);
    }
    for (const policy of policies) this.publicPolicies.set(policy.mapConfigId, { ...policy });
  }

  /** 按模板串行选择及预留，避免并发满线时重复创建大量实例。 / Serializes selection and reservation per template to prevent channel creation stampedes. */
  AcquirePublicMap(request: S2MM_AcquirePublicMap): Promise<MM2S_AcquirePublicMap> {
    if (request.characterId <= 0n) throw new Error("character identity is required");
    return this.WithPublicMap(request.mapConfigId, async () => {
      const policy = this.RequirePublicPolicy(request.mapConfigId);
      const channels = this.PublicCreations(request.mapConfigId).sort((a, b) =>
        Number(b.mapInstanceId === request.preferredInstanceId) - Number(a.mapInstanceId === request.preferredInstanceId)
        || a.channelId! - b.channelId!);
      for (const channel of channels) {
        const acquired = await this.ReserveChannel(channel, request);
        if (acquired) return acquired;
      }
      const created = await this.CreatePublicChannel(policy);
      const acquired = await this.ReserveChannel(created, request);
      if (acquired) return acquired;
      throw new RpcError(GameErrCode.PublicMapUnavailable, "public map capacity unavailable; retry admission");
    });
  }

  /** 返回宿主确认的分线快照；未知或失去租约的实例不会出现在目录中。 / Lists host-confirmed channels while excluding lost leases and unready instances. */
  async ListPublicMaps(mapConfigId: number): Promise<PublicMapChannelSnapshot[]> {
    this.RequirePublicPolicy(mapConfigId);
    const channels: PublicMapChannelSnapshot[] = [];
    for (const creation of this.PublicCreations(mapConfigId)) {
      if (!creation.active) continue;
      const host = this.requireActiveHost(creation.mapHostName);
      const status = await this.owner.scenes.call(host.endpoint, PublicMapHostProtocol.Status, { mapInstanceId: creation.mapInstanceId });
      if (!status.found) continue;
      channels.push({ instance: this.creationResponse(undefined, creation).instance,
        channelId: creation.channelId!, maxPlayers: creation.maxPlayers!, playerCount: status.playerCount, reservedCount: status.reservedCount });
    }
    return channels.sort((a, b) => a.channelId - b.channelId);
  }

  /** 维持最低分线数并回收连续空闲的额外分线；预留和准备中玩家均阻止回收。 / Maintains minimum channels and reclaims idle extras; reservations and staged players prevent reclamation. */
  protected async MaintainPublicMaps(): Promise<void> {
    if (this.publicMaintenanceRunning || Date.now() < this.publicRecoveryReadyAt) return;
    this.publicMaintenanceRunning = true;
    try {
      for (const policy of this.publicPolicies.values()) {
        try {
          await this.WithPublicMap(policy.mapConfigId, async () => {
            while (this.PublicCreations(policy.mapConfigId).length < policy.minChannels) await this.CreatePublicChannel(policy);
            const channels = await this.ListPublicMaps(policy.mapConfigId);
            let remaining = channels.length;
            for (const channel of channels.reverse()) {
              const id = channel.instance.mapInstanceId;
              if (channel.playerCount + channel.reservedCount > 0) { this.publicEmptySince.delete(id); continue; }
              const since = this.publicEmptySince.get(id) ?? Date.now();
              this.publicEmptySince.set(id, since);
              if (remaining <= policy.minChannels || Date.now() - since < policy.idleTimeoutMs) continue;
              const creation = [...this.creations.values()].find(value => value.mapInstanceId === id)!;
              const host = this.requireActiveHost(creation.mapHostName);
              const result = await this.owner.scenes.call(host.endpoint, DynamicMapProtocol.Dispose, { mapInstanceId: id });
              if (result.disposed) {
                if (!creation.disposed) host.dynamicMapCount = Math.max(0, host.dynamicMapCount - 1);
                creation.active = false; creation.disposed = true;
                this.publicEmptySince.delete(id); remaining -= 1;
              }
            }
          });
        } catch (error) { this.owner.logger.warn("public map maintenance deferred", { mapConfigId: policy.mapConfigId, error }); }
      }
    } finally { this.publicMaintenanceRunning = false; }
  }

  /** 隔离不同模板的异步创建与回收顺序，失败不会毒化后续队列。 / Orders creation and reclamation per template without poisoning the queue after failure. */
  private WithPublicMap<T>(mapConfigId: number, body: () => Promise<T>): Promise<T> {
    const previous = this.publicQueues.get(mapConfigId) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(body);
    this.publicQueues.set(mapConfigId, work);
    void work.finally(() => { if (this.publicQueues.get(mapConfigId) === work) this.publicQueues.delete(mapConfigId); }).catch(() => undefined);
    return work;
  }

  /** 只使用已登记的业务地图规则。 / Requires a registered business map policy. */
  private RequirePublicPolicy(mapConfigId: number): PublicMapPolicy {
    if (Date.now() < this.publicRecoveryReadyAt) throw new RpcError(GameErrCode.PublicMapUnavailable, "public map directory is recovering; retry after host registration");
    const policy = this.publicPolicies.get(mapConfigId);
    if (!policy) throw new RpcError(GameErrCode.PublicMapUnavailable, "public map policy not configured");
    return policy;
  }

  /** 读取仍有租约的公共实例，包括响应不确定而需重试的创建。 / Reads live public assignments including creations with uncertain responses. */
  private PublicCreations(mapConfigId: number): CreationRecord[] {
    this.SweepExpiredMapHosts();
    return [...this.creations.values()].filter(value => value.mapConfigId === mapConfigId && value.channelId && !value.lost && !value.disposed);
  }

  /** 复用统一实例创建和Location注册流程，公共分线仅附加准入元数据。 / Reuses instance creation and Location registration with public admission metadata. */
  private async CreatePublicChannel(policy: PublicMapPolicy): Promise<CreationRecord> {
    const excluded = new Set<string>();
    for (;;) {
      const host = this.selectHost(policy.mapConfigId, true, excluded);
      const channelId = 1 + Math.max(0, ...[...this.creations.values()].filter(c => c.mapConfigId === policy.mapConfigId).map(c => c.channelId ?? 0));
      const mapInstanceId = GlobalIdSystem.Instance.Next();
      const creation: CreationRecord = { requestId: `public:${mapInstanceId}`, mapConfigId: policy.mapConfigId,
        mapInstanceId, mapHostName: host.endpoint.name, mapHostGeneration: host.generation,
        channelId, maxPlayers: policy.maxPlayers, active: false, disposed: false, lost: false };
      this.creations.set(creation.requestId, creation);
      try {
        await this.createOnAssignedHost(creation);
        return creation;
      } catch (error) {
        if (!(error instanceof RpcError) || error.code !== GameErrCode.MapHostCapacity) throw error;
        // 只有宿主明确在创建前拒绝容量才允许换宿主；超时保持原分配供重试。
        // Only a definite pre-creation capacity rejection permits replacement; timeouts retain their original assignment.
        creation.disposed = true;
        excluded.add(host.endpoint.name);
      }
    }
  }

  /** 只在目标宿主确认预留之后返回可用实例；通信结果不确定时不跨线重复分配。 / Returns an instance only after host admission; uncertain RPCs never trigger speculative fallback. */
  private async ReserveChannel(creation: CreationRecord, request: S2MM_AcquirePublicMap): Promise<MM2S_AcquirePublicMap | undefined> {
    if (!creation.active) await this.createOnAssignedHost(creation);
    const host = this.requireActiveHost(creation.mapHostName);
    const reserved = await this.owner.scenes.call(host.endpoint, PublicMapHostProtocol.Reserve,
      { mapInstanceId: creation.mapInstanceId, characterId: request.characterId });
    if (reserved.hostOccupied !== undefined) host.playerCount = reserved.hostOccupied;
    if (!reserved.accepted) return undefined;
    this.publicEmptySince.delete(creation.mapInstanceId);
    return response(request.rpcId, { instance: this.creationResponse(undefined, creation).instance,
      channelId: creation.channelId!, expiresAtMs: reserved.expiresAtMs });
  }

  /**
   * 回收失去心跳的MapHost并把其动态实例标为lost；同requestId不得静默创建第二份副本。
   * Reclaims expired MapHosts and marks their dynamic instances lost. The same
   * request ID must never silently create a second instance after host loss.
   */
  protected SweepExpiredMapHosts(now = Date.now()): number {
    let removed = 0;
    for (const [name, host] of this.hosts) {
      if (now - host.lastHeartbeatAt <= MAP_HOST_LEASE_TIMEOUT_MS) continue;
      this.hosts.delete(name);
      removed += 1;
      this.leaseMetrics.expiredHosts += 1;
      for (const creation of this.creations.values()) {
        if (
          creation.mapHostName !== name ||
          creation.mapHostGeneration !== host.generation ||
          creation.disposed ||
          creation.lost
        ) continue;
        creation.active = false;
        creation.lost = true;
        this.leaseMetrics.lostMaps += 1;
      }
      this.owner.logger.warn("MapHost lease expired", {
        mapHostName: name,
        generation: host.generation.toString(),
      });
    }
    return removed;
  }

  /** 导出MapManager宿主租约和副本丢失指标。 / Exports MapManager host-lease and lost-instance metrics. */
  Metrics(): CustomMetricSnapshot {
    let activeMaps = 0;
    let lostMaps = 0;
    for (const creation of this.creations.values()) {
      if (creation.active) activeMaps += 1;
      if (creation.lost) lostMaps += 1;
    }
    return {
      name: "map_manager_lease",
      values: {
        active_hosts: this.hosts.size,
        active_maps: activeMaps,
        lost_maps: lostMaps,
        registrations_total: this.leaseMetrics.registrations,
        restored_assignments_total: this.leaseMetrics.restoredAssignments,
        expired_hosts_total: this.leaseMetrics.expiredHosts,
        lost_maps_total: this.leaseMetrics.lostMaps,
      },
      kinds: {
        registrations_total: "counter",
        restored_assignments_total: "counter",
        expired_hosts_total: "counter",
        lost_maps_total: "counter",
      },
    };
  }

  protected override OnDestroy(): void {
    this.hosts.clear();
    this.creations.clear();
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
