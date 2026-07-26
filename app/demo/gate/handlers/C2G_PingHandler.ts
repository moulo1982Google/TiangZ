import {
  sessionMessageHandler,
  type SessionMessageHandler,
} from "../../../core/public";
import type { C2G_Ping } from "../../../generated/model/server/demo/protocol/messages";
import { GateMessages } from "../../../generated/model/server/demo/protocol/messageDescriptors";
import { GateScene } from "../../scenes/GateScene";
import { GateSession } from "../GateSession";

@sessionMessageHandler(GateScene, GateMessages.Ping)
export class C2G_PingHandler implements SessionMessageHandler<
  GateScene,
  GateSession,
  C2G_Ping
> {
  handle(scene: GateScene, session: GateSession): void {
    scene.Ping(session);
  }
}
