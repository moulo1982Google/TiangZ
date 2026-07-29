import {
  EntryScene,
  RpcError,
  TimeSystem,
  TimerSystem,
  entryScene,
  message,
  type RuntimeEntrySceneConfig,
  type SceneConfig,
  type TimerId,
} from "../../../core/public";
import { GameErrCode } from "../../game/protocol/GameErrCode";
import {
  type C2G_EnterMap,
  type C2G_LoginGate,
  type G2C_EnterMap,
  type G2C_LoginGate,
  type G2C_MapReady,
  type G2M_EnterMap,
  type G2M_PlayerOffline,
  type G2M_SecondEnterMap,
  type M2G_EnterMap,
  type M2G_KickPlayers,
  type M2G_MapReady,
  type M2G_SecondEnterMap,
  type S2G_ClientBroadcast,
} from "../../../generated/model/server/demo/protocol/messages";
import {
  ClientMessages,
  GateMessages,
} from "../../../generated/model/server/demo/protocol/messageDescriptors";
import { MapProtocol } from "../../../generated/model/server/demo/protocol/rpcs";
import { GameConfigs } from "../../../generated/model/config";
import { GatePlayerRoute } from "../gate/GatePlayerRoute";
import { GateSession } from "../gate/GateSession";

export const GATE_CLIENT_TIMEOUT_MS = 30_000;
export const GATE_RECONNECT_GRACE_MS = 30_000;
const GATE_TIMEOUT_SWEEP_MS = 1_000;

@entryScene()
export class GateScene extends EntryScene {
  protected override readonly mailbox = "unordered" as const;

  private readonly mapScenes: SceneConfig[];
  private readonly routesByAccount = new Map<string, GatePlayerRoute>();
  private readonly routesByConnection = new Map<number, GatePlayerRoute>();
  private readonly routesByUnitId = new Map<number, GatePlayerRoute>();
  private readonly disconnecting = new Set<number>();
  private timeoutSweepTimer: TimerId = 0;

  constructor(config: RuntimeEntrySceneConfig) {
    super(config);
    this.mapScenes = this.scenes.many("MapHost");
    if (this.mapScenes.length === 0) {
      throw new Error("GateScene needs at least one known MapHostScene");
    }
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

  /** 记录出站排队时间以供观测；该时间绝不参与存活判定。 / Records outbound queue activity for observability and never for liveness. */
  protected override onClientSendQueued(connectionIds: readonly number[]): void {
    const now = TimeSystem.Instance.FrameTime;
    for (const connectionId of connectionIds) {
      this.routesByConnection.get(connectionId)?.TouchSend(connectionId, now);
    }
  }

  /** 物理连接断开只销毁Session并进入重连宽限，不立即移除Map中的Unit。 / Transport loss disposes only the Session and starts reconnect grace without removing the Map Unit. */
  protected override onDisconnect(connectionId: number): void {
    this.disconnecting.delete(connectionId);
    this.actorLocations.unbindConnection(connectionId);

    const route = this.routesByConnection.get(connectionId);
    if (!route) return;
    if (this.routesByConnection.get(connectionId) === route) {
      this.routesByConnection.delete(connectionId);
    }
    if (!route.Detach(connectionId, TimeSystem.Instance.FrameTime)) return;

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
      TimerSystem.Instance.Remove(this.timeoutSweepTimer);
      this.timeoutSweepTimer = 0;
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
  LoginGate(session: GateSession, request: C2G_LoginGate): G2C_LoginGate {
    if (!request.account) {
      throw new RpcError(GameErrCode.AccountRequired, "account is required");
    }
    if (!request.token) {
      throw new RpcError(GameErrCode.TokenRequired, "token is required");
    }
    if (session.IsAuthenticated && session.account !== request.account) {
      throw new RpcError(GameErrCode.GateSessionRequired, "connection already owns another account");
    }

    const connectionId = session.ConnectionId;
    const now = TimeSystem.Instance.FrameTime;
    let route = this.routesByAccount.get(request.account);
    let previousConnectionId: number | undefined;
    if (route) {
      try {
        previousConnectionId = route.Attach(connectionId, now);
      } catch {
        throw new RpcError(
          GameErrCode.GateSessionRequired,
          "player is completing offline; retry login",
        );
      }
    } else {
      route = new GatePlayerRoute(request.account, this.self.name, connectionId, now);
      this.routesByAccount.set(request.account, route);
    }

    this.routesByConnection.set(connectionId, route);
    session.BindLogin(request.account, request.token, route);
    this.BindConnectionRoute(route, connectionId);

    if (
      previousConnectionId !== undefined &&
      previousConnectionId !== connectionId
    ) {
      this.routesByConnection.delete(previousConnectionId);
      this.actorLocations.unbindConnection(previousConnectionId);
      if (!this.disconnecting.has(previousConnectionId)) {
        this.disconnecting.add(previousConnectionId);
        this.disconnectClient(previousConnectionId);
      }
    }

    return { account: request.account };
  }

  /** Ping只验证认证状态；统一入站钩子已经为所有客户端消息刷新存活时间。 / Ping only checks authentication because the ingress hook refreshes liveness for every client message. */
  Ping(session: GateSession): void {
    if (session.IsAuthenticated) return;
    const connectionId = session.ConnectionId;
    this.disconnecting.add(connectionId);
    this.disconnectClient(connectionId);
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
    });
  }

  @message(GateMessages.ClientBroadcast)
  private ClientBroadcast(message: S2G_ClientBroadcast): void {
    const connectionIds: number[] = [];
    for (const unitId of message.targetUnitIds) {
      const connectionId = this.routesByUnitId.get(unitId)?.connectionId;
      if (connectionId !== undefined) connectionIds.push(connectionId);
    }
    this.sendClientFrameMany(connectionIds, message.frame);
  }

  @message(GateMessages.KickPlayers)
  private KickPlayers(message: M2G_KickPlayers): void {
    for (const target of message.players) {
      const route = this.routesByUnitId.get(target.unitId);
      if (!route || !route.BeginRemoving()) continue;
      const connectionId = route.connectionId;
      this.RemoveRoute(route);
      if (connectionId === undefined || this.disconnecting.has(connectionId)) continue;
      this.disconnecting.add(connectionId);
      this.logger.info("map requested player route removal", {
        account: route.account,
        unitId: target.unitId,
        connectionId,
        reason: message.reason,
      });
      this.disconnectClient(connectionId);
    }
  }

  /**
   * 首次进入和主动传送调用MapHost；断线重连则直接调用原PlayerUnit的SecondEnterMap。
   * 两条路径最后都只在Gate更新连接到Actor的路由，Map永远不知道connectionId。
   *
   * Initial entry and explicit transfer call MapHost, while reconnect calls
   * SecondEnterMap on the existing PlayerUnit. Both update connection routing
   * only inside Gate; Map never sees a connectionId.
   */
  async EnterMap(session: GateSession, request: C2G_EnterMap): Promise<G2C_EnterMap> {
    const route = this.RequireCurrentRoute(session);
    if (session.needsSecondEnter && route.map) {
      return await this.SecondEnterMap(session, route);
    }

    const mapId = request.mapId || GameConfigs.PlayerConfig.Get(1).initialMapId;
    if (!GameConfigs.MapConfig.TryGet(mapId)) {
      throw new RpcError(GameErrCode.MapNotFound, `map config not found: ${mapId}`);
    }
    const mapHostScene = this.selectMapHostScene(mapId);
    const mapResponse = await this.scenes.call<G2M_EnterMap, M2G_EnterMap>(
      mapHostScene,
      MapProtocol.EnterMap,
      {
        account: session.account,
        token: session.token,
        gateName: this.self.name,
        mapId,
      },
    );
    this.AssertCurrentRoute(session, route);

    route.BindMap({
      mapService: mapHostScene.name,
      mapId: mapResponse.mapId,
      unitId: mapResponse.unitId,
      actorInstanceId: mapResponse.actorInstanceId,
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
    return this.ToClientEnterMap(mapHostScene.name, mapResponse);
  }

  /** Timer入口：处理无入站消息和物理断线两类超时；出站流量不会为玩家续期。 / Timer entrypoint for receive timeout and reconnect-grace expiry; outbound traffic never renews liveness. */
  protected SweepClientTimeouts(): void {
    const now = TimeSystem.Instance.FrameTime;
    for (const route of [...this.routesByAccount.values()]) {
      if (route.IsReceiveTimedOut(now, GATE_CLIENT_TIMEOUT_MS)) {
        this.BeginFinalOffline(route, "client-heartbeat-timeout");
      } else if (route.IsReconnectExpired(now, GATE_RECONNECT_GRACE_MS)) {
        this.BeginFinalOffline(route, "client-reconnect-timeout");
      }
    }
  }

  private async SecondEnterMap(
    session: GateSession,
    route: GatePlayerRoute,
  ): Promise<G2C_EnterMap> {
    const location = route.map!;
    const targetScene = this.scenes.byName(location.mapService);
    const response = await this.scenes.callActor<
      G2M_SecondEnterMap,
      M2G_SecondEnterMap
    >(
      { scene: targetScene, instanceId: location.actorInstanceId },
      MapProtocol.SecondEnterMap,
      {
        account: route.account,
        mapId: location.mapId,
        unitId: location.unitId,
        gateName: this.self.name,
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
      entities: response.entities,
      fixedUpdateMs: response.fixedUpdateMs,
      items: response.items,
    };
  }

  private BeginFinalOffline(route: GatePlayerRoute, reason: string): void {
    if (!route.BeginRemoving()) return;
    const connectionId = route.connectionId;
    if (connectionId !== undefined && !this.disconnecting.has(connectionId)) {
      this.disconnecting.add(connectionId);
      this.disconnectClient(connectionId);
    }
    void this.FinalOffline(route, reason);
  }

  private async FinalOffline(route: GatePlayerRoute, reason: string): Promise<void> {
    const location = route.map;
    try {
      if (location) {
        const request: G2M_PlayerOffline = {
          account: route.account,
          mapId: location.mapId,
          unitId: location.unitId,
          gateName: this.self.name,
          reason,
        };
        await this.scenes.callActor(
          {
            scene: this.scenes.byName(location.mapService),
            instanceId: location.actorInstanceId,
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
    this.actorLocations.bindConnection(connectionId, {
      instanceId: location.actorInstanceId,
      scene: this.scenes.byName(location.mapService),
    });
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
      entities: response.entities,
      fixedUpdateMs: response.fixedUpdateMs,
      items: response.items,
    };
  }

  private selectMapHostScene(mapId: number): SceneConfig {
    return this.mapScenes[(mapId - 1) % this.mapScenes.length];
  }
}
