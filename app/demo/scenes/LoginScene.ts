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
  LoginProtocol,
} from "../../generated/model/server/demo/protocol/rpcs";
import { LoginActor, LoginActorScene } from "../actors/LoginActor";

@entryScene()
export class LoginScene extends EntryScene {
  protected override readonly mailbox: SceneMailboxType = "unordered";
  private gateScenes: SceneConfig[] = [];
  private nextGate = 0;

  constructor(config: RuntimeEntrySceneConfig) {
    super(config);
    this.gateScenes = this.scenes.many("Gate");
    if (this.gateScenes.length === 0) {
      throw new Error("LoginScene needs at least one known Gate Scene");
    }
  }

  protected override registerHandlers(): void {
    this.processHost.spawnScene(this.loginActorSceneId, LoginActorScene);
    this.registerActorRpc(
      LoginProtocol.Login,
      (request) => this.resolveLoginActor(request.account),
      {
        after: (request, response) => this.afterLogin(request, response),
      },
    );
  }

  private resolveLoginActor(account: string) {
    const actorId = account || "<missing-account>";
    if (!this.processHost.hasActor(this.loginActorSceneId, actorId)) {
      this.processHost.spawnActor(this.loginActorSceneId, actorId, LoginActor);
    }
    return this.processHost.localActorRef(this.loginActorSceneId, actorId);
  }

  private get loginActorSceneId(): string {
    return this.childSceneId("login-actors");
  }

  private async writeLoginLog(
    request: C2S_Login,
    response: S2C_Login,
  ): Promise<void> {
    await this.scenes.callOptionalOne("Log", InnerLogProtocol.Write, {
      message: `[${this.self.name}] ${request.account} login count ${response.loginCount}`,
    });
  }

  private async afterLogin(
    request: C2S_Login,
    response: S2C_Login,
  ): Promise<void> {
    this.attachGate(response);
    await this.writeLoginLog(request, response);
  }

  private attachGate(response: S2C_Login): void {
    const selected = this.gateScenes[this.nextGate % this.gateScenes.length];
    this.nextGate += 1;
    response.gateName = selected.name;
    response.gateIp = selected.ip;
    response.gatePort = selected.port;
  }
}
