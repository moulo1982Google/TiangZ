import { clientMessageHandler, type ClientMessageHandler } from "../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_BuffRemoved } from "../../Generated/SDK/Generated/Model/demo/protocol/messages";
import type { MapWorld } from "../MapWorld";
import { MapMessageScope } from "../MapMessageScope";

/** 将Buff移除事件交给地图状态容器。 / Routes a Buff removal event into the map state store. */
@clientMessageHandler(MapMessageScope, ClientMessages.BuffRemoved)
export class G2C_BuffRemovedHandler implements ClientMessageHandler<MapWorld, G2C_BuffRemoved> {
  handle(world: MapWorld, message: G2C_BuffRemoved): void {
    world.applyBuffRemoved(message);
  }
}
