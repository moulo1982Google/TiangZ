import {
  MapProtocol,
  PlayerUnit,
  type C2M_AttackMonster,
  type M2C_AttackMonster,
  type UnitRpcHandler,
  unitRpcHandler,
} from "#tiangz/model";

/** 玩家攻击怪物只做一层转发；距离、伤害、死亡和重生由地图怪物模块处理。 / The handler only delegates; the map monster module owns range, damage, death, and respawn. */
@unitRpcHandler(PlayerUnit, MapProtocol.AttackMonster)
export class C2M_AttackMonsterHandler implements UnitRpcHandler<
  PlayerUnit,
  C2M_AttackMonster,
  M2C_AttackMonster
> {
  handle(unit: PlayerUnit, request: C2M_AttackMonster): M2C_AttackMonster {
    return unit.AttackMonster(request.monsterId);
  }
}
