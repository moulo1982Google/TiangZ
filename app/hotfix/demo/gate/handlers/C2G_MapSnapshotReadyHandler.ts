import {
  type C2G_MapSnapshotReady,
  GateProtocol,
  GateScene,
  GateSession,
  type G2C_MapSnapshotReady,
  sessionRpcHandler,
  type SessionRpcHandler,
} from "#tiangz/model";

@sessionRpcHandler(GateScene, GateProtocol.MapSnapshotReady)
export class C2G_MapSnapshotReadyHandler implements SessionRpcHandler<
  GateScene,
  GateSession,
  C2G_MapSnapshotReady,
  G2C_MapSnapshotReady
> {
  /** 客户端地图监听器就绪后，把初始快照请求交给Gate路由。 / Delegates the client-ready acknowledgement to Gate routing. */
  handle(
    scene: GateScene,
    session: GateSession,
    request: C2G_MapSnapshotReady,
  ): Promise<G2C_MapSnapshotReady> {
    return scene.MapSnapshotReady(session, request);
  }
}
