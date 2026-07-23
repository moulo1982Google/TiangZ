import {
  clientMessageHandler,
  type ClientMessageHandler,
} from "../../../Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../../Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_EntityNumeric } from "../../../Generated/Model/demo/protocol/messages";
import type { MapEntityManager } from "../MapEntityManager";
import { MapMessageScope } from "../MapMessageScope";

@clientMessageHandler(MapMessageScope, ClientMessages.EntityNumeric)
export class G2C_EntityNumericHandler implements ClientMessageHandler<
  MapEntityManager,
  G2C_EntityNumeric
> {
  handle(entities: MapEntityManager, message: G2C_EntityNumeric): void {
    entities.applyNumerics(message.numerics);
  }
}
