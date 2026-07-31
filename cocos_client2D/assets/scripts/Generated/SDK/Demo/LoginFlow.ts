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
  GateMessages,
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

export class LoginFlow {
  private readonly sockets = new Set<RpcSocket>();
  private gateSocket?: RpcSocket;
  private gatePingTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly loginMgrEndpoint: ClientEndpoint) {}

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
      this.startGatePing();
      const [enterMap, mapReady] = await Promise.all([
        gate.enterMap({ mapId }),
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
    this.gatePingTimer = setInterval(() => {
      const socket = this.gateSocket;
      if (!socket) return;
      void socket.send(GateMessages.Ping, {}).catch((error) => {
        console.error("发送 Gate Ping 失败", error);
        if (this.gateSocket === socket) this.close();
      });
    }, GATE_PING_INTERVAL_MS);
  }
}
