import {
  clientMessageHandler,
  type ClientMessageHandler,
} from "../../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_EntityEnter } from "../../../Generated/SDK/Generated/Model/demo/protocol/messages";
import type { MapEntityManager } from "../MapEntityManager";
import { MapMessageScope } from "../MapMessageScope";

@clientMessageHandler(MapMessageScope, ClientMessages.EntityEnter)
export class G2C_EntityEnterHandler implements ClientMessageHandler<
  MapEntityManager,
  G2C_EntityEnter
> {
  handle(entities: MapEntityManager, message: G2C_EntityEnter): void {
    entities.enter(message.entity);
  }
}
