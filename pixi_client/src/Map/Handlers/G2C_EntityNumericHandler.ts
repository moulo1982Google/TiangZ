import { clientMessageHandler, type ClientMessageHandler } from "../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_EntityNumeric } from "../../Generated/SDK/Generated/Model/demo/protocol/messages";
import type { MapWorld } from "../MapWorld";
import { MapMessageScope } from "../MapMessageScope";

@clientMessageHandler(MapMessageScope, ClientMessages.EntityNumeric)
export class G2C_EntityNumericHandler implements ClientMessageHandler<MapWorld, G2C_EntityNumeric> {
  handle(world: MapWorld, message: G2C_EntityNumeric): void {
    world.applyNumerics(message.numerics);
  }
}
