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
    _request: C2S_GetLoginServiceAddr,
  ): S2C_GetLoginServiceAddr {
    const selected = this.loginScenes[this.next % this.loginScenes.length];
    this.next += 1;

    return {
      name: selected.name,
      ip: selected.ip,
      port: selected.port,
    };
  }
}
