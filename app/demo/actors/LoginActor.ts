import { RpcError } from "../../core/protocol/RpcError";
import { actor, handler, scene } from "../../core/runtime";
import { Actor, Scene } from "../../core/runtime";
import { GameErrCode } from "../../game/protocol/GameErrCode";
import {
  C2S_Login,
  S2C_Login,
} from "../../generated/model/server/demo/protocol/messages";
import { LoginProtocol } from "../../generated/model/server/demo/protocol/rpcs";

@scene({
  sceneType: "LoginActors",
  mailbox: "ordered",
})
export class LoginActorScene extends Scene {}

@actor({
  mailbox: "ordered",
})
export class LoginActor extends Actor {
  private loginCount = 0;

  @handler(LoginProtocol.Login.name)
  private async login(request: C2S_Login): Promise<S2C_Login> {
    await Promise.resolve();

    const account = request.account;
    if (!account) {
      throw new RpcError(GameErrCode.AccountRequired, "account is required");
    }

    this.loginCount += 1;
    this.ctx.logger.info("account login", { account, loginCount: this.loginCount });

    return {
      account,
      service: this.ctx.self.processId,
      loginCount: this.loginCount,
      token: `${this.ctx.self.processId}:${account}:${this.loginCount}`,
      gateName: "",
      gateIp: "",
      gatePort: 0,
    };
  }
}
