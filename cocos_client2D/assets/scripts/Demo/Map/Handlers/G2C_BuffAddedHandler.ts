import { clientMessageHandler, type ClientMessageHandler } from "../../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_BuffAdded } from "../../../Generated/SDK/Generated/Model/demo/protocol/messages";
import type { MapEntityManager } from "../MapEntityManager";
import { MapMessageScope } from "../MapMessageScope";

/** 将Buff公开事件交给地图状态容器。 / Routes a public Buff event into the map state store. */
@clientMessageHandler(MapMessageScope, ClientMessages.BuffAdded)
export class G2C_BuffAddedHandler implements ClientMessageHandler<MapEntityManager, G2C_BuffAdded> {
  handle(entities: MapEntityManager, message: G2C_BuffAdded): void {
    entities.applyBuffAdded(message);
  }
}
