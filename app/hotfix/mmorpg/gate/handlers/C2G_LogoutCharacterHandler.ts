import {
  type C2G_LogoutCharacter,
  type G2C_LogoutCharacter,
  GateProtocol,
  GateScene,
  GateSession,
  sessionRpcHandler,
  type SessionRpcHandler,
} from "#tiangz/model";

@sessionRpcHandler(GateScene, GateProtocol.LogoutCharacter)
export class C2G_LogoutCharacterHandler implements SessionRpcHandler<
  GateScene, GateSession, C2G_LogoutCharacter, G2C_LogoutCharacter
> {
  /** 只转交当前Session身份；保存与路由释放由Gate领域事务负责。 / Forwards the current Session identity; the Gate transaction owns saving and route release. */
  handle(scene: GateScene, session: GateSession, request: C2G_LogoutCharacter): Promise<G2C_LogoutCharacter> {
    return scene.LogoutCharacter(session, request);
  }
}
