import { RpcSocket } from "../Core/Net/RpcSocket";
import {
  type ClientEndpoint,
  endpointWithAddress,
} from "../Core/Net/ClientTransport";
import type {
  G2C_EnterMap,
  G2C_MapReady,
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

  constructor(private readonly loginMgrEndpoint: ClientEndpoint) {}

  /** 返回最近一次Gate Ping测量；尚未收到响应时为null。 / Returns the latest Gate Ping measurement, or null before the first response. */
  get latestGatePing(): GatePingSample | null {
    return this.gatePingSample;
  }

  async enterGame(
    account: string,
    mapId: number,
    onProgress: LoginProgress = () => {},
  ): Promise<EnterGameResult> {
    this.close();

    onProgress("正在连接 LoginMgr...");
    const manager = this.createSocket(this.loginMgrEndpoint);
    let loginAddress;
    try {
      loginAddress = await new LoginMgrClient(manager).getLoginServiceAddr({});
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
      login = await new LoginClient(loginSocket).login({ account });
    } finally {
      this.closeSocket(loginSocket);
    }

    onProgress(
      `正在进入 Gate ${login.gateName} ${login.gateIp}:${login.gatePort}...`,
    );
    const gateSocket = this.createSocket(
      endpointWithAddress(this.loginMgrEndpoint, login.gateIp, login.gatePort),
    );
    try {
      const gate = new GateClient(gateSocket);
      await gate.loginGate({
        account: login.account,
        token: login.token,
      });
      this.gateSocket = gateSocket;
      this.gateClient = gate;
      this.startGatePing();
      const [enterMap, mapReady] = await Promise.all([
        gate.enterMap({ mapId, mapInstanceId: 0n }),
        gateSocket.waitForMessage(ClientMessages.MapReady),
      ]);
      return { login, enterMap, mapReady, gateSocket };
    } catch (error) {
      if (this.gateSocket === gateSocket) this.close();
      else gateSocket.close();
      throw error;
    }
  }

  close(): void {
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
