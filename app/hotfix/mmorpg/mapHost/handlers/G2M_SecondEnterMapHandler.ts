import {
  type G2M_SecondEnterMap,
  MapComponent,
  MapProtocol,
  MapScene,
  type M2G_SecondEnterMap,
  PlayerUnit,
  unitRpcHandler,
  type UnitRpcHandler,
} from "#tiangz/model";

@unitRpcHandler(PlayerUnit, MapProtocol.SecondEnterMap)
export class G2M_SecondEnterMapHandler implements UnitRpcHandler<
  PlayerUnit,
  G2M_SecondEnterMap,
  M2G_SecondEnterMap
> {
  /** 将重连恢复交给Unit所在地图，不创建替代Unit或触发AOI进入。 / Delegates reconnect restoration to the owning map without creating a replacement Unit or AOI entry. */
  handle(unit: PlayerUnit, message: G2M_SecondEnterMap): M2G_SecondEnterMap {
    return unit
      .DomainScene<MapScene>()
      .GetComponent(MapComponent)
      .SecondEnterMap(unit, message);
  }
}
