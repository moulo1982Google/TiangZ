import {
  type C2M_UseItem,
  GameConfigs,
  ItemComponent,
  type M2C_UseItem,
  MapComponent,
  MapProtocol,
  NumericComponent,
  NumericType,
  PlayerUnit,
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
    const itemConfig = GameConfigs.ItemConfig.Get(item.configId);
    const numeric = unit.GetComponent(NumericComponent);
    numeric[NumericType.CurrentHp] = Math.min(
      numeric[NumericType.MaxHp],
      numeric[NumericType.CurrentHp] + itemConfig.restoreHp,
    );
    await unit.DomainScene().GetComponent(MapComponent).PublishItemChanged(unit, item);
    return { item };
  }
}
