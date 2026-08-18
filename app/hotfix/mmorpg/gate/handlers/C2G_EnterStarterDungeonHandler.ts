import {
  type C2G_EnterStarterDungeon,
  GateProtocol,
  GateScene,
  GateSession,
  type G2C_EnterStarterDungeon,
  sessionRpcHandler,
  type SessionRpcHandler,
} from "#tiangz/model";

/** 客户端只提交一次业务操作ID；动态实例分配与传送全部留在Gate事务内。 / The client submits only an operation id; allocation and transfer stay inside the Gate transaction. */
@sessionRpcHandler(GateScene, GateProtocol.EnterStarterDungeon)
export class C2G_EnterStarterDungeonHandler implements SessionRpcHandler<
  GateScene,
  GateSession,
  C2G_EnterStarterDungeon,
  G2C_EnterStarterDungeon
> {
  handle(scene: GateScene, session: GateSession, request: C2G_EnterStarterDungeon): Promise<G2C_EnterStarterDungeon> {
    return scene.EnterStarterDungeon(session, request);
  }
}
