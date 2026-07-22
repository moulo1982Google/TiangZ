import { RpcSocket } from "../../Core/Net/RpcSocket";
import {
  type ClientEndpoint,
  endpointWithAddress,
} from "../../Core/Net/ClientTransport";
import type {
  G2C_EnterMap,
  G2C_MapReady,
  S2C_Login,
} from "../../Generated/Model/demo/protocol/messages";
import {
  ClientMessages,
  GateMessages,
} from "../../Generated/Model/demo/protocol/messageDescriptors";
import {
  GateProtocol,
  LoginMgrProtocol,
  LoginProtocol,
} from "../../Generated/Model/demo/protocol/rpcs";

export interface EnterGameResult {
  login: S2C_Login;
  enterMap: G2C_EnterMap;
  mapReady: G2C_MapReady;
  gateSocket: RpcSocket;
}

export type LoginProgress = (message: string) => void;

export class LoginFlow {
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
    const manager = new RpcSocket(this.loginMgrEndpoint);
    let loginAddress;
    try {
      loginAddress = await manager.call(LoginMgrProtocol.GetLoginServiceAddr, {});
    } finally {
      manager.close();
    }

    onProgress(
      `正在连接 ${loginAddress.name} ${loginAddress.ip}:${loginAddress.port}...`,
    );
    const loginSocket = new RpcSocket(
      endpointWithAddress(this.loginMgrEndpoint, loginAddress.ip, loginAddress.port),
    );
    let login;
    try {
      login = await loginSocket.call(LoginProtocol.Login, { account });
    } finally {
      loginSocket.close();
    }

    onProgress(
      `正在进入 Gate ${login.gateName} ${login.gateIp}:${login.gatePort}...`,
    );
    const gateSocket = new RpcSocket(
      endpointWithAddress(this.loginMgrEndpoint, login.gateIp, login.gatePort),
    );
    try {
      await gateSocket.call(GateProtocol.LoginGate, {
        account: login.account,
        token: login.token,
      });
      this.gateSocket = gateSocket;
      this.startGatePing();
      const [enterMap, mapReady] = await Promise.all([
        gateSocket.call(GateProtocol.EnterMap, { mapId }),
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
    this.gateSocket?.close();
    this.gateSocket = undefined;
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
    }, 5_000);
  }
}
