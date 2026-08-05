import {
  clientMessageHandler,
  type ClientMessageHandler,
} from "../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { ClientMessages } from "../../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type { G2C_AutoAttackState } from "../../Generated/SDK/Generated/Model/demo/protocol/messages";
import type { GameBootstrap3D } from "../GameBootstrap3D";
import { MapMessageScope3D } from "../MapMessageScope3D";

/** 平A状态独立于AOI和位置消息，避免GameBootstrap3D的构造函数注册越来越长。 / Keeps auto-attack state separate from AOI and movement subscriptions. */
@clientMessageHandler(MapMessageScope3D, ClientMessages.AutoAttackState)
export class G2C_AutoAttackStateHandler implements ClientMessageHandler<GameBootstrap3D, G2C_AutoAttackState> {
  handle(world: GameBootstrap3D, message: G2C_AutoAttackState): void {
    world.ApplyAutoAttackState(message);
  }
}
