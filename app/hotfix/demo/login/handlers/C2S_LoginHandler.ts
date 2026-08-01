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
  /** Login当前为无await的同步事务；未来增加异步账号状态时必须按账号显式加协程锁。 / Login is currently a synchronous transaction without awaits; future asynchronous account state must use an explicit account lock. */
  handle(
    scene: LoginScene,
    _session: Session,
    request: C2S_Login,
  ): S2C_Login {
    return scene.Login(request);
  }
}
