import {
  clientMessageHandler,
  type ClientMessageHandler,
} from "../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_ItemChanged } from "../../Generated/SDK/Generated/Model/demo/protocol/messages";
import type { GameBootstrap3D } from "../GameBootstrap3D";
import { MapMessageScope3D } from "../MapMessageScope3D";

/** 背包事件独立刷新快捷栏，避免网络推送继续堆进GameBootstrap3D构造注册逻辑。 / Keeps inventory pushes separate so hotbar state does not become another constructor subscription. */
@clientMessageHandler(MapMessageScope3D, ClientMessages.ItemChanged)
export class G2C_ItemChangedHandler implements ClientMessageHandler<GameBootstrap3D, G2C_ItemChanged> {
  handle(world: GameBootstrap3D, message: G2C_ItemChanged): void {
    world.ApplyItemChanged(message);
  }
}
