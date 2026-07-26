import {
  unitMessageHandler,
  type UnitMessageHandler,
} from "../../../core/public";
import type { C2M_Move } from "../../../generated/model/server/demo/protocol/messages";
import { MapMessages } from "../../../generated/model/server/demo/protocol/messageDescriptors";
import { PlayerUnit } from "../../map/PlayerUnit";

@unitMessageHandler(PlayerUnit, MapMessages.Move)
export class C2M_MoveHandler implements UnitMessageHandler<
  PlayerUnit,
  C2M_Move
> {
  /** 只写入移动意图；实际移动和可覆盖广播由 MapComponent.Update 负责。 / Applies intent only; MapComponent.Update owns movement and replaceable broadcast. */
  handle(unit: PlayerUnit, message: C2M_Move): void {
    unit.Move(message);
  }
}
