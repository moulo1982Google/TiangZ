import {
  actorMessageHandler,
  type ActorMessageHandler,
} from "../../../core/process/actorHandlers";
import type { G2M_PlayerDisconnect } from "../../../generated/model/server/demo/protocol/messages";
import { MapMessages } from "../../../generated/model/server/demo/protocol/messageDescriptors";
import { MapComponent } from "../../map/MapComponent";
import { MapScene } from "../../map/MapScene";
import { PlayerUnit } from "../../map/PlayerUnit";

@actorMessageHandler(PlayerUnit, MapMessages.PlayerDisconnect)
export class G2M_PlayerDisconnectHandler implements ActorMessageHandler<
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
