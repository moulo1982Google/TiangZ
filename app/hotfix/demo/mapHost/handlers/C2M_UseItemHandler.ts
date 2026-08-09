import {
  type C2M_UseItem,
  ItemComponent,
  type M2C_UseItem,
  MapProtocol,
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
  /** 把协议参数交给背包领域；Handler不编排DBProxy、Action或Quest。 / Delegates protocol values to Inventory and never orchestrates DBProxy, Actions, or Quests. */
  handle(unit: PlayerUnit, request: C2M_UseItem): Promise<M2C_UseItem> {
    return unit.GetComponent(ItemComponent).UseItemTransactional(
      request.itemId,
      request.operationId,
    );
  }
}
