import { clientMessageHandler, type ClientMessageHandler } from "../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_EntityMove } from "../../Generated/SDK/Generated/Model/demo/protocol/messages";
import type { MapWorld } from "../MapWorld";
import { MapMessageScope } from "../MapMessageScope";

@clientMessageHandler(MapMessageScope, ClientMessages.EntityMove)
export class G2C_EntityMoveHandler implements ClientMessageHandler<MapWorld, G2C_EntityMove> {
  handle(world: MapWorld, message: G2C_EntityMove): void {
    world.applyMovement(message);
  }
}
