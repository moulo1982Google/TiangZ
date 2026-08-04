import {
  clientMessageHandler,
  type ClientMessageHandler,
} from "../../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_AoiDelta } from "../../../Generated/SDK/Generated/Model/demo/protocol/messages";
import type { MapEntityManager } from "../MapEntityManager";
import { MapMessageScope } from "../MapMessageScope";

@clientMessageHandler(MapMessageScope, ClientMessages.AoiDelta)
export class G2C_AoiDeltaHandler implements ClientMessageHandler<MapEntityManager, G2C_AoiDelta> {
  handle(entities: MapEntityManager, message: G2C_AoiDelta): void {
    for (const entity of message.enters) entities.enter(entity);
    for (const unitId of message.leaves) entities.leave(unitId);
  }
}
