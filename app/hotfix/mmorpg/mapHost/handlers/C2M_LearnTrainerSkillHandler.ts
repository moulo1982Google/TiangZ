import {
  MapProtocol,
  PlayerUnit,
  TrainerComponent,
  type C2M_LearnTrainerSkill,
  type M2C_LearnTrainerSkill,
  type UnitRpcHandler,
  unitRpcHandler,
} from "#tiangz/model";

/** 训练师购买在PlayerUnit有序邮箱内运行，并纳入钱包与运行时持久化。 / Trainer purchases run in the ordered PlayerUnit mailbox with wallet and runtime persistence. */
@unitRpcHandler(PlayerUnit, MapProtocol.LearnTrainerSkill)
export class C2M_LearnTrainerSkillHandler implements UnitRpcHandler<
  PlayerUnit,
  C2M_LearnTrainerSkill,
  M2C_LearnTrainerSkill
> {
  handle(
    unit: PlayerUnit,
    request: C2M_LearnTrainerSkill,
  ): Promise<M2C_LearnTrainerSkill> {
    return unit.DomainScene().GetComponent(TrainerComponent).Learn(unit, request);
  }
}
