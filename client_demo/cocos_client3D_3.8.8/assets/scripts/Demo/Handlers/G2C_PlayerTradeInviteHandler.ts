import { clientMessageHandler, type ClientMessageHandler } from "../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_PlayerTradeInvite } from "../../Generated/SDK/Generated/Model/demo/protocol/messages";
import type { GameBootstrap3D } from "../GameBootstrap3D";
import { MapMessageScope3D } from "../MapMessageScope3D";

/** 交易邀请独立进入弹窗，不向场景入口追加socket订阅。 / Routes trade invites to the modal without adding socket subscriptions to the scene entrypoint. */
@clientMessageHandler(MapMessageScope3D, ClientMessages.PlayerTradeInvite)
export class G2C_PlayerTradeInviteHandler implements ClientMessageHandler<GameBootstrap3D, G2C_PlayerTradeInvite> {
  handle(world: GameBootstrap3D, message: G2C_PlayerTradeInvite): void {
    world.ApplyPlayerTradeInvite(message);
  }
}
