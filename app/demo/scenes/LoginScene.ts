import {
  EntryScene,
  entryScene,
  type RuntimeEntrySceneConfig,
  type SceneConfig,
  type SceneMailboxType,
} from "../../core/public";
import {
  C2S_Login,
  S2C_Login,
} from "../../generated/model/server/demo/protocol/messages";
import {
  InnerLogProtocol,
} from "../../generated/model/server/demo/protocol/rpcs";
import { LoginComponent } from "../login/LoginComponent";

@entryScene()
export class LoginScene extends EntryScene {
  protected override readonly mailbox: SceneMailboxType = "unordered";
  private readonly login: LoginComponent;

  constructor(config: RuntimeEntrySceneConfig) {
    super(config);
    const gateScenes: SceneConfig[] = this.scenes.many("Gate");
    if (gateScenes.length === 0) {
      throw new Error("LoginScene needs at least one known Gate Scene");
    }
    this.login = this.AddComponent(LoginComponent, gateScenes, config.process.name);
  }

  /** 执行登录业务并在响应前完成 Gate 分配与日志；账号不再被伪装成 Actor。 / Runs login, Gate assignment, and logging without manufacturing an account Actor. */
  async Login(request: C2S_Login): Promise<S2C_Login> {
    const response = this.login.Login(request);
    await this.writeLoginLog(request, response);
    return response;
  }

  private async writeLoginLog(
    request: C2S_Login,
    response: S2C_Login,
  ): Promise<void> {
    await this.scenes.callOptionalOne("Log", InnerLogProtocol.Write, {
      message: `[${this.self.name}] ${request.account} login count ${response.loginCount}`,
    });
  }
}
