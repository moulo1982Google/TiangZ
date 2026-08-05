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
  /** 执行Gate确认后的最终下线事务；保存和Location移除后响应，Actor清理由下一次Timer Update完成。 / Executes Gate-authorized final offline; responds after persistence and Location removal, while Actor cleanup runs in the next timer update. */
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
