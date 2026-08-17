import { clientMessageHandler, type ClientMessageHandler } from "../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_PlayerTradeClosed } from "../../Generated/SDK/Generated/Model/demo/protocol/messages";
import type { GameBootstrap3D } from "../GameBootstrap3D";
import { MapMessageScope3D } from "../MapMessageScope3D";

/** 交易关闭Push负责私有金币和完整背包校正，避免RPC/Push先后顺序造成客户端漂移。 / The close push reconciles private currency and inventory regardless of RPC/push ordering. */
@clientMessageHandler(MapMessageScope3D, ClientMessages.PlayerTradeClosed)
export class G2C_PlayerTradeClosedHandler implements ClientMessageHandler<GameBootstrap3D, G2C_PlayerTradeClosed> {
  handle(world: GameBootstrap3D, message: G2C_PlayerTradeClosed): void {
    world.ApplyPlayerTradeClosed(message);
  }
}
