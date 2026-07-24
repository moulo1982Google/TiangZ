import { ProtocolContext } from "../../core/protocol/registry";
import { message } from "../../core/protocol/message";
import { RpcError } from "../../core/protocol/RpcError";
import { rpc } from "../../core/protocol/rpc";
import { entryScene } from "../../core/process/registry";
import { TimeSystem, TimerSystem } from "../../core/runtime";
import {
  RuntimeEntrySceneConfig,
  EntryScene,
  SceneConfig,
} from "../../core/process/types";
import { GameErrCode } from "../../game/protocol/GameErrCode";
import {
  C2G_EnterMap,
  C2G_LoginGate,
  C2G_Ping,
  G2C_EnterMap,
  G2C_LoginGate,
  G2C_MapReady,
  G2M_EnterMap,
  G2M_PlayerDisconnect,
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
  GateProtocol,
  InnerLogProtocol,
  MapProtocol,
} from "../../generated/model/server/demo/protocol/rpcs";

interface GateSession {
  sessionId: string;
  account: string;
  token: string;
  mapService?: string;
  mapId?: number;
  unitId?: number;
  actorInstanceId?: number;
  lastActivityAtMs: number;
}

const CLIENT_PING_INTERVAL_MS = 5_000;
const CLIENT_TIMEOUT_MS = 30_000;

@entryScene()
export class GateScene extends EntryScene {
  protected override readonly mailbox = "unordered" as const;

  private mapScenes: SceneConfig[] = [];
  private readonly bootId: string;
  private readonly sessions = new Map<number, GateSession>();
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
    const session = this.sessions.get(connectionId);
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
    this.sessions.delete(connectionId);
    if (
      session?.mapService &&
      session.mapId !== undefined &&
      session.unitId !== undefined &&
      session.actorInstanceId !== undefined
    ) {
      await this.notifyMapPlayerDisconnected(session);
    }
  }

  @rpc(GateProtocol.LoginGate)
  private loginGate(
    request: C2G_LoginGate,
    context: ProtocolContext,
  ): G2C_LoginGate {
    if (!request.account) {
      throw new RpcError(GameErrCode.AccountRequired, "account is required");
    }
    if (!request.token) {
      throw new RpcError(GameErrCode.TokenRequired, "token is required");
    }
    if (context.connectionId === undefined) {
      throw new RpcError(GameErrCode.GateSessionRequired, "gate connection is required");
    }

    const sessionId = `${this.bootId}:${context.connectionId}`;
    this.sessions.set(context.connectionId, {
      sessionId,
      account: request.account,
      token: request.token,
      lastActivityAtMs: TimeSystem.Instance.FrameTime,
    });
    this.actorLocations.unbindConnection(context.connectionId);
    this.connectionsByAccount.set(request.account, context.connectionId);

    return {
      account: request.account,
    };
  }

  @message(GateMessages.Ping)
  private ping(_message: C2G_Ping, context: ProtocolContext): void {
    const connectionId = context.connectionId;
    if (connectionId === undefined) return;
    const session = this.sessions.get(connectionId);
    if (!session) {
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

  @rpc(GateProtocol.EnterMap)
  private async enterMap(
    request: C2G_EnterMap,
    context: ProtocolContext,
  ): Promise<G2C_EnterMap> {
    const session =
      context.connectionId === undefined
        ? undefined
        : this.sessions.get(context.connectionId);
    if (!session) {
      throw new RpcError(GameErrCode.GateSessionRequired, "please login gate first");
    }

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

    if (context.connectionId !== undefined) {
      if (session.unitId !== undefined) {
        this.connectionsByUnitId.delete(session.unitId);
      }
      session.mapService = mapHostScene.name;
      session.mapId = mapResponse.mapId;
      session.unitId = mapResponse.unitId;
      session.actorInstanceId = mapResponse.actorInstanceId;
      this.sessions.set(context.connectionId, session);
      this.connectionsByUnitId.set(mapResponse.unitId, context.connectionId);
      this.actorLocations.bindConnection(context.connectionId, {
        instanceId: mapResponse.actorInstanceId,
        scene: mapHostScene,
      });
    }

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
    for (const [connectionId, session] of this.sessions) {
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
