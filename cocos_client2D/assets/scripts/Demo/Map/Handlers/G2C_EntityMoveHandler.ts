import {
  clientMessageHandler,
  type ClientMessageHandler,
} from "../../../Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../../Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_EntityMove } from "../../../Generated/Model/demo/protocol/messages";
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
