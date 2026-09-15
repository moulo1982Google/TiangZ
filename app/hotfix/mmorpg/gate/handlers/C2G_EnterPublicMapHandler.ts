import { GateScene, GateSession, GateProtocol, sessionRpcHandler,
  type SessionRpcHandler, type C2G_EnterPublicMap, type G2C_EnterPublicMap } from "#tiangz/model";

@sessionRpcHandler(GateScene, GateProtocol.EnterPublicMap)
export class C2G_EnterPublicMapHandler implements SessionRpcHandler<GateScene, GateSession, C2G_EnterPublicMap, G2C_EnterPublicMap> {
  /** 进入已配置的公共地图，由Gate维护身份与迁移事务。 / Enters a configured public map while Gate owns identity and transfer transactions. */
  handle(scene: GateScene, session: GateSession, request: C2G_EnterPublicMap): Promise<G2C_EnterPublicMap> {
    return scene.EnterPublicMap(session, request);
  }
}
