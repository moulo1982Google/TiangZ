import {
  type C2S_Login,
  GameErrCode,
  hotfixFor,
  LoginComponent,
  RpcError,
  type S2C_Login,
} from "#tiangz/model";

/** 登录领域行为属于 Hotfix；状态字段与构造关系仍由稳定 LoginComponent 拥有。 / Login domain behavior belongs to Hotfix while stable LoginComponent owns state and construction. */
@hotfixFor(LoginComponent)
export class LoginComponentHotfix extends LoginComponent {
  /** 完成 Demo 登录、轮询 Gate 并更新账号登录次数。 / Completes Demo login, selects a Gate round-robin, and updates the account login count. */
  override Login(request: C2S_Login): S2C_Login {
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
