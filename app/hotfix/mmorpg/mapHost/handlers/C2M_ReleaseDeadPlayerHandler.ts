import {
  MapProtocol,
  PlayerUnit,
  type C2M_ReleaseDeadPlayer,
  type M2C_ReleaseDeadPlayer,
  type UnitRpcHandler,
  unitRpcHandler,
} from "#tiangz/model";

/** 把通用死亡释放转换委托给权威PlayerUnit邮箱。 / Delegates the generic death-release transition to the authoritative player mailbox. */
@unitRpcHandler(PlayerUnit, MapProtocol.ReleaseDeadPlayer)
export class C2M_ReleaseDeadPlayerHandler implements UnitRpcHandler<
  PlayerUnit,
  C2M_ReleaseDeadPlayer,
  M2C_ReleaseDeadPlayer
> {
  handle(unit: PlayerUnit, request: C2M_ReleaseDeadPlayer): M2C_ReleaseDeadPlayer {
    return unit.ReleaseDeadPlayer(request.hasRecoveryPosition ? {
      recoveryPosition: {
        x: request.recoveryX,
        y: request.recoveryY,
        z: request.recoveryZ,
        yaw: request.recoveryYaw,
      },
    } : undefined);
  }
}
