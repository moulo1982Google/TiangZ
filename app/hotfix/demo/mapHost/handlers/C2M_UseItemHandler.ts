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
  /**
   * 消耗道具、修改权威数值并发布不可逆的本人背包事件。
   * Item详情不是AOI公开状态，因此Handler不查询ObserversOf；若道具触发公开外观，应由对应领域方法另发AOI事件。
   *
   * Consumes an item, mutates authoritative numerics, and publishes an irreversible private
   * inventory event. Item details are not AOI-visible; public visuals belong to a separate domain
   * event using an explicit AOI audience.
   */
  async handle(unit: PlayerUnit, request: C2M_UseItem): Promise<M2C_UseItem> {
    const item = unit.GetComponent(ItemComponent).UseItem(request.itemId);
    const itemConfig = GameConfigs.ItemConfig.Get(item.configId);
    const numeric = unit.GetComponent(NumericComponent);
    const restoredHp = numeric[NumericType.CurrentHp] + BigInt(itemConfig.restoreHp);
    numeric[NumericType.CurrentHp] = restoredHp < numeric[NumericType.MaxHp]
      ? restoredHp
      : numeric[NumericType.MaxHp];
    await unit.DomainScene().GetComponent(MapComponent).PublishItemChanged(unit, item);
    return { item };
  }
}
