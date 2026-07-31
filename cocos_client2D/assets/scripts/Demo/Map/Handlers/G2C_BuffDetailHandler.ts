import { clientMessageHandler, type ClientMessageHandler } from "../../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_BuffDetail } from "../../../Generated/SDK/Generated/Model/demo/protocol/messages";
import type { MapEntityManager } from "../MapEntityManager";
import { MapMessageScope } from "../MapMessageScope";

/** 将受限Buff详情交给地图状态容器。 / Routes restricted Buff detail into the map state store. */
@clientMessageHandler(MapMessageScope, ClientMessages.BuffDetail)
export class G2C_BuffDetailHandler implements ClientMessageHandler<MapEntityManager, G2C_BuffDetail> {
  handle(entities: MapEntityManager, message: G2C_BuffDetail): void {
    entities.applyBuffDetail(message);
  }
}
