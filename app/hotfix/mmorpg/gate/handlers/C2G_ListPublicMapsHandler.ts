import { GateScene, GateSession, GateProtocol, sessionRpcHandler,
  type SessionRpcHandler, type C2G_ListPublicMaps, type G2C_ListPublicMaps } from "#tiangz/model";

@sessionRpcHandler(GateScene, GateProtocol.ListPublicMaps)
export class C2G_ListPublicMapsHandler implements SessionRpcHandler<GateScene, GateSession, C2G_ListPublicMaps, G2C_ListPublicMaps> {
  /** 已登录连接查询可展示的分线目录。 / Lists displayable public channels for an authenticated connection. */
  handle(scene: GateScene, session: GateSession, request: C2G_ListPublicMaps): Promise<G2C_ListPublicMaps> {
    return scene.ListPublicMaps(session, request);
  }
}
