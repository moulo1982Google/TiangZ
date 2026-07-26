import { Component, RpcError, type SceneConfig } from "../../core/public";
import { GameErrCode } from "../../game/protocol/GameErrCode";
import type {
  C2S_Login,
  S2C_Login,
} from "../../generated/model/server/demo/protocol/messages";

export class LoginComponent extends Component<[readonly SceneConfig[], string]> {
  private gateScenes: readonly SceneConfig[] = [];
  private processId = "";
  private nextGate = 0;
  private readonly loginCounts = new Map<string, number>();

  protected override Awake(gateScenes: readonly SceneConfig[], processId: string): void {
    if (gateScenes.length === 0) throw new Error("LoginComponent needs at least one Gate Scene");
    this.gateScenes = gateScenes;
    this.processId = processId;
  }

  /** 完成无状态 Demo 登录并选择 Gate；真实项目应把账号认证与持久化替换到业务组件。 / Completes stateless demo login and Gate selection; real projects should replace authentication and persistence in business Components. */
  Login(request: C2S_Login): S2C_Login {
    const account = request.account;
    if (!account) {
      throw new RpcError(GameErrCode.AccountRequired, "account is required");
    }

    const loginCount = (this.loginCounts.get(account) ?? 0) + 1;
    this.loginCounts.set(account, loginCount);
    const gate = this.gateScenes[this.nextGate % this.gateScenes.length];
    this.nextGate += 1;

    return {
      account,
      service: this.processId,
      loginCount,
      token: `${this.processId}:${account}:${loginCount}`,
      gateName: gate.name,
      gateIp: gate.ip,
      gatePort: gate.port,
    };
  }
}
