import {
  actorMessageHandler,
  type ActorMessageHandler,
} from "../../../core/process/actorHandlers";
import type { G2M_LeaveMap } from "../../../generated/model/server/demo/protocol/messages";
import { MapMessages } from "../../../generated/model/server/demo/protocol/messageDescriptors";
import { MapComponent } from "../../map/MapComponent";
import { MapScene } from "../../map/MapScene";
import { PlayerUnit } from "../../map/PlayerUnit";

@actorMessageHandler(PlayerUnit, MapMessages.LeaveMap)
export class G2M_LeaveMapHandler implements ActorMessageHandler<
  PlayerUnit,
  G2M_LeaveMap
> {
  handle(unit: PlayerUnit, message: G2M_LeaveMap): Promise<void> {
    return unit
      .DomainScene<MapScene>()
      .GetComponent(MapComponent)
      .PlayerLeave(unit, message);
  }
}
