import {
  type C2M_UseItem,
  ActionType,
  GameConfigs,
  GameErrCode,
  ItemComponent,
  ItemEvents,
  type M2C_UseItem,
  MapComponent,
  MapProtocol,
  PlayerUnit,
  RpcError,
  SkillComponent,
  SystemErrCode,
  unitRpcHandler,
  type UnitRpcHandler,
} from "#tiangz/model";
import { ActionFromConfig, ExecuteAction } from "../../action/ActionExecutor";

@unitRpcHandler(PlayerUnit, MapProtocol.UseItem)
export class C2M_UseItemHandler implements UnitRpcHandler<
  PlayerUnit,
  C2M_UseItem,
  M2C_UseItem
> {
  /**
   * 校验道具效果、消耗道具、执行Action并发布不可逆的本人背包事件。
   * Item详情不是AOI公开状态，因此Handler不查询ObserversOf；若道具触发公开外观，应由对应领域方法另发AOI事件。
   *
   * Validates an item effect, consumes the item, executes its Action, and
   * publishes an irreversible private inventory event. Item details are not
   * AOI-visible; public visuals belong to a separate domain event using an
   * explicit AOI audience.
   */
  async handle(unit: PlayerUnit, request: C2M_UseItem): Promise<M2C_UseItem> {
    const inventory = unit.GetComponent(ItemComponent);
    const current = inventory.GetItem(request.itemId);
    if (!current) throw new RpcError(GameErrCode.ItemNotFound, `item not found: ${request.itemId}`);
    if (current.count <= 0) throw new RpcError(GameErrCode.ItemNotEnough, `item ${request.itemId} is empty`);
    const itemConfig = GameConfigs.ItemConfig.Get(current.configId);
    const vetoReason = unit.DomainScene().Events.Check(ItemEvents.BeforeUse, {
      unit,
      item: current,
      config: itemConfig,
    });
    if (vetoReason !== SystemErrCode.Success) {
      throw new RpcError(vetoReason, `item use vetoed: ${current.configId}`);
    }
    const cooldown = unit.GetComponent(SkillComponent).TryCommitItemCooldown(
      itemConfig.id,
      itemConfig.cooldownMs,
      itemConfig.globalCooldownMs,
    );
    if (!cooldown.accepted) {
      throw new RpcError(GameErrCode.ItemCooldown, `item ${itemConfig.id} ready at ${cooldown.readyAtMs}`);
    }
    const action = itemConfig.useEffect === 1
      ? ActionFromConfig(ActionType.AddBuff, itemConfig.useParams)
      : ActionFromConfig(itemConfig.useParams[0], itemConfig.useParams.slice(1));
    const item = inventory.UseItem(request.itemId);
    // 道具只声明Action；治疗、Buff和Numeric修改由统一执行器路由到对应组件。
    // Items declare Actions only; the executor routes healing, Buff, and Numeric changes to their components.
    const execution = ExecuteAction(unit, action, { reason: "item-use" });
    await unit.DomainScene().GetComponent(MapComponent).PublishItemChanged(unit, item);
    const response = {
      item,
      globalCooldownEndAtMs: BigInt(Math.max(0, Math.floor(cooldown.globalCooldownEndAtMs))),
      itemCooldownEndAtMs: BigInt(Math.max(0, Math.floor(cooldown.itemCooldownEndAtMs))),
    };
    return execution.addedBuff ? { ...response, buff: execution.addedBuff } : response;
  }
}
