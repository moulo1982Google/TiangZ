import {
  MapProtocol,
  PlayerUnit,
  type C2M_ToggleAutoAttack,
  type M2C_ToggleAutoAttack,
  type UnitRpcHandler,
  unitRpcHandler,
} from "#tiangz/model";

/** 只转发平A开关；目标、范围、朝向和读条均由PlayerUnit/地图战斗系统处理。 / Delegates only the toggle; target, range, facing, and swing timing stay in map combat systems. */
@unitRpcHandler(PlayerUnit, MapProtocol.ToggleAutoAttack)
export class C2M_ToggleAutoAttackHandler implements UnitRpcHandler<
  PlayerUnit,
  C2M_ToggleAutoAttack,
  M2C_ToggleAutoAttack
> {
  handle(unit: PlayerUnit, request: C2M_ToggleAutoAttack): M2C_ToggleAutoAttack {
    return unit.ToggleAutoAttack(request.targetUnitId, request.enabled);
  }
}
