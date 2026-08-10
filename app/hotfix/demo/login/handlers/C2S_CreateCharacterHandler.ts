import {
  type C2S_CreateCharacter,
  LoginProtocol,
  LoginScene,
  type S2C_CreateCharacter,
  Session,
  sessionRpcHandler,
  type SessionRpcHandler,
} from "#tiangz/model";

@sessionRpcHandler(LoginScene, LoginProtocol.CreateCharacter)
export class C2S_CreateCharacterHandler implements SessionRpcHandler<
  LoginScene,
  Session,
  C2S_CreateCharacter,
  S2C_CreateCharacter
> {
  handle(
    scene: LoginScene,
    _session: Session,
    request: C2S_CreateCharacter,
  ): Promise<S2C_CreateCharacter> {
    return scene.CreateCharacter(request);
  }
}
