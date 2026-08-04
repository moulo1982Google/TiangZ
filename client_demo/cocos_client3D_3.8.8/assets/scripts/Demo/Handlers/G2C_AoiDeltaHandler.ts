import {
  clientMessageHandler,
  type ClientMessageHandler,
} from "../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_AoiDelta } from "../../Generated/SDK/Generated/Model/demo/protocol/messages";
import type { GameBootstrap3D } from "../GameBootstrap3D";
import { MapMessageScope3D } from "../MapMessageScope3D";

@clientMessageHandler(MapMessageScope3D, ClientMessages.AoiDelta)
export class G2C_AoiDeltaHandler implements ClientMessageHandler<GameBootstrap3D, G2C_AoiDelta> {
  handle(world: GameBootstrap3D, message: G2C_AoiDelta): void {
    world.ApplyAoiDelta(message);
  }
}
