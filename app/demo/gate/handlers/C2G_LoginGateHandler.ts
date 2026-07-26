import {
  sessionRpcHandler,
  type SessionRpcHandler,
} from "../../../core/public";
import type {
  C2G_LoginGate,
  G2C_LoginGate,
} from "../../../generated/model/server/demo/protocol/messages";
import { GateProtocol } from "../../../generated/model/server/demo/protocol/rpcs";
import { GateScene } from "../../scenes/GateScene";
import { GateSession } from "../GateSession";

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
  ): G2C_LoginGate {
    return scene.LoginGate(session, request);
  }
}
