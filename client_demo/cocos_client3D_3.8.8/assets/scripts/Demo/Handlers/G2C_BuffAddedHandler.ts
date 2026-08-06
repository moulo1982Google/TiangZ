import {
  clientMessageHandler,
  type ClientMessageHandler,
} from "../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_BuffAdded } from "../../Generated/SDK/Generated/Model/demo/protocol/messages";
import type { GameBootstrap3D } from "../GameBootstrap3D";
import { MapMessageScope3D } from "../MapMessageScope3D";

/** Buff添加事件独立更新Buff栏；倒计时归UI表现，移除仍由服务端事件决定。 / Keeps Buff UI updates isolated; the timer is presentation-only and removal remains server-driven. */
@clientMessageHandler(MapMessageScope3D, ClientMessages.BuffAdded)
export class G2C_BuffAddedHandler implements ClientMessageHandler<GameBootstrap3D, G2C_BuffAdded> {
  handle(world: GameBootstrap3D, message: G2C_BuffAdded): void {
    world.ApplyBuffAdded(message);
  }
}
