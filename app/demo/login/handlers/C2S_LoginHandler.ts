import {
  Session,
  sessionRpcHandler,
  type SessionRpcHandler,
} from "../../../core/public";
import type {
  C2S_Login,
  S2C_Login,
} from "../../../generated/model/server/demo/protocol/messages";
import { LoginProtocol } from "../../../generated/model/server/demo/protocol/rpcs";
import { LoginScene } from "../../scenes/LoginScene";

@sessionRpcHandler(LoginScene, LoginProtocol.Login)
export class C2S_LoginHandler implements SessionRpcHandler<
  LoginScene,
  Session,
  C2S_Login,
  S2C_Login
> {
  /** Session mailbox 保证同一连接串行；账号级并发应由真正的账号业务锁处理。 / The Session mailbox serializes one connection; real account-level concurrency belongs to an account-domain lock. */
  handle(
    scene: LoginScene,
    _session: Session,
    request: C2S_Login,
  ): S2C_Login {
    return scene.Login(request);
  }
}
