import {
  sessionRpcHandler,
  type SessionRpcHandler,
} from "../../../core/public";
import type {
  C2G_EnterMap,
  G2C_EnterMap,
} from "../../../generated/model/server/demo/protocol/messages";
import { GateProtocol } from "../../../generated/model/server/demo/protocol/rpcs";
import { GateScene } from "../../scenes/GateScene";
import { GateSession } from "../GateSession";

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
