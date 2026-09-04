import {
  MapProtocol,
  PlayerUnit,
  type C2M_RevivePlayer,
  type M2C_RevivePlayer,
  type UnitRpcHandler,
  unitRpcHandler,
} from "#tiangz/model";

/** Handler只转交复活意图；复活点、资源和战斗清理由PlayerUnit领域行为统一处理。 / Delegates revive intent only; PlayerUnit owns spawn, resources, and combat cleanup. */
@unitRpcHandler(PlayerUnit, MapProtocol.RevivePlayer)
export class C2M_RevivePlayerHandler implements UnitRpcHandler<
  PlayerUnit,
  C2M_RevivePlayer,
  M2C_RevivePlayer
> {
  handle(unit: PlayerUnit): M2C_RevivePlayer {
    return unit.RevivePlayer();
  }
}
