import {
  type C2M_ToggleDemoDoor,
  type M2C_ToggleDemoDoor,
  MapComponent,
  MapProtocol,
  PlayerUnit,
  unitRpcHandler,
  type UnitRpcHandler,
} from "#tiangz/model";

const DEMO_DOOR_OBSTACLE_ID = 1;

/** Cocos3D灰盒开关门胶水；稳定ID与几何属于演示业务，TileCache细节留在框架API。 / Cocos3D graybox door glue keeping demo geometry above the TileCache API. */
@unitRpcHandler(PlayerUnit, MapProtocol.ToggleDemoDoor)
export class C2M_ToggleDemoDoorHandler implements UnitRpcHandler<
  PlayerUnit,
  C2M_ToggleDemoDoor,
  M2C_ToggleDemoDoor
> {
  async handle(unit: PlayerUnit, request: C2M_ToggleDemoDoor): Promise<M2C_ToggleDemoDoor> {
    const map = unit.DomainScene().GetComponent(MapComponent);
    const changed = request.closed
      ? map.UpsertNavigationBoxObstacle(DEMO_DOOR_OBSTACLE_ID, {
        center: { x: -12, y: 1.5, z: 0 },
        halfExtents: { x: 4, y: 1.5, z: 1 },
      })
      : map.RemoveNavigationObstacle(DEMO_DOOR_OBSTACLE_ID);
    if (changed) {
      map.SetDemoDoorClosed(request.closed);
      await map.PublishDemoDoorState();
    }
    return { closed: request.closed, changed };
  }
}
