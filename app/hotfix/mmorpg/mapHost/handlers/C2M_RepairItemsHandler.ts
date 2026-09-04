import {
  MapProtocol,
  NpcRepairComponent,
  PlayerUnit,
  unitRpcHandler,
  type C2M_RepairItems,
  type M2C_RepairItems,
  type UnitRpcHandler,
} from "#tiangz/model";

@unitRpcHandler(PlayerUnit, MapProtocol.RepairItems)
export class C2M_RepairItemsHandler implements UnitRpcHandler<PlayerUnit, C2M_RepairItems, M2C_RepairItems> {
  handle(unit: PlayerUnit, request: C2M_RepairItems): Promise<M2C_RepairItems> {
    return unit.DomainScene().GetComponent(NpcRepairComponent).Repair(unit, request);
  }
}
