import {
  actorMessageHandler,
  type ActorMessageHandler,
} from "../../../core/process/actorHandlers";
import type { C2M_Move } from "../../../generated/model/server/demo/protocol/messages";
import { MapMessages } from "../../../generated/model/server/demo/protocol/messageDescriptors";
import { PlayerUnit } from "../../map/PlayerUnit";

@actorMessageHandler(PlayerUnit, MapMessages.Move)
export class C2M_MoveHandler implements ActorMessageHandler<
  PlayerUnit,
  C2M_Move
> {
  handle(unit: PlayerUnit, message: C2M_Move): void {
    unit.Move(message);
  }
}
