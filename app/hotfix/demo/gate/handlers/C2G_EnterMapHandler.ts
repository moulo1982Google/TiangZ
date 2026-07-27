import {
  type C2G_EnterMap,
  GateProtocol,
  GateScene,
  GateSession,
  type G2C_EnterMap,
  sessionRpcHandler,
  type SessionRpcHandler,
} from "#tiangz/model";

@sessionRpcHandler(GateScene, GateProtocol.EnterMap)
export class C2G_EnterMapHandler implements SessionRpcHandler<
  GateScene,
  GateSession,
  C2G_EnterMap,
  G2C_EnterMap
> {
  handle(
    scene: GateScene,
    session: GateSession,
    request: C2G_EnterMap,
  ): Promise<G2C_EnterMap> {
    return scene.EnterMap(session, request);
  }
}
