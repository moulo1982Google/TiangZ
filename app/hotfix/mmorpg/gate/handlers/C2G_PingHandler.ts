import {
  type C2G_Ping,
  GateProtocol,
  GateScene,
  GateSession,
  type G2C_Ping,
  sessionRpcHandler,
  type SessionRpcHandler,
} from "#tiangz/model";

/** Gate保活RPC由TS处理并返回服务器墙钟；存活时间已在网络收包入口刷新。 / Handles the Gate heartbeat in TS and returns server wall time; liveness is refreshed at frame ingress. */
@sessionRpcHandler(GateScene, GateProtocol.Ping)
export class C2G_PingHandler implements SessionRpcHandler<
  GateScene,
  GateSession,
  C2G_Ping,
  G2C_Ping
> {
  handle(scene: GateScene, session: GateSession): G2C_Ping {
    return scene.Ping(session);
  }
}
