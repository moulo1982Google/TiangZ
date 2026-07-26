import {
  EntryScene,
  RpcError,
  TimeSystem,
  TimerSystem,
  entryScene,
  message,
  type RuntimeEntrySceneConfig,
  type SceneConfig,
} from "../../core/public";
import { GameErrCode } from "../../game/protocol/GameErrCode";
import {
  C2G_EnterMap,
  C2G_LoginGate,
  G2C_EnterMap,
  G2C_LoginGate,
  G2C_MapReady,
  G2M_EnterMap,
  G2M_PlayerDisconnect,
  M2G_KickPlayers,
  S2G_ClientBroadcast,
  M2G_MapReady,
  M2G_EnterMap,
} from "../../generated/model/server/demo/protocol/messages";
import {
  ClientMessages,
  GateMessages,
  MapMessages,
} from "../../generated/model/server/demo/protocol/messageDescriptors";
import {
  InnerLogProtocol,
  MapProtocol,
} from "../../generated/model/server/demo/protocol/rpcs";
import { GateSession } from "../gate/GateSession";

const CLIENT_PING_INTERVAL_MS = 5_000;
const CLIENT_TIMEOUT_MS = 30_000;

@entryScene()
export class GateScene extends EntryScene {
  protected override readonly mailbox = "unordered" as const;

  private mapScenes: SceneConfig[] = [];
  private readonly bootId: string;
  private readonly connectionsByAccount = new Map<string, number>();
  private readonly connectionsByUnitId = new Map<number, number>();
  private readonly disconnecting = new Set<number>();

  constructor(config: RuntimeEntrySceneConfig) {
    super(config);
    this.bootId = `${this.self.name}:${Date.now()}:${Math.floor(Math.random() * 0xffff_ffff)}`;
    this.mapScenes = this.scenes.many("MapHost");
    if (this.mapScenes.length === 0) {
      throw new Error("GateScene needs at least one known MapHostScene");
    }
    TimerSystem.Instance.NewRepeatedTimer(
      CLIENT_PING_INTERVAL_MS,
      () => this.disconnectInactiveClients(),
    );
  }

  protected override async onDisconnect(connectionId: number): Promise<void> {
    this.disconnecting.delete(connectionId);
    const session = this.getSession<GateSession>(connectionId);
    if (
      session &&
      this.connectionsByAccount.get(session.account) === connectionId
    ) {
      this.connectionsByAccount.delete(session.account);
    }
    if (
      session?.unitId !== undefined &&
      this.connectionsByUnitId.get(session.unitId) === connectionId
    ) {
      this.connectionsByUnitId.delete(session.unitId);
    }
    this.actorLocations.unbindConnection(connectionId);
    if (
      session?.mapService &&
      session.mapId !== undefined &&
      session.unitId !== undefined &&
      session.actorInstanceId !== undefined
    ) {
      await this.notifyMapPlayerDisconnected(session);
    }
  }

  protected override onStop(): void {
    for (const session of this.getSessions<GateSession>()) {
      const connectionId = session.ConnectionId;
      if (this.disconnecting.has(connectionId)) continue;
      this.disconnecting.add(connectionId);
      this.disconnectClient(connectionId);
    }
  }

  protected override createSession(connectionId: number): GateSession {
    return this.addSession(connectionId, GateSession);
  }

  /** 认证当前连接并建立 Gate Session 状态。 / Authenticates the current connection and establishes Gate Session state. */
  LoginGate(
    session: GateSession,
    request: C2G_LoginGate,
  ): G2C_LoginGate {
    if (!request.account) {
      throw new RpcError(GameErrCode.AccountRequired, "account is required");
    }
    if (!request.token) {
      throw new RpcError(GameErrCode.TokenRequired, "token is required");
    }
    const connectionId = session.ConnectionId;
    const sessionId = `${this.bootId}:${connectionId}`;
    session.BindLogin(sessionId, request.account, request.token, TimeSystem.Instance.FrameTime);
    this.actorLocations.unbindConnection(connectionId);
    this.connectionsByAccount.set(request.account, connectionId);

    return {
      account: request.account,
    };
  }

  /** 刷新已认证 Session 的心跳；未登录连接立即关闭。 / Refreshes an authenticated Session heartbeat and closes unauthenticated connections. */
  Ping(session: GateSession): void {
    const connectionId = session.ConnectionId;
    if (!session.IsAuthenticated) {
      this.disconnecting.add(connectionId);
      this.disconnectClient(connectionId);
      return;
    }
    if (!this.disconnecting.has(connectionId)) {
      session.lastActivityAtMs = TimeSystem.Instance.FrameTime;
    }
  }

  @message(GateMessages.MapReady)
  private mapReady(message: M2G_MapReady): void {
    const connectionId = this.connectionsByAccount.get(message.account);
    if (connectionId === undefined) {
      this.logger.warn("cannot push MapReady: account is offline", {
        account: message.account,
      });
      return;
    }

    const clientMessage: G2C_MapReady = {
      account: message.account,
      mapId: message.mapId,
      unitId: message.unitId,
      x: message.x,
      y: message.y,
    };
    this.sendClient(connectionId, ClientMessages.MapReady, clientMessage);
  }

  @message(GateMessages.ClientBroadcast)
  private clientBroadcast(message: S2G_ClientBroadcast): void {
    const connectionIds: number[] = [];
    for (const unitId of message.targetUnitIds) {
      const connectionId = this.connectionsByUnitId.get(unitId);
      if (connectionId === undefined) continue;
      connectionIds.push(connectionId);
    }
    this.sendClientFrameMany(connectionIds, message.frame);
  }

  @message(GateMessages.KickPlayers)
  private kickPlayers(message: M2G_KickPlayers): void {
    for (const target of message.players) {
      const connectionId = this.connectionsByUnitId.get(target.unitId);
      if (connectionId === undefined) continue;
      const session = this.getSession<GateSession>(connectionId);
      if (
        !session ||
        session.unitId !== target.unitId ||
        session.sessionId !== target.gateSessionId
      ) {
        continue;
      }

      this.connectionsByUnitId.delete(target.unitId);
      this.actorLocations.unbindConnection(connectionId);
      session.mapService = undefined;
      session.mapId = undefined;
      session.unitId = undefined;
      session.actorInstanceId = undefined;
      this.disconnecting.add(connectionId);
      this.logger.info("map requested client disconnect", {
        connectionId,
        reason: message.reason,
      });
      this.disconnectClient(connectionId);
    }
  }

  /** 使用当前 Gate Session 进入地图并绑定 Unit ActorLocation。 / Enters a map with the current Gate Session and binds the Unit ActorLocation. */
  async EnterMap(
    session: GateSession,
    request: C2G_EnterMap,
  ): Promise<G2C_EnterMap> {
    if (!session.IsAuthenticated) {
      throw new RpcError(GameErrCode.GateSessionRequired, "please login gate first");
    }
    const connectionId = session.ConnectionId;

    const mapId = request.mapId || 1;
    const mapHostScene = this.selectMapHostScene(mapId);
    const mapResponse = await this.scenes.call<G2M_EnterMap, M2G_EnterMap>(
      mapHostScene,
      MapProtocol.EnterMap,
      {
        account: session.account,
        token: session.token,
        gateName: this.self.name,
        mapId,
        gateSessionId: session.sessionId,
      },
    );

    if (session.unitId !== undefined) {
      this.connectionsByUnitId.delete(session.unitId);
    }
    session.mapService = mapHostScene.name;
    session.mapId = mapResponse.mapId;
    session.unitId = mapResponse.unitId;
    session.actorInstanceId = mapResponse.actorInstanceId;
    this.connectionsByUnitId.set(mapResponse.unitId, connectionId);
    this.actorLocations.bindConnection(connectionId, {
      instanceId: mapResponse.actorInstanceId,
      scene: mapHostScene,
    });

    await this.writeEnterMapLog(session.account, mapHostScene.name, mapResponse.unitId);

    return {
      account: mapResponse.account,
      mapService: mapHostScene.name,
      mapId: mapResponse.mapId,
      unitId: mapResponse.unitId,
      x: mapResponse.x,
      y: mapResponse.y,
      entities: mapResponse.entities,
      fixedUpdateMs: mapResponse.fixedUpdateMs,
      items: mapResponse.items,
    };
  }

  private selectMapHostScene(mapId: number): SceneConfig {
    return this.mapScenes[(mapId - 1) % this.mapScenes.length];
  }

  private async writeEnterMapLog(
    account: string,
    mapService: string,
    unitId: number,
  ): Promise<void> {
    await this.scenes.callOptionalOne("Log", InnerLogProtocol.Write, {
      message: `[${this.self.name}] ${account} enter ${mapService} as unit ${unitId}`,
    });
  }

  private disconnectInactiveClients(): void {
    const now = TimeSystem.Instance.FrameTime;
    for (const session of this.getSessions<GateSession>()) {
      const connectionId = session.ConnectionId;
      if (
        this.disconnecting.has(connectionId) ||
        now - session.lastActivityAtMs < CLIENT_TIMEOUT_MS
      ) {
        continue;
      }
      this.disconnecting.add(connectionId);
      this.logger.info("disconnecting inactive client", {
        account: session.account,
        connectionId,
        idleMs: Math.floor(now - session.lastActivityAtMs),
      });
      this.disconnectClient(connectionId);
    }
  }

  private async notifyMapPlayerDisconnected(session: GateSession): Promise<void> {
    const message: G2M_PlayerDisconnect = {
      account: session.account,
      mapId: session.mapId!,
      unitId: session.unitId!,
      gateName: this.self.name,
      gateSessionId: session.sessionId,
    };

    try {
      const target = this.scenes.byName(session.mapService!);
      await this.scenes.sendActor(
        {
          scene: target,
          instanceId: session.actorInstanceId!,
        },
        MapMessages.PlayerDisconnect,
        message,
      );
    } catch (error) {
      this.logger.error("failed to notify map scene that unit disconnected", {
        targetScene: session.mapService,
        unitId: message.unitId,
        error,
      });
    }
  }
}
