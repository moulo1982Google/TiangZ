import {
  type C2G_LoginGate,
  GateProtocol,
  GateScene,
  GateSession,
  type G2C_LoginGate,
  sessionRpcHandler,
  type SessionRpcHandler,
} from "#tiangz/model";

@sessionRpcHandler(GateScene, GateProtocol.LoginGate)
export class C2G_LoginGateHandler implements SessionRpcHandler<
  GateScene,
  GateSession,
  C2G_LoginGate,
  G2C_LoginGate
> {
  handle(
    scene: GateScene,
    session: GateSession,
    request: C2G_LoginGate,
  ): Promise<G2C_LoginGate> {
    return scene.LoginGate(session, request);
  }
}
