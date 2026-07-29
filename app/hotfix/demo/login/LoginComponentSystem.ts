import {
  type C2S_Login,
  GameErrCode,
  LoginComponent,
  RpcError,
  SelectStickyGate,
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
    this.gateScenes = [...gateScenes].sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    this.processId = processId;
  }

  /** 完成Demo登录，并用账号稳定选择Gate；全部Login实例对同一拓扑会得到相同结果。 / Completes Demo login and selects a stable Gate by account across Login instances sharing the same topology. */
  Login(request: C2S_Login): S2C_Login {
    const account = request.account;
    if (!account) throw new RpcError(GameErrCode.AccountRequired, "account is required");

    const loginCount = (this.loginCounts.get(account) ?? 0) + 1;
    this.loginCounts.set(account, loginCount);
    const gate = SelectStickyGate(account, this.gateScenes);

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
