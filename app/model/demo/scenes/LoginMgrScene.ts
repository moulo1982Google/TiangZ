import {
  EntryScene,
  entryScene,
  rpc,
  type RuntimeEntrySceneConfig,
  type SceneConfig,
} from "../../../core/public";
import {
  C2S_GetLoginServiceAddr,
  S2C_GetLoginServiceAddr,
} from "../../../generated/model/server/demo/protocol/messages";
import { LoginMgrProtocol } from "../../../generated/model/server/demo/protocol/rpcs";
import { SelectStickyScene } from "../login/GateSelector";

@entryScene()
export class LoginMgrScene extends EntryScene {
  private readonly loginScenes: SceneConfig[];
  private next = 0;

  constructor(config: RuntimeEntrySceneConfig) {
    super(config);
    this.loginScenes = this.scenes.many("Login");
    if (this.loginScenes.length === 0) {
      throw new Error("LoginMgrScene needs at least one known LoginScene");
    }
  }

  override startupMessage(): string {
    const names = this.loginScenes.map((scene) => scene.name).join(", ");
    return `${super.startupMessage()} with login scenes: ${names}`;
  }

  @rpc(LoginMgrProtocol.GetLoginServiceAddr)
  private getLoginServiceAddr(
    request: C2S_GetLoginServiceAddr,
  ): S2C_GetLoginServiceAddr {
    // 有账号时固定到同一个Login，使创建角色、登录和选角不会因轮询分裂内存目录。
    // With an account, keep all Login operations on one node so an in-memory
    // catalog cannot split between create, login, and character selection.
    const account = request.account?.trim();
    const selected = account
      ? SelectStickyScene(account, this.loginScenes, "Login")
      : this.loginScenes[this.next++ % this.loginScenes.length];

    return {
      name: selected.name,
      ip: selected.outerIp ?? selected.innerIp,
      port: selected.outerPort ?? selected.port,
    };
  }
}
