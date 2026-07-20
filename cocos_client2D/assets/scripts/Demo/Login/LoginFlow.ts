import { RpcSocket } from "../../Core/Net/RpcSocket";
import type {
  G2C_EnterMap,
  G2C_MapReady,
  S2C_Login,
} from "../../Generated/Model/demo/protocol/messages";
import { ClientMessages } from "../../Generated/Model/demo/protocol/messageDescriptors";
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

  constructor(private readonly loginMgrUrl: string) {}

  async enterGame(
    account: string,
    mapId: number,
    onProgress: LoginProgress = () => {},
  ): Promise<EnterGameResult> {
    this.close();

    onProgress("正在连接 LoginMgr...");
    const manager = new RpcSocket(this.loginMgrUrl);
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
      `ws://${loginAddress.ip}:${loginAddress.port}`,
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
    const gateSocket = new RpcSocket(`ws://${login.gateIp}:${login.gatePort}`);
    try {
      await gateSocket.call(GateProtocol.LoginGate, {
        account: login.account,
        token: login.token,
      });
      const [enterMap, mapReady] = await Promise.all([
        gateSocket.call(GateProtocol.EnterMap, { mapId }),
        gateSocket.waitForMessage(ClientMessages.MapReady),
      ]);
      this.gateSocket = gateSocket;
      return { login, enterMap, mapReady, gateSocket };
    } catch (error) {
      gateSocket.close();
      throw error;
    }
  }

  close(): void {
    this.gateSocket?.close();
    this.gateSocket = undefined;
  }
}
