import {
  actorRpcHandler,
  type ActorRpcHandler,
} from "../../../core/process/actorHandlers";
import type {
  C2M_UseItem,
  M2C_UseItem,
} from "../../../generated/model/server/demo/protocol/messages";
import { MapProtocol } from "../../../generated/model/server/demo/protocol/rpcs";
import { ItemComponent } from "../../item/ItemComponent";
import { MapComponent } from "../../map/MapComponent";
import { PlayerUnit } from "../../map/PlayerUnit";
import { PositionComponent } from "../../map/PositionComponent";

@actorRpcHandler(PlayerUnit, MapProtocol.UseItem)
export class C2M_UseItemHandler implements ActorRpcHandler<
  PlayerUnit,
  C2M_UseItem,
  M2C_UseItem
> {
  /** Consumes an item, publishes its irreversible event, and returns the authoritative result. */
  async handle(unit: PlayerUnit, request: C2M_UseItem): Promise<M2C_UseItem> {
    const item = unit.GetComponent(ItemComponent).UseItem(request.itemId);
    const position = unit.GetComponent(PositionComponent);
    position.SpeedCellsPerSecond += 1;
    await unit.DomainScene().GetComponent(MapComponent).PublishItemChanged(unit, item);
    return { item };
  }
}
