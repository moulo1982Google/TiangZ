import {
  type C2M_UseItem,
  ItemComponent,
  type M2C_UseItem,
  MapComponent,
  MapProtocol,
  PlayerUnit,
  PositionComponent,
  unitRpcHandler,
  type UnitRpcHandler,
} from "#tiangz/model";

@unitRpcHandler(PlayerUnit, MapProtocol.UseItem)
export class C2M_UseItemHandler implements UnitRpcHandler<
  PlayerUnit,
  C2M_UseItem,
  M2C_UseItem
> {
  /** 消耗道具、发布不可逆事件，并返回权威结果。 / Consumes an item, publishes its irreversible event, and returns the authoritative result. */
  async handle(unit: PlayerUnit, request: C2M_UseItem): Promise<M2C_UseItem> {
    const item = unit.GetComponent(ItemComponent).UseItem(request.itemId);
    const position = unit.GetComponent(PositionComponent);
    position.SpeedCellsPerSecond += 1;
    await unit.DomainScene().GetComponent(MapComponent).PublishItemChanged(unit, item);
    return { item };
  }
}
