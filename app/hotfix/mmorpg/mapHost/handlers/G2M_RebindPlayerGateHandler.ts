import {
  type G2M_RebindPlayerGate,
  type M2G_RebindPlayerGate,
  MapComponent,
  MapProtocol,
  PlayerUnit,
  unitRpcHandler,
  type UnitRpcHandler,
} from "#tiangz/model";

@unitRpcHandler(PlayerUnit, MapProtocol.RebindPlayerGate)
export class G2M_RebindPlayerGateHandler implements UnitRpcHandler<
  PlayerUnit,
  G2M_RebindPlayerGate,
  M2G_RebindPlayerGate
> {
  /** Gate接管必须进入权威PlayerUnit邮箱，确保与技能、交易和迁移严格有序。 / Gate takeover enters the authoritative PlayerUnit mailbox so it stays ordered with skills, trades, and transfers. */
  handle(
    unit: PlayerUnit,
    request: G2M_RebindPlayerGate,
  ): Promise<M2G_RebindPlayerGate> {
    return unit.DomainScene().GetComponent(MapComponent).RebindPlayerGate(unit, request);
  }
}
