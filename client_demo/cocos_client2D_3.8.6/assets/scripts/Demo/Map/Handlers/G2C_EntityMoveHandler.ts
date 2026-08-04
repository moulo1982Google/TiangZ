import {
  clientMessageHandler,
  type ClientMessageHandler,
} from "../../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_EntityMove } from "../../../Generated/SDK/Generated/Model/demo/protocol/messages";
import type { MapEntityManager } from "../MapEntityManager";
import { MapMessageScope } from "../MapMessageScope";

@clientMessageHandler(MapMessageScope, ClientMessages.EntityMove)
export class G2C_EntityMoveHandler implements ClientMessageHandler<
  MapEntityManager,
  G2C_EntityMove
> {
  handle(entities: MapEntityManager, message: G2C_EntityMove): void {
    entities.applyMovement(message);
  }
}
