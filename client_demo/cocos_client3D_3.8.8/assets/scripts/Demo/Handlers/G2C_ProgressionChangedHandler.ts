import { clientMessageHandler, type ClientMessageHandler } from "../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_ProgressionChanged } from "../../Generated/SDK/Generated/Model/demo/protocol/messages";
import type { GameBootstrap3D } from "../GameBootstrap3D";
import { MapMessageScope3D } from "../MapMessageScope3D";

/** 成长结果只驱动本人HUD和提示，权威累计值仍来自服务端回执/Numeric。 / Progression results drive only self HUD and feedback; authoritative totals remain server-owned. */
@clientMessageHandler(MapMessageScope3D, ClientMessages.ProgressionChanged)
export class G2C_ProgressionChangedHandler implements ClientMessageHandler<GameBootstrap3D, G2C_ProgressionChanged> {
  handle(world: GameBootstrap3D, message: G2C_ProgressionChanged): void {
    world.ApplyProgressionChanged(message);
  }
}
