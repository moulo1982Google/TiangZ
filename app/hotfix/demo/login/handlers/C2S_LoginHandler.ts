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
  /** 登录会等待账号目录与密码校验；LoginScene按账号串行化注册和登录，避免并发写入目录。 / Login awaits catalog and password verification; LoginScene serializes registration and login per account. */
  async handle(
    scene: LoginScene,
    _session: Session,
    request: C2S_Login,
  ): Promise<S2C_Login> {
    return scene.Login(request);
  }
}
