import {
  clientMessageHandler,
  type ClientMessageHandler,
} from "../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_EntityNavigate } from "../../Generated/SDK/Generated/Model/demo/protocol/messages";
import type { GameBootstrap3D } from "../GameBootstrap3D";
import { MapMessageScope3D } from "../MapMessageScope3D";

@clientMessageHandler(MapMessageScope3D, ClientMessages.EntityNavigate)
export class G2C_EntityNavigateHandler implements ClientMessageHandler<
  GameBootstrap3D,
  G2C_EntityNavigate
> {
  handle(world: GameBootstrap3D, message: G2C_EntityNavigate): void {
    world.ApplyNavigation(message);
  }
}
