import {
  EntryScene,
  entryScene,
  type RuntimeEntrySceneConfig,
  type SceneConfig,
  type SceneMailboxType,
} from "../../../core/public";
import {
  C2S_Login,
  C2S_Register,
  S2C_Login,
  S2C_Register,
} from "../../../generated/model/server/demo/protocol/messages";
import { LoginComponent } from "../login/LoginComponent";
import { CreateCharacterRepository } from "../login/CharacterRepository";

@entryScene()
export class LoginScene extends EntryScene {
  protected override readonly mailbox: SceneMailboxType = "unordered";
  private readonly login: LoginComponent;
  private static readonly ACCOUNT_LOCK = "LoginAccount";

  constructor(config: RuntimeEntrySceneConfig) {
    super(config);
    const gateScenes: SceneConfig[] = this.scenes.many("Gate");
    if (gateScenes.length === 0) {
      throw new Error("LoginScene needs at least one known Gate Scene");
    }
    this.login = this.AddComponent(
      LoginComponent,
      gateScenes,
      config.process.name,
      CreateCharacterRepository(config.process),
    );
  }

  /** 执行登录业务、分配 Gate 并记录结构化日志；账号不会被伪装成 Actor。 / Runs login, assigns a Gate, and records a structured log without manufacturing an account Actor. */
  async Login(request: C2S_Login): Promise<S2C_Login> {
    const response = await this.Locks.RunExclusive(
      LoginScene.ACCOUNT_LOCK,
      request.account.trim(),
      () => this.login.Login(request),
    );
    this.logger.info("player login completed", {
      account: request.account,
      characterId: response.selectedCharacterId,
      gate: response.gateName,
      loginCount: response.loginCount,
    });
    return response;
  }

  /** 注册账号、角色目录和密码摘要；注册成功后客户端再走普通Login。 / Registers the account catalog and digest; the client then performs normal Login. */
  Register(request: C2S_Register): Promise<S2C_Register> {
    return this.Locks.RunExclusive(
      LoginScene.ACCOUNT_LOCK,
      request.account.trim(),
      () => this.login.Register(request),
    );
  }

  /** 先于进入Gate创建角色；创建动作不创建MapUnit。 / Creates a character before Gate entry without creating a Map Unit. */
  CreateCharacter(request: import("../../../generated/model/server/demo/protocol/messages").C2S_CreateCharacter): Promise<import("../../../generated/model/server/demo/protocol/messages").S2C_CreateCharacter> {
    return this.Locks.RunExclusive(
      LoginScene.ACCOUNT_LOCK,
      request.account.trim(),
      () => this.login.CreateCharacter(request),
    );
  }
}
