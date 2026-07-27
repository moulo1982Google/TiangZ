import {
  type C2S_Login,
  LoginProtocol,
  LoginScene,
  type S2C_Login,
  Session,
  sessionRpcHandler,
  type SessionRpcHandler,
} from "#tiangz/model";

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
