import {
  type G2M_PlayerDisconnect,
  MapComponent,
  MapMessages,
  MapScene,
  PlayerUnit,
  unitMessageHandler,
  type UnitMessageHandler,
} from "#tiangz/model";

@unitMessageHandler(PlayerUnit, MapMessages.PlayerDisconnect)
export class G2M_PlayerDisconnectHandler implements UnitMessageHandler<
  PlayerUnit,
  G2M_PlayerDisconnect
> {
  /** 将 Gate 断线交给 Unit 的权威 MapComponent，以执行过期 Session 校验。 / Routes a Gate disconnect to the Unit's authoritative MapComponent for stale-session checks. */
  handle(unit: PlayerUnit, message: G2M_PlayerDisconnect): Promise<void> {
    return unit
      .DomainScene<MapScene>()
      .GetComponent(MapComponent)
      .PlayerDisconnect(unit, message);
  }
}
