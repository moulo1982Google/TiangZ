import { clientMessageHandler, type ClientMessageHandler } from "../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_PlayerTradeChanged } from "../../Generated/SDK/Generated/Model/demo/protocol/messages";
import type { GameBootstrap3D } from "../GameBootstrap3D";
import { MapMessageScope3D } from "../MapMessageScope3D";

/** 报价Push只更新交易窗口，权威库存必须等待交易关闭Push。 / Offer pushes update only the trade window; authoritative inventory waits for the close push. */
@clientMessageHandler(MapMessageScope3D, ClientMessages.PlayerTradeChanged)
export class G2C_PlayerTradeChangedHandler implements ClientMessageHandler<GameBootstrap3D, G2C_PlayerTradeChanged> {
  handle(world: GameBootstrap3D, message: G2C_PlayerTradeChanged): void {
    world.ApplyPlayerTradeChanged(message);
  }
}
