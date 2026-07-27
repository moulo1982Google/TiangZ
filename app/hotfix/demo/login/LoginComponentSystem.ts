import {
  type C2S_Login,
  GameErrCode,
  LoginComponent,
  RpcError,
  type S2C_Login,
  type SceneConfig,
  systemFor,
} from "#tiangz/model";

/** 承载登录组件的可热更生命周期与业务流程；稳定字段仍由 Model 持有。 / Hosts hot-reloadable login lifecycle and workflow while Model retains stable fields. */
@systemFor(LoginComponent)
export class LoginComponentSystem extends LoginComponent {
  /** 绑定可用 Gate 列表与当前 Process 身份；空列表会阻止 Scene 启动。 / Binds available Gates and Process identity; an empty list prevents Scene startup. */
  protected override Awake(gateScenes: readonly SceneConfig[], processId: string): void {
    if (gateScenes.length === 0) throw new Error("LoginComponent needs at least one Gate Scene");
    this.gateScenes = gateScenes;
    this.processId = processId;
  }

  /** 完成 Demo 登录、轮询 Gate 并更新账号登录次数。 / Completes Demo login, selects a Gate round-robin, and updates the account login count. */
  Login(request: C2S_Login): S2C_Login {
    const account = request.account;
    if (!account) throw new RpcError(GameErrCode.AccountRequired, "account is required");

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
