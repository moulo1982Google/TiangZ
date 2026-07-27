import {
  type C2G_Ping,
  GateMessages,
  GateScene,
  GateSession,
  sessionMessageHandler,
  type SessionMessageHandler,
} from "#tiangz/model";

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
