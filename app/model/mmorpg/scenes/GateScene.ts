import {
  EntryScene,
  GlobalIdSystem,
  RpcError,
  SystemErrCode,
  TimeSystem,
  TimerSystem,
  entryScene,
  message,
  rpc,
  type CustomMetricSnapshot,
  type RuntimeEntrySceneConfig,
  type SceneMetricsSnapshot,
  type TimerId,
} from "../../../core/public";
import { GameErrCode } from "../../game/protocol/GameErrCode";
import {
  type C2G_EnterMap,
  type C2G_EnterStarterDungeon,
  type C2G_MapSnapshotReady,
  type C2G_LoginGate,
  type G2C_EnterMap,
  type G2C_EnterStarterDungeon,
  type G2C_MapSnapshotReady,
  type G2C_LoginGate,
  type G2C_Ping,
  type G2C_MapReady,
  type G2C_SessionReplaced,
  type G2S_ProbeGate,
  type G2M_EnterMap,
  type G2M_ClaimStarterDungeonEntry,
  type G2M_InitialSnapshot,
  type G2M_PlayerOffline,
  type G2M_RebindPlayerGate,
  type G2M_SecondEnterMap,
  type G2M_TransferPlayer,
  type M2G_EnterMap,
  type M2G_ClaimStarterDungeonEntry,
  type M2G_InitialSnapshot,
  type M2G_KickPlayers,
  type M2G_MapReady,
  type M2G_RebindPlayerGate,
  type M2G_SecondEnterMap,
  type M2G_TransferPlayer,
  type S2G_ClientBroadcast,
  type S2G_ClientBroadcastBatch,
  type S2G_ProbeGate,
  type PlayerLocationSnapshot,
} from "../../../generated/model/server/demo/protocol/messages";
import {
  ClientMessages,
  GateMessages,
} from "../../../generated/model/server/demo/protocol/messageDescriptors";
import { GateProtocol, MapProtocol } from "../../../generated/model/server/demo/protocol/rpcs";
import { GameConfigs } from "../../../generated/model/config";
import { GatePlayerRoute, type GatePlayerMapLocation } from "../gate/GatePlayerRoute";
import { IsGateReachable } from "../gate/GateHealth";
import { GateSession } from "../gate/GateSession";
import { DecodeLoginToken } from "../login/LoginToken";
import { LocationProxy } from "../location/LocationProxy";
import {
  EntrySyncMode,
  ParseEntrySyncMode,
  type EntrySyncModeValue,
} from "../map/EntrySyncMode";
import { MAP_ENTRY_ADMISSION_TIMEOUT_MS } from "../map/MapEntryAdmission";
import {
  SceneConfigFromMapHostEndpoint,
  SceneConfigFromMapInstance,
} from "../mapHost/MapHostEndpoint";
import { DynamicMapProxy } from "../mapHost/DynamicMapProxy";
import { STARTER_DUNGEON_MAP_CONFIG_ID } from "../dungeon/StarterDungeon";

export const GATE_CLIENT_TIMEOUT_MS = 30_000;
export const GATE_RECONNECT_GRACE_MS = 30_000;
const GATE_TIMEOUT_SWEEP_MS = 1_000;
const GATE_CONNECTION_LOCK = "GateConnection";
const GATE_PLAYER_LOCK = "GatePlayer";

export interface ServerSpawnOverride {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
}

interface MapResumeResult {
  readonly response?: G2C_EnterMap;
  readonly routeLost: boolean;
}

@entryScene()
export class GateScene extends EntryScene {
  protected override readonly mailbox = "unordered" as const;

  private readonly routesByAccount = new Map<string, GatePlayerRoute>();
  private readonly routesByConnection = new Map<number, GatePlayerRoute>();
  private readonly routesByUnitId = new Map<number, GatePlayerRoute>();
  // 下行广播只需要当前连接号；保留独立索引，避免每个广播批次再次解引用长期路由对象。
  // Downstream broadcast only needs the connection id; keep a direct index so hot batches do not dereference the long-lived route object.
  private readonly connectionIdsByUnitId = new Map<number, number>();
  private readonly disconnecting = new Set<number>();
  private readonly finalOfflinePending = new Set<string>();
  private readonly location: LocationProxy;
  private readonly dynamicMaps: DynamicMapProxy;
  private readonly gateTakeoverMetrics = {
    attempts: 0,
    succeeded: 0,
    rejectedOwnerAlive: 0,
    failed: 0,
  };
  private readonly dynamicFallbackMetrics = {
    attempts: 0,
    completed: 0,
    failed: 0,
  };
  private timeoutSweepTimer = 0 as TimerId;

  constructor(config: RuntimeEntrySceneConfig) {
    super(config);
    this.location = new LocationProxy(this.scenes);
    this.dynamicMaps = new DynamicMapProxy(this.scenes);
    if (this.scenes.many("MapHost").length === 0) {
      throw new Error("GateScene needs at least one known MapHostScene");
    }
  }

  /** 在Gate常规Scene指标之外暴露迁移屏障积压和结果计数。 / Adds transfer-barrier backlog and outcome counters to regular Gate Scene metrics. */
  override metricsSnapshot(): SceneMetricsSnapshot {
    const metrics = super.metricsSnapshot();
    metrics.customMetrics.push(this.actorTransferMetricSnapshot());
    metrics.customMetrics.push(this.GateTakeoverMetricSnapshot());
    metrics.customMetrics.push(this.DynamicFallbackMetricSnapshot());
    return metrics;
  }

  /** 供Login和其他Gate做低成本存活探测；不暴露玩家状态。 / Lets Login and peer Gates probe liveness without exposing player state. */
  @rpc(GateProtocol.Probe)
  private Probe(_request: S2G_ProbeGate): G2S_ProbeGate {
    return { gateName: this.self.name };
  }

  /** 启动一个Gate级合并扫描器；不会为每名玩家创建独立Timer。 / Starts one Gate-level sweep instead of allocating one Timer per player. */
  protected override onStart(): void {
    this.timeoutSweepTimer = TimerSystem.Instance.NewRepeatedTimer(
      GATE_TIMEOUT_SWEEP_MS,
      () => this.SweepClientTimeouts(),
    );
  }

  /** 任意合法或非法客户端帧到达Gate时刷新当前连接的入站活动。 / Refreshes inbound activity whenever a client frame reaches Gate. */
  protected override onClientReceive(connectionId: number): void {
    this.routesByConnection
      .get(connectionId)
      ?.TouchReceive(connectionId, TimeSystem.Instance.FrameTime);
  }

  /** 记录可靠消息和RPC响应的出站排队时间；高频latest状态只保留聚合通道指标。 / Records reliable messages and RPC responses; high-frequency latest state uses aggregate lane metrics only. */
  protected override onClientSendQueued(connectionIds: readonly number[]): void {
    const now = TimeSystem.Instance.FrameTime;
    for (const connectionId of connectionIds) {
      this.routesByConnection.get(connectionId)?.TouchSend(connectionId, now);
    }
  }

  /** 物理连接断开只销毁Session并进入重连宽限，不立即移除Map中的Unit。 / Transport loss disposes only the Session and starts reconnect grace without removing the Map Unit. */
  protected override onDisconnect(connectionId: number): void | Promise<void> {
    this.disconnecting.delete(connectionId);
    this.actorLocations.unbindConnection(connectionId);

    const route = this.routesByConnection.get(connectionId);
    if (!route) return;
    return this.Locks.RunExclusive(
      GATE_PLAYER_LOCK,
      route.account,
      () => this.DetachConnection(route, connectionId),
      { timeoutMs: 0 },
    );
  }

  /** 在玩家锁内分离物理连接，旧连接的迟到断线不能覆盖新连接。 / Detaches a physical connection under the player lock so a stale close cannot overwrite a replacement. */
  private DetachConnection(route: GatePlayerRoute, connectionId: number): void {
    if (this.routesByConnection.get(connectionId) === route) {
      this.routesByConnection.delete(connectionId);
    }
    if (!route.Detach(connectionId, TimeSystem.Instance.FrameTime)) return;
    const unitId = route.map?.unitId;
    if (unitId !== undefined && this.connectionIdsByUnitId.get(unitId) === connectionId) {
      this.connectionIdsByUnitId.delete(unitId);
    }

    this.logger.info("client connection entered reconnect grace", {
      account: route.account,
      unitId: route.map?.unitId,
      connectionId,
      graceMs: GATE_RECONNECT_GRACE_MS,
    });
  }

  /** Gate停机只关闭自身连接；MapHost的优雅停机负责保存权威玩家数据。 / Gate shutdown closes owned connections while MapHost graceful shutdown persists authoritative player data. */
  protected override onStop(): void {
    if (this.timeoutSweepTimer !== 0) {
      TimerSystem.Instance.Cancel(this.timeoutSweepTimer, "scene-stopped", false);
      this.timeoutSweepTimer = 0 as TimerId;
    }
    for (const route of [...this.routesByAccount.values()]) {
      route.BeginRemoving();
      const connectionId = route.connectionId;
      this.RemoveRoute(route);
      if (connectionId === undefined || this.disconnecting.has(connectionId)) continue;
      this.disconnecting.add(connectionId);
      this.disconnectClient(connectionId);
    }
  }

  protected override createSession(connectionId: number): GateSession {
    return this.addSession(connectionId, GateSession);
  }

  /**
   * 认证连接并把它附着到账号的长期Gate路由。
   * 新连接会替换旧连接；旧socket迟到的disconnect不能清理新连接或Map Unit。
   *
   * Authenticates and attaches a connection to the account's long-lived Gate
   * route. A replacement connection supersedes the old one, whose late close
   * event cannot remove the replacement or the Map Unit.
   */
  async LoginGate(session: GateSession, request: C2G_LoginGate): Promise<G2C_LoginGate> {
    if (!request.account) {
      throw new RpcError(GameErrCode.AccountRequired, "account is required");
    }
    if (!request.token) {
      throw new RpcError(GameErrCode.TokenRequired, "token is required");
    }
    const connectionId = session.ConnectionId;
    return await this.Locks.RunExclusive(
      GATE_CONNECTION_LOCK,
      connectionId,
      () => this.Locks.RunExclusive(
        GATE_PLAYER_LOCK,
        request.account,
        () => this.LoginGateLocked(session, request),
        { timeoutMs: MAP_ENTRY_ADMISSION_TIMEOUT_MS },
      ),
    );
  }

  /** 在连接锁和账号锁内提交认证与Route替换；调用方不得绕过两级锁。 / Commits authentication and route replacement under connection and account locks; callers must not bypass them. */
  private LoginGateLocked(session: GateSession, request: C2G_LoginGate): G2C_LoginGate {
    if (session.IsAuthenticated && session.account !== request.account) {
      throw new RpcError(GameErrCode.GateSessionRequired, "connection already owns another account");
    }

    const connectionId = session.ConnectionId;
    let tokenClaims;
    try {
      tokenClaims = DecodeLoginToken(request.token);
    } catch {
      throw new RpcError(GameErrCode.TokenRequired, "invalid login token");
    }
    if (tokenClaims.account !== request.account) {
      throw new RpcError(GameErrCode.TokenRequired, "login token account mismatch");
    }
    const characterId = request.characterId ?? tokenClaims.characterId;
    if (characterId !== tokenClaims.characterId || characterId <= 0n) {
      throw new RpcError(GameErrCode.CharacterNotFound, "login token character mismatch");
    }
    const now = TimeSystem.Instance.FrameTime;
    let route = this.routesByAccount.get(request.account);
    let previousConnectionId: number | undefined;
    if (route) {
      if (route.characterId !== characterId) {
        throw new RpcError(GameErrCode.GateSessionRequired, "account already has another character online");
      }
      try {
        previousConnectionId = route.Attach(connectionId, now);
      } catch {
        throw new RpcError(
          GameErrCode.GateSessionRequired,
          "player is completing offline; retry login",
        );
      }
    } else {
      route = new GatePlayerRoute(request.account, characterId, this.self.name, connectionId, now);
      this.routesByAccount.set(request.account, route);
    }

    this.routesByConnection.set(connectionId, route);
    session.BindLogin(request.account, request.token, route);
    this.BindConnectionRoute(route, connectionId);

    if (
      previousConnectionId !== undefined &&
      previousConnectionId !== connectionId
    ) {
      this.ReplaceConnection(route, previousConnectionId, connectionId);
    }

    return { account: request.account, characterId };
  }

  /**
   * 原子完成顶号：撤销旧Session、发送可识别原因、再请求关闭旧连接。
   * 新连接已经绑定到同一个Route，旧连接的迟到断线和在途请求都不能影响它。
   *
   * Atomically completes account takeover: invalidate the old Session, enqueue
   * a visible reason, then close the old connection. The new connection already
   * owns the same Route, so stale close events and in-flight requests cannot
   * affect it.
   */
  private ReplaceConnection(
    route: GatePlayerRoute,
    previousConnectionId: number,
    newConnectionId: number,
  ): void {
    if (this.routesByConnection.get(previousConnectionId) === route) {
      this.routesByConnection.delete(previousConnectionId);
    }
    this.actorLocations.unbindConnection(previousConnectionId);
    this.getSession<GateSession>(previousConnectionId)?.Invalidate();

    if (this.disconnecting.has(previousConnectionId)) return;
    this.disconnecting.add(previousConnectionId);
    const notice: G2C_SessionReplaced = {
      reasonCode: GameErrCode.SessionReplaced,
      reason: "账号已在其他设备登录",
    };
    this.sendClient(previousConnectionId, ClientMessages.SessionReplaced, notice);
    this.logger.info("replaced previous Gate connection", {
      account: route.account,
      previousConnectionId,
      newConnectionId,
    });
    this.disconnectClient(previousConnectionId);
  }

  /**
   * 校验当前Gate会话并返回生成响应时的服务器Unix毫秒时间；它不承担网络往返时延修正。
   * Validates the current Gate session and returns server Unix milliseconds at
   * response creation time; it does not compensate for network round-trip delay.
   */
  Ping(session: GateSession): G2C_Ping {
    this.RequireCurrentRoute(session);
    return { serverTime: BigInt(TimerSystem.ServerTime()) };
  }

  @message(GateMessages.MapReady)
  private MapReady(message: M2G_MapReady): void {
    const connectionId = this.routesByAccount.get(message.account)?.connectionId;
    if (connectionId === undefined) {
      this.logger.warn("cannot push MapReady: account has no active connection", {
        account: message.account,
      });
      return;
    }
    this.sendClient(connectionId, ClientMessages.MapReady, {
      account: message.account,
      mapId: message.mapId,
      unitId: message.unitId,
      x: message.x,
      y: message.y,
      z: message.z,
    });
  }

  @message(GateMessages.ClientBroadcast)
  private ClientBroadcast(message: S2G_ClientBroadcast): void {
    const delivery = requireClientFrameDelivery(message.deliveryClass);
    const connectionIds: number[] = [];
    for (const unitId of message.targetUnitIds) {
      const connectionId = this.connectionIdsByUnitId.get(unitId);
      if (connectionId !== undefined) connectionIds.push(connectionId);
    }
    this.sendClientFrameMany(
      connectionIds,
      message.frame,
      delivery,
    );
  }

  /**
   * 接收Map按Gate聚合的多帧批次，并保持每个客户端协议帧的独立边界。
   * Gate只做Unit到连接的路由，不解析或重编码业务payload。
   *
   * Receives multiple frame groups already aggregated for this Gate while
   * preserving each client protocol frame boundary. Gate only resolves Unit
   * routes and never decodes or re-encodes business payloads.
   */
  @message(GateMessages.ClientBroadcastBatch)
  private ClientBroadcastBatch(message: S2G_ClientBroadcastBatch): void {
    const delivery = requireClientFrameDelivery(message.deliveryClass);
    for (const batch of message.batches) {
      const connectionIds: number[] = [];
      for (const unitId of batch.targetUnitIds) {
        const connectionId = this.connectionIdsByUnitId.get(unitId);
        if (connectionId !== undefined) connectionIds.push(connectionId);
      }
      this.sendClientFrameMany(
        connectionIds,
        batch.frame,
        delivery,
      );
    }
  }

  @message(GateMessages.KickPlayers)
  private KickPlayers(message: M2G_KickPlayers): void {
    for (const target of message.players) {
      const route = this.routesByUnitId.get(target.unitId);
      if (!route) continue;
      void this.Locks.RunExclusive(
        GATE_PLAYER_LOCK,
        route.account,
        () => this.KickPlayerLocked(route, target.unitId, message.reason),
        { timeoutMs: 0 },
      ).catch((error) => {
        this.logger.error("map player kick failed", {
          account: route.account,
          unitId: target.unitId,
          reason: message.reason,
          error,
        });
      });
    }
  }

  /** 在玩家锁内移除Map已处理完成的Gate路由；这里不得再次通知Map下线。 / Removes a Map-completed Gate route under the player lock and must not notify Map offline again. */
  private KickPlayerLocked(route: GatePlayerRoute, unitId: number, reason: string): void {
    if (this.routesByUnitId.get(unitId) !== route || !route.BeginRemoving()) return;
    const connectionId = route.connectionId;
    this.RemoveRoute(route);
    if (connectionId === undefined || this.disconnecting.has(connectionId)) return;
    this.disconnecting.add(connectionId);
    this.logger.info("map requested player route removal", {
      account: route.account,
      unitId,
      connectionId,
      reason,
    });
    this.disconnectClient(connectionId);
  }

  /**
   * 首次进入和主动传送调用MapHost；断线重连则直接调用原PlayerUnit的SecondEnterMap。
   * 两条路径最后都只在Gate更新连接到Actor的路由，Map永远不知道connectionId。
   *
   * Initial entry and explicit transfer call MapHost, while reconnect calls
   * SecondEnterMap on the existing PlayerUnit. Both update connection routing
   * only inside Gate; Map never sees a connectionId.
   */
  async EnterMap(
    session: GateSession,
    request: C2G_EnterMap,
    spawnOverride?: ServerSpawnOverride,
  ): Promise<G2C_EnterMap> {
    return await this.RunPlayerTransaction(
      session,
      () => this.EnterMapCore(
        session,
        request,
        spawnOverride,
        EntrySyncMode.Full,
      ),
    );
  }

  /**
   * 创建或复用一次Starter动态副本并沿用正式进图事务传送当前角色。
   * operationId只决定创建幂等性，不授权客户端指定MapHost或MapInstanceId。
   *
   * Creates or reuses one Starter instance and transfers the current character
   * through the normal entry transaction. The client controls neither host nor
   * instance id.
   */
  async EnterStarterDungeon(
    session: GateSession,
    request: C2G_EnterStarterDungeon,
  ): Promise<G2C_EnterStarterDungeon> {
    const operationId = request.operationId.trim();
    if (operationId.length === 0 || operationId.length > 128) {
      throw new RpcError(GameErrCode.DynamicMapRequestRequired, "invalid Starter dungeon operationId");
    }
    return await this.RunPlayerTransaction(session, async () => {
      const route = this.RequireCurrentRoute(session);
      const source = route.map;
      if (!source || route.actorState === "moving") {
        throw new RpcError(GameErrCode.MapNotFound, "Starter dungeon requires an active player route");
      }
      const cooldown = await this.scenes.callActor<
        G2M_ClaimStarterDungeonEntry,
        M2G_ClaimStarterDungeonEntry
      >(
        {
          scene: source.mapHost,
          instanceId: source.actorInstanceId,
          fenceToken: source.gateEpoch,
        },
        MapProtocol.ClaimStarterDungeonEntry,
        { operationId },
        { timeoutMs: MAP_ENTRY_ADMISSION_TIMEOUT_MS },
      );
      this.AssertCurrentRoute(session, route);
      const created = await this.dynamicMaps.Create(
        `starter-dungeon:${route.characterId}:${operationId}`,
        STARTER_DUNGEON_MAP_CONFIG_ID,
      );
      this.AssertCurrentRoute(session, route);
      const enterMap = await this.EnterMapCore(
        session,
        {
          rpcId: request.rpcId,
          mapId: STARTER_DUNGEON_MAP_CONFIG_ID,
          mapInstanceId: created.instance.mapInstanceId,
        },
        undefined,
        EntrySyncMode.Full,
      );
      return {
        rpcId: request.rpcId,
        error: 0,
        message: "",
        enterMap,
        cooldownEndAtMs: cooldown.cooldownEndAtMs,
      };
    });
  }

  /** Bench专用入口，可拆分初始视图阶段；正式Handler禁止调用。 / Bench-only entrypoint for isolating initial-view stages; production handlers must not call it. */
  async EnterMapForBenchmark(
    session: GateSession,
    request: C2G_EnterMap,
    spawnOverride: ServerSpawnOverride,
    entrySyncMode: number,
  ): Promise<G2C_EnterMap> {
    return await this.RunPlayerTransaction(
      session,
      () => this.EnterMapCore(
        session,
        request,
        spawnOverride,
        ParseEntrySyncMode(entrySyncMode),
      ),
    );
  }

  /**
   * 校验客户端确认对应当前Unit，再让权威MapHost发送初始视野；Gate不缓存或解析实体快照。
   * 该确认只能在EnterMap响应后调用，因而Unit到连接的路由已经完成绑定。
   *
   * Validates that the ready acknowledgement targets the current Unit, then asks
   * the authoritative MapHost to publish the initial view without caching it in Gate.
   */
  async MapSnapshotReady(
    session: GateSession,
    request: C2G_MapSnapshotReady,
  ): Promise<G2C_MapSnapshotReady> {
    return await this.RunPlayerTransaction(session, async () => {
      const route = this.RequireCurrentRoute(session);
      const map = route.map;
      if (!map || map.unitId !== request.unitId || route.actorState === "moving") {
        throw new RpcError(GameErrCode.MapNotFound, "initial snapshot route is not ready");
      }
      const response = await this.scenes.call<G2M_InitialSnapshot, M2G_InitialSnapshot>(
        map.mapHost,
        MapProtocol.InitialSnapshot,
        { account: route.account, characterId: route.characterId, unitId: map.unitId },
        { timeoutMs: MAP_ENTRY_ADMISSION_TIMEOUT_MS },
      );
      this.AssertCurrentRoute(session, route);
      return {
        rpcId: request.rpcId,
        error: response.error,
        message: response.message,
        demoDoorClosed: response.demoDoorClosed,
      };
    });
  }

  /** 统一正式与Bench进图事务，只有调用入口决定初始同步模式。 / Shares the entry transaction while callers select the initial-sync policy. */
  private async EnterMapCore(
    session: GateSession,
    request: C2G_EnterMap,
    spawnOverride: ServerSpawnOverride | undefined,
    entrySyncMode: EntrySyncModeValue,
  ): Promise<G2C_EnterMap> {
    const route = this.RequireCurrentRoute(session);
    if (route.actorState === "moving") {
      throw new RpcError(SystemErrCode.ActorTransferring, "player transfer is recovering");
    }
    const safeMapId = GameConfigs.PlayerConfig.Get(1).initialMapId;
    const safeMapInstanceId = BigInt(safeMapId);
    const defaultMapId = request.mapId || safeMapId;
    let targetMapInstanceId = request.mapInstanceId || BigInt(defaultMapId);
    let safeFallback = false;
    if (session.needsSecondEnter && route.map) {
      const resumed = await this.ResumeOrRecoverMapHost(session, route);
      if (resumed.response) return resumed.response;
      if (resumed.routeLost) {
        targetMapInstanceId = safeMapInstanceId;
        safeFallback = true;
      }
    }

    if (!route.map) {
      const resolved = await this.location.Resolve({ unitId: 0, account: "", characterId: route.characterId });
      this.AssertCurrentRoute(session, route);
      if (resolved.found) {
        if (resolved.location.state !== "active") {
          throw new RpcError(SystemErrCode.ActorTransferring, "player location is changing");
        }
        const owned = await this.EnsureGateOwnership(session, route, resolved.location);
        route.BindMap({
          mapService: owned.mapHostName,
          mapHost: SceneConfigFromMapHostEndpoint(owned.mapHost),
          mapId: owned.mapId,
          mapInstanceId: owned.mapInstanceId,
          unitId: owned.unitId,
          actorInstanceId: owned.actorInstanceId,
          revision: owned.revision,
          gateEpoch: owned.gateEpoch,
        });
        this.routesByUnitId.set(owned.unitId, route);
        this.BindConnectionRoute(route, session.ConnectionId);
        if (resolved.location.mapInstanceId === targetMapInstanceId) {
          const resumed = await this.ResumeOrRecoverMapHost(session, route);
          if (resumed.response) return resumed.response;
          if (resumed.routeLost) {
            targetMapInstanceId = safeMapInstanceId;
            safeFallback = true;
          }
        }
      }
    }
    if (route.map) {
      if (route.map.mapInstanceId === targetMapInstanceId) {
        const resumed = await this.ResumeOrRecoverMapHost(session, route);
        if (resumed.response) return resumed.response;
        if (resumed.routeLost) {
          targetMapInstanceId = safeMapInstanceId;
          safeFallback = true;
        }
      }
    }
    if (route.map) {
      return await this.TransferToMap(session, route, targetMapInstanceId);
    }
    const target = await this.location.ResolveMapInstance({ mapInstanceId: targetMapInstanceId });
    if (!target.found) {
      if (safeFallback) this.dynamicFallbackMetrics.failed += 1;
      throw new RpcError(GameErrCode.MapNotFound, `map instance not found: ${targetMapInstanceId}`);
    }
    const mapHostScene = SceneConfigFromMapInstance(target.instance);
    let mapResponse: M2G_EnterMap;
    try {
      mapResponse = await this.scenes.call<G2M_EnterMap, M2G_EnterMap>(
        mapHostScene,
        MapProtocol.EnterMap,
        {
          account: session.account,
          token: session.token,
          gateName: this.self.name,
          gateEpoch: 1n,
          characterId: session.characterId,
          mapInstanceId: target.instance.mapInstanceId,
          hasInitialSpawnOverride: spawnOverride !== undefined,
          initialSpawnX: spawnOverride?.x ?? 0,
          initialSpawnY: spawnOverride?.y ?? 0,
          initialSpawnZ: spawnOverride?.z ?? 0,
          initialSpawnYaw: spawnOverride?.yaw ?? 0,
          entrySyncMode,
        },
        { timeoutMs: MAP_ENTRY_ADMISSION_TIMEOUT_MS },
      );
    } catch (error) {
      if (safeFallback) this.dynamicFallbackMetrics.failed += 1;
      throw error;
    }
    this.AssertCurrentRoute(session, route);

    route.BindMap({
      mapService: mapHostScene.name,
      mapHost: mapHostScene,
      mapId: mapResponse.mapId,
      mapInstanceId: mapResponse.mapInstanceId,
      unitId: mapResponse.unitId,
      actorInstanceId: mapResponse.actorInstanceId,
      revision: mapResponse.locationRevision,
      gateEpoch: 1n,
    });
    session.needsSecondEnter = false;
    this.routesByUnitId.set(mapResponse.unitId, route);
    this.BindConnectionRoute(route, session.ConnectionId);

    this.logger.info("player entered map", {
      account: session.account,
      mapHost: mapHostScene.name,
      mapId: mapResponse.mapId,
      unitId: mapResponse.unitId,
    });
    if (safeFallback) {
      this.dynamicFallbackMetrics.completed += 1;
      this.logger.warn("player recovered to safe static map", {
        account: route.account,
        mapId: mapResponse.mapId,
        mapInstanceId: mapResponse.mapInstanceId.toString(),
      });
    }
    return this.ToClientEnterMap(mapHostScene.name, mapResponse);
  }

  /**
   * 为同MapHost和跨MapHost迁移提供同一个Gate入口。
   * 屏障打开后由协议元数据决定排队、拒绝或丢弃，成功和回滚都会释放队列。
   *
   * Provides one Gate entrypoint for local and cross-MapHost migration. While
   * the barrier is open, generated protocol metadata decides queue/reject/drop;
   * both success and rollback release the buffered frames.
   */
  private async TransferToMap(
    session: GateSession,
    route: GatePlayerRoute,
    targetMapInstanceId: bigint,
  ): Promise<G2C_EnterMap> {
    let source = route.map!;
    const connectionId = session.ConnectionId;
    if (!route.BeginActorMove()) {
      throw new RpcError(SystemErrCode.ActorTransferring, "player is already transferring");
    }
    // 必须在第一个await之前打开屏障，否则同连接后到的Actor消息可能抢先落入旧Unit。
    // The barrier must open before the first await, or a later Actor message on
    // the same connection may overtake this operation and reach the old Unit.
    this.beginActorTransfer(connectionId);
    try {
      // Location重启后revision会重建。只在迁移前刷新一次，不进入普通玩家消息热路径。
      // A restarted Location rebuilds revisions. Refresh once before migration,
      // never on the ordinary per-message routing hot path.
      const resolved = await this.location.Resolve({
        unitId: source.unitId,
        account: "",
        characterId: route.characterId,
      });
      this.AssertCurrentRoute(session, route);
      if (!resolved.found) {
        throw new RpcError(SystemErrCode.LocationUnavailable, "player location is recovering");
      }
      if (resolved.location.gateName !== this.self.name || resolved.location.state !== "active") {
        throw new RpcError(SystemErrCode.ActorTransferring, "player location is changing");
      }
      route.RefreshMovingMap({
        mapService: resolved.location.mapHostName,
        mapHost: SceneConfigFromMapHostEndpoint(resolved.location.mapHost),
        mapId: resolved.location.mapId,
        mapInstanceId: resolved.location.mapInstanceId,
        unitId: resolved.location.unitId,
        actorInstanceId: resolved.location.actorInstanceId,
        revision: resolved.location.revision,
        gateEpoch: resolved.location.gateEpoch,
      });
      this.BindConnectionRoute(route, connectionId);
      source = route.map!;
      const response = await this.scenes.callActor<G2M_TransferPlayer, M2G_TransferPlayer>(
        {
          scene: source.mapHost,
          instanceId: source.actorInstanceId,
          fenceToken: source.gateEpoch,
        },
        MapProtocol.TransferPlayer,
        {
          account: route.account,
          characterId: route.characterId,
          gateName: this.self.name,
          targetMapInstanceId,
          expectedLocationRevision: source.revision,
        },
        { timeoutMs: MAP_ENTRY_ADMISSION_TIMEOUT_MS },
      );
      this.AssertCurrentRoute(session, route);
      route.BindMap({
        mapService: response.mapHostName,
        mapHost: SceneConfigFromMapHostEndpoint(response.mapHost),
        mapId: response.mapId,
        mapInstanceId: response.mapInstanceId,
        unitId: response.unitId,
        actorInstanceId: response.actorInstanceId,
        revision: response.locationRevision,
        gateEpoch: source.gateEpoch,
      });
      this.BindConnectionRoute(route, connectionId);
      this.sendClient(connectionId, ClientMessages.MapReady, {
        account: response.account,
        mapId: response.mapId,
        unitId: response.unitId,
        x: response.x,
        y: response.y,
        z: response.z,
      });
      this.finishActorTransfer(connectionId);
      return {
        account: response.account,
        mapService: response.mapHostName,
        mapId: response.mapId,
        unitId: response.unitId,
        x: response.x,
        y: response.y,
        z: response.z,
        entities: response.entities,
        fixedUpdateMs: response.fixedUpdateMs,
        items: response.items,
        quests: response.quests,
        completedQuestConfigIds: response.completedQuestConfigIds,
        gold: response.gold,
        starterDungeonCooldownEndAtMs: response.starterDungeonCooldownEndAtMs,
        mapInstanceId: response.mapInstanceId,
        ...this.ClientSpatialMetadata(response.mapId),
      };
    } catch (error) {
      if (error instanceof RpcError && error.code === SystemErrCode.LocationUnavailable) {
        // 目标提交后的不确定结果不能回放给旧Actor。拒绝缓冲请求并断开连接，
        // 保留moving状态供运维和后续恢复流程诊断。
        // An uncertain post-target-commit result must never replay into the old
        // Actor. Reject buffered work, disconnect, and preserve moving state for recovery.
        this.cancelActorTransfer(connectionId);
        if (!this.disconnecting.has(connectionId)) {
          this.disconnecting.add(connectionId);
          this.disconnectClient(connectionId);
        }
        throw error;
      }
      route.AbortActorMove();
      this.finishActorTransfer(connectionId);
      throw error;
    }
  }

  /** Timer入口：处理无入站消息和物理断线两类超时；出站流量不会为玩家续期。 / Timer entrypoint for receive timeout and reconnect-grace expiry; outbound traffic never renews liveness. */
  protected SweepClientTimeouts(): void {
    const now = TimeSystem.Instance.FrameTime;
    for (const route of [...this.routesByAccount.values()]) {
      if (route.IsReceiveTimedOut(now, GATE_CLIENT_TIMEOUT_MS)) {
        this.QueueFinalOffline(route, "client-heartbeat-timeout");
      } else if (route.IsReconnectExpired(now, GATE_RECONNECT_GRACE_MS)) {
        this.QueueFinalOffline(route, "client-reconnect-timeout");
      }
    }
  }

  private async SecondEnterMap(
    session: GateSession,
    route: GatePlayerRoute,
  ): Promise<G2C_EnterMap> {
    const location = route.map!;
    const targetScene = location.mapHost;
    const response = await this.scenes.callActor<
      G2M_SecondEnterMap,
      M2G_SecondEnterMap
    >(
      {
        scene: targetScene,
        instanceId: location.actorInstanceId,
        fenceToken: location.gateEpoch,
      },
      MapProtocol.SecondEnterMap,
      {
        account: route.account,
        characterId: route.characterId,
        mapId: location.mapId,
        unitId: location.unitId,
        gateName: this.self.name,
        gateEpoch: location.gateEpoch,
      },
    );
    this.AssertCurrentRoute(session, route);

    session.needsSecondEnter = false;
    this.BindConnectionRoute(route, session.ConnectionId);
    const ready: G2C_MapReady = {
      account: response.account,
      mapId: response.mapId,
      unitId: response.unitId,
      x: response.x,
      y: response.y,
      z: response.z,
    };
    this.sendClient(session.ConnectionId, ClientMessages.MapReady, ready);
    this.logger.info("player resumed existing map unit", {
      account: route.account,
      connectionId: session.ConnectionId,
      mapId: response.mapId,
      unitId: response.unitId,
    });
    return {
      account: response.account,
      mapService: location.mapService,
      mapId: response.mapId,
      unitId: response.unitId,
      x: response.x,
      y: response.y,
      z: response.z,
      entities: response.entities,
      fixedUpdateMs: response.fixedUpdateMs,
      items: response.items,
      quests: response.quests,
      completedQuestConfigIds: response.completedQuestConfigIds,
      gold: response.gold,
      starterDungeonCooldownEndAtMs: response.starterDungeonCooldownEndAtMs,
      mapInstanceId: location.mapInstanceId,
      ...this.ClientSpatialMetadata(response.mapId),
    };
  }

  /**
   * 旧Map Actor不可达时先核对Location；只有权威路由已删除或已换代才清理Gate缓存。
   * / Rechecks Location after an old Map Actor becomes unreachable and clears
   * the Gate cache only after the authority disappeared or changed generation.
   */
  private async ResumeOrRecoverMapHost(
    session: GateSession,
    route: GatePlayerRoute,
  ): Promise<MapResumeResult> {
    try {
      return { response: await this.SecondEnterMap(session, route), routeLost: false };
    } catch (error) {
      const previous = route.map;
      if (!previous) throw error;
      let resolved;
      try {
        resolved = await this.location.Resolve({
          unitId: previous.unitId,
          account: "",
          characterId: route.characterId,
        });
        this.AssertCurrentRoute(session, route);
      } catch {
        throw error;
      }
      if (
        resolved.found &&
        resolved.location.actorInstanceId === previous.actorInstanceId &&
        resolved.location.mapHostName === previous.mapService
      ) {
        throw error;
      }

      this.ClearStaleMapRoute(route, session.ConnectionId);
      if (!resolved.found) {
        this.dynamicFallbackMetrics.attempts += 1;
        this.logger.warn("cleared stale MapHost route for player recovery", {
          account: route.account,
          mapHost: previous.mapService,
          unitId: previous.unitId,
        });
        return { routeLost: true };
      }
      if (resolved.location.gateName !== this.self.name || resolved.location.state !== "active") {
        throw error;
      }
      route.BindMap({
        mapService: resolved.location.mapHostName,
        mapHost: SceneConfigFromMapHostEndpoint(resolved.location.mapHost),
        mapId: resolved.location.mapId,
        mapInstanceId: resolved.location.mapInstanceId,
        unitId: resolved.location.unitId,
        actorInstanceId: resolved.location.actorInstanceId,
        revision: resolved.location.revision,
        gateEpoch: resolved.location.gateEpoch,
      });
      this.BindConnectionRoute(route, session.ConnectionId);
      return { response: await this.SecondEnterMap(session, route), routeLost: false };
    }
  }

  private ClearStaleMapRoute(route: GatePlayerRoute, connectionId: number): void {
    const previous = route.ClearMap();
    if (!previous) return;
    if (this.routesByUnitId.get(previous.unitId) === route) {
      this.routesByUnitId.delete(previous.unitId);
    }
    if (this.connectionIdsByUnitId.get(previous.unitId) === connectionId) {
      this.connectionIdsByUnitId.delete(previous.unitId);
    }
    this.actorLocations.unbindConnection(connectionId);
  }

  /**
   * 当前Gate与Location所有者不同时，先确认旧Gate不可达，再由PlayerUnit邮箱执行CAS接管。
   * 探测只能决定是否尝试；最终正确性由Location revision和Actor fencing token共同保证。
   *
   * When this Gate differs from Location ownership, it first confirms the old
   * Gate is unreachable, then asks the PlayerUnit mailbox to perform a CAS
   * takeover. Probing permits the attempt; revision CAS and Actor fencing keep it safe.
   */
  private async EnsureGateOwnership(
    session: GateSession,
    route: GatePlayerRoute,
    location: PlayerLocationSnapshot,
  ): Promise<PlayerLocationSnapshot> {
    if (location.gateName === this.self.name) return location;
    this.gateTakeoverMetrics.attempts += 1;

    let previousGate;
    try {
      previousGate = this.scenes.byName(location.gateName);
    } catch {
      this.gateTakeoverMetrics.failed += 1;
      throw new RpcError(
        GameErrCode.GateSessionRequired,
        `player Gate owner is outside this topology: ${location.gateName}`,
      );
    }
    if (await IsGateReachable(this.scenes, previousGate)) {
      this.gateTakeoverMetrics.rejectedOwnerAlive += 1;
      throw new RpcError(
        GameErrCode.GateSessionRequired,
        `player is still owned by reachable Gate ${location.gateName}`,
      );
    }
    this.AssertCurrentRoute(session, route);

    try {
      const operationId = `gate-rebind:${this.self.name}:${GlobalIdSystem.Instance.Next()}`;
      const committed = await this.scenes.callActor<
        G2M_RebindPlayerGate,
        M2G_RebindPlayerGate
      >(
        {
          scene: SceneConfigFromMapHostEndpoint(location.mapHost),
          instanceId: location.actorInstanceId,
          fenceToken: location.gateEpoch,
        },
        MapProtocol.RebindPlayerGate,
        {
          account: route.account,
          characterId: route.characterId,
          unitId: location.unitId,
          expectedGateName: location.gateName,
          nextGateName: this.self.name,
          expectedGateEpoch: location.gateEpoch,
          expectedLocationRevision: location.revision,
          operationId,
        },
        { timeoutMs: MAP_ENTRY_ADMISSION_TIMEOUT_MS },
      );
      this.AssertCurrentRoute(session, route);
      this.gateTakeoverMetrics.succeeded += 1;
      this.logger.warn("player Gate ownership taken over", {
        account: route.account,
        previousGate: location.gateName,
        nextGate: committed.gateName,
        gateEpoch: committed.gateEpoch.toString(),
        unitId: location.unitId,
      });
      return {
        ...location,
        gateName: committed.gateName,
        gateEpoch: committed.gateEpoch,
        revision: committed.locationRevision,
      };
    } catch (error) {
      this.gateTakeoverMetrics.failed += 1;
      throw error;
    }
  }

  /** 每个账号最多排队一次最终下线事务；真正取得锁后重新检查超时，避免误踢刚重连的玩家。 / Queues at most one final-offline transaction per account and rechecks expiry after locking. */
  private QueueFinalOffline(route: GatePlayerRoute, reason: string): void {
    if (this.finalOfflinePending.has(route.account)) return;
    this.finalOfflinePending.add(route.account);
    void this.Locks.RunExclusive(
      GATE_PLAYER_LOCK,
      route.account,
      async () => {
        if (this.routesByAccount.get(route.account) !== route) return;
        const now = TimeSystem.Instance.FrameTime;
        const stillExpired = reason === "client-heartbeat-timeout"
          ? route.IsReceiveTimedOut(now, GATE_CLIENT_TIMEOUT_MS)
          : route.IsReconnectExpired(now, GATE_RECONNECT_GRACE_MS);
        if (!stillExpired || !route.BeginRemoving()) return;
        const connectionId = route.connectionId;
        if (connectionId !== undefined && !this.disconnecting.has(connectionId)) {
          this.disconnecting.add(connectionId);
          this.disconnectClient(connectionId);
        }
        await this.FinalOffline(route, reason);
      },
      { timeoutMs: 0 },
    ).catch((error) => {
      this.logger.error("gate final offline transaction failed", {
        account: route.account,
        reason,
        error,
      });
    }).finally(() => {
      this.finalOfflinePending.delete(route.account);
    });
  }

  private async FinalOffline(route: GatePlayerRoute, reason: string): Promise<void> {
    const location = route.map;
    try {
      if (location) {
        const request: G2M_PlayerOffline = {
          account: route.account,
          characterId: route.characterId,
          mapId: location.mapId,
          unitId: location.unitId,
          gateName: this.self.name,
          gateEpoch: location.gateEpoch,
          reason,
        };
        await this.scenes.callActor(
          {
            scene: location.mapHost,
            instanceId: location.actorInstanceId,
            fenceToken: location.gateEpoch,
          },
          MapProtocol.PlayerOffline,
          request,
          { timeoutMs: 5_000 },
        );
      }
    } catch (error) {
      this.logger.error("map player offline failed", {
        account: route.account,
        unitId: location?.unitId,
        mapService: location?.mapService,
        reason,
        error,
      });
    } finally {
      this.RemoveRoute(route);
    }
  }

  /**
   * 使用账号作为Gate状态事务键；Ping和纯查询不得调用，避免把无关消息重新串行化。
   * Uses the account as the Gate state-transaction key. Ping and read-only work
   * must not call this helper, otherwise unrelated messages become serialized again.
   */
  private RunPlayerTransaction<T>(
    session: GateSession,
    callback: () => T | Promise<T>,
  ): Promise<T> {
    if (!session.IsAuthenticated || !session.account) {
      return Promise.reject(
        new RpcError(GameErrCode.GateSessionRequired, "please login gate first"),
      );
    }
    return this.Locks.RunExclusive(
      GATE_PLAYER_LOCK,
      session.account,
      callback,
      { timeoutMs: MAP_ENTRY_ADMISSION_TIMEOUT_MS },
    );
  }

  private RequireCurrentRoute(session: GateSession): GatePlayerRoute {
    const route = session.route;
    if (
      !session.IsAuthenticated ||
      !route ||
      route.state === "removing" ||
      route.connectionId !== session.ConnectionId ||
      this.routesByAccount.get(session.account) !== route
    ) {
      throw new RpcError(GameErrCode.GateSessionRequired, "please login gate first");
    }
    return route;
  }

  /** 在异步Map调用返回后重新校验连接所有权，阻止旧Promise覆盖新连接路由。 / Revalidates ownership after async Map calls so a stale Promise cannot overwrite replacement routing. */
  private AssertCurrentRoute(session: GateSession, expected: GatePlayerRoute): void {
    if (this.RequireCurrentRoute(session) !== expected) {
      throw new RpcError(GameErrCode.GateSessionRequired, "Gate route changed while awaiting Map");
    }
  }

  private BindConnectionRoute(route: GatePlayerRoute, connectionId: number): void {
    if (route.connectionId !== connectionId || route.state !== "online") {
      throw new Error(`cannot bind stale Gate connection: ${route.account}#${connectionId}`);
    }
    const location = route.map;
    if (!location) return;
    this.routesByUnitId.set(location.unitId, route);
    this.connectionIdsByUnitId.set(location.unitId, connectionId);
    const target = {
      instanceId: location.actorInstanceId,
      scene: location.mapHost,
      fenceToken: location.gateEpoch,
    };
    const previous = this.actorLocations.resolveConnection(connectionId);
    if (
      previous &&
      (previous.instanceId !== target.instanceId ||
        previous.scene.name !== target.scene.name ||
        previous.scene.sceneType !== target.scene.sceneType ||
        previous.scene.innerIp !== target.scene.innerIp ||
        previous.scene.port !== target.scene.port ||
        previous.fenceToken !== target.fenceToken)
    ) {
      // 地图迁移是显式的同连接换Actor；先解除旧路由，再执行严格bind，
      // 避免底层目录默默覆盖旧目标。
      // Map transfer is an explicit same-connection actor change; unbind first
      // so the strict directory cannot silently overwrite the old target.
      this.actorLocations.unbindConnection(connectionId);
    }
    this.actorLocations.bindConnection(connectionId, target);
  }

  /** 导出Gate接管的低基数累计结果。 / Exports low-cardinality cumulative Gate takeover outcomes. */
  private GateTakeoverMetricSnapshot(): CustomMetricSnapshot {
    return {
      name: "gate_takeover",
      values: {
        attempts_total: this.gateTakeoverMetrics.attempts,
        succeeded_total: this.gateTakeoverMetrics.succeeded,
        rejected_owner_alive_total: this.gateTakeoverMetrics.rejectedOwnerAlive,
        failed_total: this.gateTakeoverMetrics.failed,
      },
      kinds: {
        attempts_total: "counter",
        succeeded_total: "counter",
        rejected_owner_alive_total: "counter",
        failed_total: "counter",
      },
    };
  }

  /** 导出动态地图丢失后的安全回退结果。 / Exports safe-fallback outcomes after dynamic map loss. */
  private DynamicFallbackMetricSnapshot(): CustomMetricSnapshot {
    return {
      name: "dynamic_map_fallback",
      values: {
        attempts_total: this.dynamicFallbackMetrics.attempts,
        completed_total: this.dynamicFallbackMetrics.completed,
        failed_total: this.dynamicFallbackMetrics.failed,
      },
      kinds: {
        attempts_total: "counter",
        completed_total: "counter",
        failed_total: "counter",
      },
    };
  }

  private RemoveRoute(route: GatePlayerRoute): void {
    if (this.routesByAccount.get(route.account) === route) {
      this.routesByAccount.delete(route.account);
    }
    const connectionId = route.connectionId;
    if (
      connectionId !== undefined &&
      this.routesByConnection.get(connectionId) === route
    ) {
      this.routesByConnection.delete(connectionId);
      this.actorLocations.unbindConnection(connectionId);
    }
    const unitId = route.map?.unitId;
    if (unitId !== undefined && this.routesByUnitId.get(unitId) === route) {
      this.routesByUnitId.delete(unitId);
      this.connectionIdsByUnitId.delete(unitId);
    }
  }

  private ToClientEnterMap(
    mapService: string,
    response: M2G_EnterMap,
  ): G2C_EnterMap {
    return {
      account: response.account,
      mapService,
      mapId: response.mapId,
      unitId: response.unitId,
      x: response.x,
      y: response.y,
      z: response.z,
      entities: response.entities,
      fixedUpdateMs: response.fixedUpdateMs,
      items: response.items,
      quests: response.quests,
      completedQuestConfigIds: response.completedQuestConfigIds,
      gold: response.gold,
      starterDungeonCooldownEndAtMs: response.starterDungeonCooldownEndAtMs,
      mapInstanceId: response.mapInstanceId,
      ...this.ClientSpatialMetadata(response.mapId),
    };
  }

  /** 将引擎无关的地图空间契约附加到进入响应；客户端必须校验导航版本后再允许移动。 / Adds the engine-neutral spatial contract to enter responses so clients can validate navigation assets before movement. */
  private ClientSpatialMetadata(mapId: number): Pick<
    G2C_EnterMap,
    "spatialMode" | "navigationVersion" | "navigationHash"
  > {
    const config = GameConfigs.MapConfig.Get(mapId);
    return {
      spatialMode: config.spatialMode,
      navigationVersion: config.navigationVersion,
      navigationHash: config.navigationHash,
    };
  }

}

function requireClientFrameDelivery(value: number): "reliable" | "latest" {
  if (value === 1) return "reliable";
  if (value === 2) return "latest";
  throw new Error(`invalid client broadcast delivery class: ${value}`);
}
