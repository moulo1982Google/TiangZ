import {
  clientMessageHandler,
  type ClientMessageHandler,
} from "../../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_EntityState } from "../../../Generated/SDK/Generated/Model/demo/protocol/messages";
import type { MapEntityManager } from "../MapEntityManager";
import { MapMessageScope } from "../MapMessageScope";

@clientMessageHandler(MapMessageScope, ClientMessages.EntityState)
export class G2C_EntityStateHandler implements ClientMessageHandler<
  MapEntityManager,
  G2C_EntityState
> {
  handle(entities: MapEntityManager, message: G2C_EntityState): void {
    entities.applyStates(message.states);
  }
}
