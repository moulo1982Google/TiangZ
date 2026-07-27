import {
  EntryScene,
  entryScene,
  type RuntimeEntrySceneConfig,
  type SceneConfig,
  type SceneMailboxType,
} from "../../../core/public";
import {
  C2S_Login,
  S2C_Login,
} from "../../../generated/model/server/demo/protocol/messages";
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

  /** 执行登录业务、分配 Gate 并记录结构化日志；账号不会被伪装成 Actor。 / Runs login, assigns a Gate, and records a structured log without manufacturing an account Actor. */
  Login(request: C2S_Login): S2C_Login {
    const response = this.login.Login(request);
    this.logger.info("player login completed", {
      account: request.account,
      gate: response.gateName,
      loginCount: response.loginCount,
    });
    return response;
  }
}
