import {
  InteractableComponent,
  MapProtocol,
  PlayerUnit,
  type C2M_UseInteractable,
  type M2C_UseInteractable,
  type UnitRpcHandler,
  unitRpcHandler,
} from "#tiangz/model";

/** 客户端协议入口只路由到地图交互边界；奖励与重生规则留在组件中。 / The protocol entry only routes to the map interaction boundary. */
@unitRpcHandler(PlayerUnit, MapProtocol.UseInteractable)
export class C2M_UseInteractableHandler implements UnitRpcHandler<PlayerUnit, C2M_UseInteractable, M2C_UseInteractable> {
  handle(unit: PlayerUnit, request: C2M_UseInteractable): Promise<M2C_UseInteractable> {
    return unit.DomainScene().GetComponent(InteractableComponent).Use(
      unit,
      request.interactableUnitId,
      request.operationId,
    );
  }
}
