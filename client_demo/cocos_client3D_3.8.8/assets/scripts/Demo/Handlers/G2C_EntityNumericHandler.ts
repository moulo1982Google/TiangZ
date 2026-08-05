import {
  clientMessageHandler,
  type ClientMessageHandler,
} from "../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_EntityNumeric } from "../../Generated/SDK/Generated/Model/demo/protocol/messages";
import type { GameBootstrap3D } from "../GameBootstrap3D";
import { MapMessageScope3D } from "../MapMessageScope3D";

/** 3D演示独立接收Numeric帧尾变化；表现层只缓存权威值，不自行结算战斗。 / Keeps Numeric frame-end updates separate from the 3D bootstrap; presentation caches authority and never resolves combat. */
@clientMessageHandler(MapMessageScope3D, ClientMessages.EntityNumeric)
export class G2C_EntityNumericHandler implements ClientMessageHandler<GameBootstrap3D, G2C_EntityNumeric> {
  handle(world: GameBootstrap3D, message: G2C_EntityNumeric): void {
    world.ApplyEntityNumeric(message);
  }
}
