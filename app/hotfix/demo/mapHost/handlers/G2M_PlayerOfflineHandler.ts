import {
  type G2M_PlayerOffline,
  MapComponent,
  MapProtocol,
  MapScene,
  type M2G_PlayerOffline,
  PlayerUnit,
  unitRpcHandler,
  type UnitRpcHandler,
} from "#tiangz/model";

@unitRpcHandler(PlayerUnit, MapProtocol.PlayerOffline)
export class G2M_PlayerOfflineHandler implements UnitRpcHandler<
  PlayerUnit,
  G2M_PlayerOffline,
  M2G_PlayerOffline
> {
  /** 执行Gate确认后的最终下线事务；Map完成保存、移除和AOI广播后才响应。 / Executes Gate-authorized final offline and responds after persistence, removal, and AOI leave broadcast. */
  handle(
    unit: PlayerUnit,
    message: G2M_PlayerOffline,
  ): Promise<M2G_PlayerOffline> {
    return unit
      .DomainScene<MapScene>()
      .GetComponent(MapComponent)
      .PlayerOffline(unit, message);
  }
}
