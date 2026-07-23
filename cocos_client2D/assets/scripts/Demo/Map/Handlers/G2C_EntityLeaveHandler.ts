import {
  clientMessageHandler,
  type ClientMessageHandler,
} from "../../../Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../../Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_EntityLeave } from "../../../Generated/Model/demo/protocol/messages";
import type { MapEntityManager } from "../MapEntityManager";
import { MapMessageScope } from "../MapMessageScope";

@clientMessageHandler(MapMessageScope, ClientMessages.EntityLeave)
export class G2C_EntityLeaveHandler implements ClientMessageHandler<
  MapEntityManager,
  G2C_EntityLeave
> {
  handle(entities: MapEntityManager, message: G2C_EntityLeave): void {
    entities.leave(message.unitId);
  }
}
