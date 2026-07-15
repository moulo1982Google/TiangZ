import {
  actorMessageHandler,
  type ActorMessageHandler,
} from "../../../core/process/actorHandlers";
import type { C2M_Move } from "../../../generated/model/server/demo/protocol/messages";
import { MapMessages } from "../../../generated/model/server/demo/protocol/messageDescriptors";
import { MapComponent } from "../../map/MapComponent";
import { MapScene } from "../../map/MapScene";
import { PlayerUnit } from "../../map/PlayerUnit";

@actorMessageHandler(PlayerUnit, MapMessages.Move)
export class C2M_MoveHandler implements ActorMessageHandler<
  PlayerUnit,
  C2M_Move
> {
  async handle(unit: PlayerUnit, message: C2M_Move): Promise<void> {
    const result = unit.Move(message);
    if (!result.accepted) return;
    await unit
      .DomainScene<MapScene>()
      .GetComponent(MapComponent)
      .PlayerMoved(unit, result.snapshot);
  }
}
