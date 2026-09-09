import {
  MapProtocol,
  PlayerUnit,
  type C2M_CancelSkill,
  type M2C_CancelSkill,
  type UnitRpcHandler,
  unitRpcHandler,
} from "#tiangz/model";

/** 取消请求仍经过玩家所有权路由与有序mailbox。 / Cancellation retains player ownership routing and ordered mailbox execution. */
@unitRpcHandler(PlayerUnit, MapProtocol.CancelSkill)
export class C2M_CancelSkillHandler implements UnitRpcHandler<PlayerUnit, C2M_CancelSkill, M2C_CancelSkill> {
  handle(unit: PlayerUnit, request: C2M_CancelSkill): M2C_CancelSkill {
    return { cancelled: unit.CancelSkill(request.skillId, request.castId) };
  }
}
