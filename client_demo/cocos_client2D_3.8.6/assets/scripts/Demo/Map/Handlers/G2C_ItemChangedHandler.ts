import {
  clientMessageHandler,
  type ClientMessageHandler,
} from "../../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_ItemChanged } from "../../../Generated/SDK/Generated/Model/demo/protocol/messages";
import type { MapEntityManager } from "../MapEntityManager";
import { MapMessageScope } from "../MapMessageScope";

@clientMessageHandler(MapMessageScope, ClientMessages.ItemChanged)
export class G2C_ItemChangedHandler implements ClientMessageHandler<
  MapEntityManager,
  G2C_ItemChanged
> {
  handle(entities: MapEntityManager, message: G2C_ItemChanged): void {
    entities.applyItem(message.item);
  }
}
