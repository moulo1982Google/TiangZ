import {
  MapProtocol,
  PlayerUnit,
  type C2M_CastSkill,
  type M2C_CastSkill,
  type UnitRpcHandler,
  unitRpcHandler,
} from "#tiangz/model";

/** Handler只转交命令；施法校验和效果结算都归SkillComponent/SkillMapComponent。 / The Handler only delegates; Skill components own validation and resolution. */
@unitRpcHandler(PlayerUnit, MapProtocol.CastSkill)
export class C2M_CastSkillHandler implements UnitRpcHandler<
  PlayerUnit,
  C2M_CastSkill,
  M2C_CastSkill
> {
  handle(unit: PlayerUnit, request: C2M_CastSkill): M2C_CastSkill {
    return unit.CastSkill(request.skillId, request.targetUnitId);
  }
}
