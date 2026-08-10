import { RpcSocket } from "../Core/Net/RpcSocket";
import {
  type ClientEndpoint,
  endpointWithAddress,
} from "../Core/Net/ClientTransport";
import type {
  G2C_EnterMap,
  G2C_MapReady,
  G2C_SessionReplaced,
  S2C_CreateCharacter,
  S2C_Register,
  S2C_Login,
} from "../Generated/Model/demo/protocol/messages";
import {
  ClientMessages,
} from "../Generated/Model/demo/protocol/messageDescriptors";
import {
  GateClient,
  LoginClient,
  LoginMgrClient,
} from "../Generated/Model/demo/protocol/clients";

/** Gate应用层保活周期；服务端默认30秒无收发才判定离线。 / Gate application heartbeat interval; the server times out after 30 seconds without traffic. */
const GATE_PING_INTERVAL_MS = 5_000;

export interface EnterGameResult {
  login: S2C_Login;
  enterMap: G2C_EnterMap;
  mapReady: G2C_MapReady;
  gateSocket: RpcSocket;
}

export type LoginProgress = (message: string) => void;
export type SessionReplacedHandler = (message: G2C_SessionReplaced) => void;

export interface GatePingSample {
  /** Ping请求的完整往返时间，是地图HUD显示的延迟。 / Full Ping round-trip time displayed by the map HUD. */
  readonly latencyMs: number;
  /** Gate处理Ping时返回的Unix毫秒时间。 / Unix time in milliseconds returned when Gate handled the Ping. */
  readonly serverTimeMs: number;
  /** 服务端时钟相对客户端时钟的估算偏差。 / Estimated server clock offset relative to the client clock. */
  readonly clockOffsetMs: number;
  /** 客户端收到这次Ping响应的本地时间。 / Local time when this Ping response arrived. */
  readonly receivedAtMs: number;
}

export class LoginFlow {
  private readonly sockets = new Set<RpcSocket>();
  private gateSocket?: RpcSocket;
  private gateClient?: GateClient;
  private gatePingTimer?: ReturnType<typeof setInterval>;
  private gatePingInFlight = false;
  private gatePingSample: GatePingSample | null = null;
  private readonly sessionReplacedHandlers = new Set<SessionReplacedHandler>();
  private gateSessionReplacedUnsubscribe?: () => void;

  constructor(private readonly loginMgrEndpoint: ClientEndpoint) {}

  /** 返回最近一次Gate Ping测量；尚未收到响应时为null。 / Returns the latest Gate Ping measurement, or null before the first response. */
  get latestGatePing(): GatePingSample | null {
    return this.gatePingSample;
  }

  /**
   * 监听账号被新连接接管；回调只负责通知上层，UI/场景清理由客户端自行决定。
   * Listens for account takeover; the callback only reports the event, while
   * each client decides how to clear its UI and gameplay state.
   */
  onSessionReplaced(handler: SessionReplacedHandler): () => void {
    this.sessionReplacedHandlers.add(handler);
    return () => this.sessionReplacedHandlers.delete(handler);
  }

  async enterGame(
    account: string,
    password: string,
    mapId: number,
    onProgress: LoginProgress = () => {},
    characterId?: bigint,
  ): Promise<EnterGameResult> {
    this.close();

    onProgress("正在连接 LoginMgr...");
    const manager = this.createSocket(this.loginMgrEndpoint);
    let loginAddress;
    try {
      loginAddress = await new LoginMgrClient(manager).getLoginServiceAddr({ account });
    } finally {
      this.closeSocket(manager);
    }

    onProgress(
      `正在连接 ${loginAddress.name} ${loginAddress.ip}:${loginAddress.port}...`,
    );
    const loginSocket = this.createSocket(
      endpointWithAddress(this.loginMgrEndpoint, loginAddress.ip, loginAddress.port),
    );
    let login;
    try {
      const loginClient = new LoginClient(loginSocket);
      login = await loginClient.login(
        characterId === undefined ? { account, password } : { account, password, characterId },
      );
    } finally {
      this.closeSocket(loginSocket);
    }

    onProgress(
      `正在进入 Gate ${login.gateName} ${login.gateIp}:${login.gatePort}...`,
    );
    const gateSocket = this.createSocket(
      endpointWithAddress(this.loginMgrEndpoint, login.gateIp, login.gatePort),
    );
    const unsubscribeSessionReplaced = gateSocket.on(
      ClientMessages.SessionReplaced,
      (message) => this.notifySessionReplaced(message),
    );
    try {
      const gate = new GateClient(gateSocket);
      await gate.loginGate({
        account: login.account,
        token: login.token,
        characterId: login.selectedCharacterId,
      });
      this.gateSocket = gateSocket;
      this.gateClient = gate;
      this.gateSessionReplacedUnsubscribe = unsubscribeSessionReplaced;
      this.startGatePing();
      const [enterMap, mapReady] = await Promise.all([
        gate.enterMap({ mapId, mapInstanceId: 0n }),
        gateSocket.waitForMessage(ClientMessages.MapReady),
      ]);
      return { login, enterMap, mapReady, gateSocket };
    } catch (error) {
      unsubscribeSessionReplaced();
      if (this.gateSocket === gateSocket) this.close();
      else gateSocket.close();
      throw error;
    }
  }

  /** 注册账号并创建同名初始角色；注册不会建立Gate连接，成功后仍需调用enterGame。 / Registers an account and same-name starter character without opening Gate. */
  async register(account: string, password: string): Promise<S2C_Register> {
    const manager = this.createSocket(this.loginMgrEndpoint);
    let loginAddress;
    try {
      loginAddress = await new LoginMgrClient(manager).getLoginServiceAddr({ account });
    } finally {
      this.closeSocket(manager);
    }

    const loginSocket = this.createSocket(
      endpointWithAddress(this.loginMgrEndpoint, loginAddress.ip, loginAddress.port),
    );
    try {
      return await new LoginClient(loginSocket).register({ account, password });
    } finally {
      this.closeSocket(loginSocket);
    }
  }

  /**
   * 在进入地图前创建角色；服务端只写入Login目录，不会提前创建Map Unit。
   * Creates a character before map entry; the server updates only the Login catalog
   * and does not create a Map Unit prematurely.
   */
  async createCharacter(
    account: string,
    name: string,
    playerConfigId = 1,
  ): Promise<S2C_CreateCharacter> {
    const manager = this.createSocket(this.loginMgrEndpoint);
    let loginAddress;
    try {
      loginAddress = await new LoginMgrClient(manager).getLoginServiceAddr({ account });
    } finally {
      this.closeSocket(manager);
    }

    const loginSocket = this.createSocket(
      endpointWithAddress(this.loginMgrEndpoint, loginAddress.ip, loginAddress.port),
    );
    try {
      return await new LoginClient(loginSocket).createCharacter({
        account,
        name,
        playerConfigId,
      });
    } finally {
      this.closeSocket(loginSocket);
    }
  }

  close(): void {
    this.gateSessionReplacedUnsubscribe?.();
    this.gateSessionReplacedUnsubscribe = undefined;
    if (this.gatePingTimer !== undefined) {
      clearInterval(this.gatePingTimer);
      this.gatePingTimer = undefined;
    }
    for (const socket of this.sockets) socket.close();
    this.sockets.clear();
    this.gateSocket = undefined;
    this.gateClient = undefined;
    this.gatePingInFlight = false;
    this.gatePingSample = null;
  }

  private notifySessionReplaced(message: G2C_SessionReplaced): void {
    for (const handler of [...this.sessionReplacedHandlers]) {
      try {
        handler(message);
      } catch (error) {
        console.error("顶号通知处理失败", error);
      }
    }
  }

  update(maxMessagesPerSocket = 256): number {
    let handled = 0;
    for (const socket of this.sockets) handled += socket.update(maxMessagesPerSocket);
    return handled;
  }

  private createSocket(endpoint: ClientEndpoint): RpcSocket {
    const socket = new RpcSocket(endpoint, {
      onUnhandledMessage: (msgcode) => console.warn(`未处理的服务端消息：msgcode=${msgcode}`),
      onHandlerError: (msgcode, error) => console.error(`客户端消息处理失败：msgcode=${msgcode}`, error),
    });
    this.sockets.add(socket);
    return socket;
  }

  private closeSocket(socket: RpcSocket): void {
    socket.close();
    this.sockets.delete(socket);
  }

  private startGatePing(): void {
    if (this.gatePingTimer !== undefined) clearInterval(this.gatePingTimer);
    void this.measureGatePing();
    this.gatePingTimer = setInterval(() => void this.measureGatePing(), GATE_PING_INTERVAL_MS);
  }

  /** 用本地发送/接收时间计算RTT，并利用服务端时间戳估算双方时钟偏差。 / Calculates RTT from local send/receive times and estimates clock offset from the server timestamp. */
  private async measureGatePing(): Promise<void> {
    const socket = this.gateSocket;
    const gate = this.gateClient;
    if (!socket || !gate || this.gatePingInFlight) return;
    this.gatePingInFlight = true;
    const sentAtMs = Date.now();
    try {
      const response = await gate.ping({});
      const receivedAtMs = Date.now();
      const serverTimeMs = Number(response.serverTime);
      if (!Number.isSafeInteger(serverTimeMs)) {
        throw new Error(`Gate返回的服务器时间无法安全转换为number：${response.serverTime}`);
      }
      this.gatePingSample = {
        latencyMs: Math.max(0, receivedAtMs - sentAtMs),
        serverTimeMs,
        clockOffsetMs: Math.round(serverTimeMs - (sentAtMs + receivedAtMs) / 2),
        receivedAtMs,
      };
    } catch (error) {
      console.error("发送 Gate Ping 失败", error);
      if (this.gateSocket === socket) this.close();
    } finally {
      if (this.gateSocket === socket) this.gatePingInFlight = false;
    }
  }
}
