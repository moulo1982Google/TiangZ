import { clientMessageHandler, type ClientMessageHandler } from "../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_AoiDelta } from "../../Generated/SDK/Generated/Model/demo/protocol/messages";
import type { MapWorld } from "../MapWorld";
import { MapMessageScope } from "../MapMessageScope";

@clientMessageHandler(MapMessageScope, ClientMessages.AoiDelta)
export class G2C_AoiDeltaHandler implements ClientMessageHandler<MapWorld, G2C_AoiDelta> {
  handle(world: MapWorld, message: G2C_AoiDelta): void {
    for (const entity of message.enters) world.enter(entity);
    for (const unitId of message.leaves) world.leave(unitId);
  }
}
